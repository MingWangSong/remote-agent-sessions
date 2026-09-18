'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = '__RAS_FIELD__';

function parseTmuxList(stdout, separator = FIELD_SEPARATOR) {
  return rows(stdout, separator).map(([name, created, attached, windows, activity, id, owner]) => ({
    name, created: epochToIso(created), attached: Number(attached || 0),
    windows: Number(windows || 0), activity: epochToIso(activity), id, owner: owner || null
  }));
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
  async list() {
    return parseTmuxList(await this.run(['list-sessions', '-F', [
      '#{session_name}', '#{session_created}', '#{session_attached}', '#{session_windows}',
      '#{session_activity}', '#{session_id}', '#{@ras_id}'
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
    await this.run(['send-keys', '-t', target, '-l', '--', command]);
    await this.run(['send-keys', '-t', target, 'Enter']);
  }
  async kill(name) { await this.run(['kill-session', '-t', '=' + name]); }
  async listWindows(name) {
    const output = await this.run(['list-windows', '-t', '=' + name, '-F', [
      '#{window_id}', '#{window_name}', '#{window_layout}', '#{window_active}'
    ].join(this.separator)]);
    const windows = [];
    for (const [id, windowName, layout, active] of rows(output, this.separator)) {
      const paneOutput = await this.run(['list-panes', '-t', id, '-F', [
        '#{pane_id}', '#{pane_current_path}', '#{pane_current_command}', '#{pane_active}'
      ].join(this.separator)]);
      const panes = rows(paneOutput, this.separator).map(([paneId, cwd, currentCommand, paneActive]) => ({
        id: paneId, cwd, currentCommand, active: paneActive === '1', command: null
      }));
      windows.push({ id, name: windowName, layout, active: active === '1', cwd: panes[0]?.cwd,
        command: null, panes });
    }
    return windows;
  }
  async createWindow(name, window) {
    return (await this.run(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', '=' + name,
      '-n', window.name || 'shell', '-c', window.cwd])).trim();
  }
  async split(pane, cwd) {
    const result = (await this.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', pane, '-c', cwd])).trim();
    await this.run(['select-layout', '-t', pane, 'tiled']);
    return result;
  }
  async layout(pane, layout) { await this.run(['select-layout', '-t', pane, layout]); }
  async select(pane) {
    await this.run(['select-pane', '-t', pane]);
    await this.run(['select-window', '-t', pane]);
  }
}

module.exports = { FIELD_SEPARATOR, TmuxClient, isNoServerError, parseTmuxList };
