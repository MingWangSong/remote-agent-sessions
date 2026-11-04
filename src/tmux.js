'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { remoteCommand } = require('./ssh');
const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = '__RAS_FIELD__';

function parseTmuxList(stdout, separator = FIELD_SEPARATOR) {
  const sessions = new Map();
  const snapshots = new Map();
  for (const [name, created, attached, windows, activity, id, owner, command, activeWindow, activePane,
    windowId, windowName, layout, paneId, cwd] of rows(stdout, separator)) {
    const key = id || name;
    if (!sessions.has(key)) sessions.set(key, {
      name, created: epochToIso(created), attached: Number(attached || 0),
      windows: Number(windows || 0), activity: epochToIso(activity), id, owner: owner || null
    });
    const session = sessions.get(key);
    if (command !== undefined) {
      session.commands ||= [];
      if (!session.commands.includes(command)) session.commands.push(command);
      if (activeWindow === '1' && activePane === '1') session.currentCommand = command;
    }
    if (windowId) {
      if (!snapshots.has(key)) snapshots.set(key, new Map());
      const windows = snapshots.get(key);
      if (!windows.has(windowId)) windows.set(windowId, { id: windowId, name: windowName, layout,
        active: activeWindow === '1', cwd, command: null, panes: [] });
      windows.get(windowId).panes.push({ id: paneId, cwd, currentCommand: command, active: activePane === '1', command: null });
    }
  }
  for (const [key, windows] of snapshots) sessions.get(key).snapshotWindows = [...windows.values()];
  return [...sessions.values()];
}
function rows(stdout, separator) { return stdout.replace(/\n$/, '').split('\n').filter(Boolean).map((line) => line.split(separator)); }
function epochToIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}
function isNoServerError(message) {
  return /no server running|no sessions|connection refused/i.test(message) ||
    (/error connecting to/i.test(message) && /no such file or directory/i.test(message));
}

class TmuxClient {
  constructor(executable = 'tmux', runner = execFileAsync, prefixArgs = []) {
    this.executable = executable; this.runner = runner; this.prefixArgs = prefixArgs;
    // tmux 3.4 escapes control characters in output. Printable nonce also avoids collisions in user names/paths.
    this.separator = '__RAS_' + randomUUID().replace(/-/g, '') + '__';
  }
  async run(args, options = {}) {
    try {
      const env = { ...process.env, LC_MESSAGES: 'C' };
      delete env.TMUX;
      const result = await this.runner(this.executable, ['-u', ...this.prefixArgs, ...args], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, env
      });
      return result.stdout || '';
    } catch (error) {
      const message = String(error.stderr || error.message || '').trim();
      if (options.allowNoServer && isNoServerError(message)) return '';
      throw new Error('tmux ' + args[0] + ' failed: ' + message, { cause: error });
    }
  }
  async runSequence(commands, outputIndex = commands.length - 1) {
    // Keep each original tmux argv intact. Do not use tmux's ';' parser for
    // user-controlled names or commands; quote them as individual POSIX argv.
    const script = commands.map((args, index) => remoteCommand(this.executable, ['-u', ...this.prefixArgs, ...args]) +
      (index !== outputIndex ? ' >/dev/null' : '')).join(' && ');
    const env = { ...process.env, LC_MESSAGES: 'C' }; delete env.TMUX;
    try {
      const result = await this.runner('sh', ['-c', script], {
        encoding: 'utf8', timeout: 15000 * commands.length, maxBuffer: 4 * 1024 * 1024, env
      });
      return result.stdout || '';
    } catch (error) {
      throw new Error('tmux grouped operation failed: ' + String(error.stderr || error.message || '').trim(), { cause: error });
    }
  }
  async list() {
    // Include pane commands for type icons without any additional SSH round trips.
    return parseTmuxList(await this.run(['list-panes', '-a', '-F', [
      '#{session_name}', '#{session_created}', '#{session_attached}', '#{session_windows}',
      '#{session_activity}', '#{session_id}', '#{@ras_id}',
      '#{pane_current_command}', '#{window_active}', '#{pane_active}',
      '#{window_id}', '#{window_name}', '#{window_layout}', '#{pane_id}', '#{pane_current_path}'
    ].join(this.separator)], { allowNoServer: true }), this.separator);
  }
  async exists(name) { return (await this.list()).some((s) => s.name === name); }
  async setOwner(name, id) { await this.run(['set-option', '-t', '=' + name + ':', '@ras_id', id]); }
  async create(name, cwd, windowName = 'agent') {
    const pane = (await this.run(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name, '-n', windowName,
      '-c', cwd, '-x', '160', '-y', '48'])).trim();
    if (!/^%\d+$/.test(pane)) throw new Error('tmux did not return a pane ID; session creation could not be confirmed. Refresh the list.');
    return pane;
  }
  async rename(oldName, newName) { await this.run(['rename-session', '-t', '=' + oldName, newName]); }
  async renameWindow(session, oldName, newName) { await this.run(['rename-window', '-t', '=' + session + ':' + oldName, newName]); }
  async sendCommand(session, pane, command) {
    if (/[\x00\r\n]/.test(command)) throw new Error('Commands must contain a single line');
    const target = pane.startsWith('%') ? pane : '=' + session + ':' + pane;
    await this.runSequence([
      ['send-keys', '-t', target, '-l', '--', command],
      ['send-keys', '-t', target, 'Enter']
    ]);
  }
  async kill(name) { await this.run(['kill-session', '-t', '=' + name]); }
  async listWindows(name) {
    // One remote round trip for every window and pane in the session.
    return this.parseWindows(await this.run(this.windowArgs(name)));
  }
  windowArgs(name) {
    return ['list-panes', '-s', '-t', '=' + name, '-F', [
      '#{window_id}', '#{window_name}', '#{window_layout}', '#{window_active}',
      '#{pane_id}', '#{pane_current_path}', '#{pane_current_command}', '#{pane_active}'
    ].join(this.separator)];
  }
  async initializeSnapshot(name, owner) {
    // Called only after create() has returned, so the manager can roll back the
    // newly created shell if either owner assignment or snapshot capture fails.
    return this.parseWindows(await this.runSequence([
      ['set-option', '-t', '=' + name + ':', '@ras_id', owner], this.windowArgs(name)
    ]));
  }
  parseWindows(output) {
    const windows = new Map();
    for (const [id, windowName, layout, active, paneId, cwd, currentCommand, paneActive] of rows(output, this.separator)) {
      if (!windows.has(id)) windows.set(id, { id, name: windowName, layout, active: active === '1', cwd, command: null, panes: [] });
      windows.get(id).panes.push({ id: paneId, cwd, currentCommand, active: paneActive === '1', command: null });
    }
    return [...windows.values()];
  }
  async createWindow(name, window) {
    return (await this.run(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', '=' + name,
      '-n', window.name || 'shell', '-c', window.cwd])).trim();
  }
  async split(pane, cwd) {
    return (await this.runSequence([
      ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', pane, '-c', cwd],
      ['select-layout', '-t', pane, 'tiled']
    ], 0)).trim();
  }
  async layout(pane, layout) { await this.run(['select-layout', '-t', pane, layout]); }
  async select(pane) {
    await this.runSequence([
      ['select-pane', '-t', pane], ['select-window', '-t', pane]
    ]);
  }
}

module.exports = { FIELD_SEPARATOR, TmuxClient, isNoServerError, parseTmuxList };
