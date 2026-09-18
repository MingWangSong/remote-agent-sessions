'use strict';

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRecord, event, mergeSessions, uniqueLiteralTmuxName } = require('./model');
const execFileAsync = promisify(execFile);

class GitInspector {
  constructor(runner = execFileAsync) { this.runner = runner; }
  async inspect(cwd) {
    try {
      const [repoRoot, gitBranch] = await Promise.all([
        this.git(cwd, ['rev-parse', '--show-toplevel']),
        this.git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => this.git(cwd, ['rev-parse', '--short', 'HEAD']))
      ]);
      return { repoRoot: repoRoot || null, gitBranch: gitBranch || null };
    } catch { return { repoRoot: null, gitBranch: null }; }
  }
  async git(cwd, args) {
    const result = await this.runner('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
    return String(result.stdout || '').trim();
  }
}

function touch(record, type, message) {
  record.updatedAt = new Date().toISOString();
  record.events = [...(record.events || []), event(type, message)].slice(-500);
}
function find(records, input) {
  const record = records.find((r) => r.id === (input.record?.id || input.id));
  if (!record) throw new Error('Session record no longer exists. Refresh the list.');
  return record;
}
function owns(record, live) {
  return live && (live.owner === record.id || (!record.identityVersion && !live.owner));
}
function sameLiveIdentity(expected, actual) {
  return Boolean(actual && (!expected || (expected.id === actual.id && expected.created === actual.created)));
}
function preserveCommands(windows, previous, byIndex = false) {
  for (const [wi, window] of windows.entries()) {
    const old = byIndex ? previous[wi] : previous.find((w) => w.id ? w.id === window.id : w.name === window.name);
    const oldPanes = old?.panes || (old ? [{ command: old.command }] : []);
    for (const [pi, pane] of window.panes.entries()) {
      const oldPane = byIndex || !oldPanes[0]?.id ? oldPanes[pi] : oldPanes.find((p) => p.id === pane.id);
      pane.command = oldPane?.command || null;
    }
    window.command = window.panes[0]?.command || null;
  }
  return windows;
}

class SessionManager {
  constructor(store, tmux, git = new GitInspector(), directoryChecker = checkDirectory) {
    this.store = store; this.tmux = tmux; this.git = git;
    this.directoryChecker = directoryChecker;
    this.records = []; this.entries = []; this.refreshPromise = null; this.lastError = null;
  }
  async initialize() { return this.refresh(); }
  async refresh(snapshot = true) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(snapshot).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async doRefresh(snapshot) {
    // Keep disk history visible even when tmux is unavailable.
    this.records = await this.store.load();
    let live;
    try { live = await this.tmux.list(); this.lastError = null; }
    catch (error) {
      this.lastError = error;
      this.entries = mergeSessions(this.records, []).map((e) => ({ ...e, status: 'unavailable' }));
      throw error;
    }
    if (snapshot && live.length) {
      await this.store.transaction(async (records) => {
        for (const record of records) {
          // Session ownership survives manual tmux renames.
          const running = live.find((s) => s.owner === record.id) || live.find((s) => s.name === record.tmuxSession);
          if (owns(record, running)) {
            record.tmuxSession = running.name;
            if (!record.identityVersion) {
              await this.tmux.setOwner(record.tmuxSession, record.id);
              record.identityVersion = 1;
              running.owner = record.id;
            }
            await this.snapshotRecord(record);
          }
        }
      });
    }
    this.records = await this.store.load();
    this.entries = mergeSessions(this.records, live);
    return this.entries;
  }
  async snapshotRecord(record) {
    const windows = preserveCommands(await this.tmux.listWindows(record.tmuxSession), record.windows);
    // Persist only actual changes so polling does not continuously rewrite disk.
    if (JSON.stringify(windows) !== JSON.stringify(record.windows)) {
      record.windows = windows;
      record.snapshotAt = new Date().toISOString();
    }
    const git = await this.git.inspect(record.cwd);
    Object.assign(record, git);
  }
  async create(input) {
    if (!input.title?.trim()) throw new Error('A session title is required');
    await this.directoryChecker(input.cwd);
    checkCommand(input.command);
    const record = await this.store.transaction(async (records) => {
      const live = await this.tmux.list();
      const used = new Set([...live.map((s) => s.name), ...records.map((r) => r.tmuxSession)]);
      const preferredName = String(input.tmuxSession || input.title).trim();
      checkTmuxName(preferredName);
      const tmuxSession = uniqueLiteralTmuxName(preferredName, used);
      const record = createRecord({ ...input, title: tmuxSession, tmuxSession,
        ...(await this.git.inspect(input.cwd)), windows: [{
          name: 'agent', cwd: input.cwd, command: input.command || null,
          panes: [{ cwd: input.cwd, command: input.command || null, active: true }]
        }] });
      record.identityVersion = 1;
      records.push(record);
      return structuredClone(record);
    });
    // Durable intent exists before starting any process; a crash leaves a recoverable record.
    await this.restore(record, true);
    await this.refresh();
    return this.records.find((r) => r.id === record.id);
  }
  async adopt(entry, title) {
    const result = await this.store.transaction(async (records) => {
      const existing = records.find((r) => r.tmuxSession === entry.tmuxSession);
      if (existing) return structuredClone(existing);
      const live = (await this.tmux.list()).find((s) => s.name === entry.tmuxSession);
      if (!live) throw new Error('tmux session has disappeared');
      const windows = await this.tmux.listWindows(entry.tmuxSession);
      const cwd = windows[0]?.cwd;
      await this.directoryChecker(cwd);
      const record = createRecord({ title: title || entry.tmuxSession, tmuxSession: entry.tmuxSession,
        cwd, windows, ...(await this.git.inspect(cwd)) });
      record.identityVersion = 1;
      await this.tmux.setOwner(record.tmuxSession, record.id);
      touch(record, 'adopted', 'Existing tmux session saved, including windows and panes');
      records.push(record);
      return structuredClone(record);
    });
    await this.refresh();
    return result;
  }
  async restore(input, executeCommands = false) {
    let createdName;
    let committed = false;
    let commands = [];
    try {
      commands = await this.store.transaction(async (records) => {
        const record = find(records, input);
        const live = (await this.tmux.list()).find((s) => s.name === record.tmuxSession);
        if (live) {
          if (!owns(record, live)) throw new Error('A different tmux session has this name. Rename that tmux session before restoring.');
          return []; // Idempotent: do not restart commands in an existing session.
        }
        const windows = record.windows.length ? record.windows : [{ name: 'agent', cwd: record.cwd }];
        for (const w of windows) {
          for (const p of w.panes?.length ? w.panes : [w]) {
            await this.directoryChecker(p.cwd || w.cwd || record.cwd);
            checkCommand(p.command);
          }
        }
        const firstDirectory = windows[0].panes?.[0]?.cwd || windows[0].cwd || record.cwd;
        let firstPane = await this.tmux.create(record.tmuxSession, firstDirectory, windows[0].name);
        createdName = record.tmuxSession;
        await this.tmux.setOwner(record.tmuxSession, record.id);
        record.identityVersion = 1;
        const plan = [];
        let activePane;
        for (const [wi, w] of windows.entries()) {
          const panes = w.panes?.length ? w.panes : [{ cwd: w.cwd || record.cwd, command: w.command }];
          if (wi > 0) firstPane = await this.tmux.createWindow(record.tmuxSession, { ...w, cwd: panes[0].cwd || w.cwd || record.cwd });
          for (const [pi, p] of panes.entries()) {
            const pane = pi === 0 ? firstPane : await this.tmux.split(firstPane, p.cwd || w.cwd || record.cwd);
            if (p.command && executeCommands) plan.push({ session: record.tmuxSession, pane, command: p.command });
            if (p.active) {
              await this.tmux.select(pane);
              if (w.active) activePane = pane;
            }
          }
          if (w.layout && panes.length > 1) await this.tmux.layout(firstPane, w.layout);
        }
        if (activePane) await this.tmux.select(activePane);
        record.windows = preserveCommands(await this.tmux.listWindows(record.tmuxSession), windows, true);
        record.snapshotAt = new Date().toISOString();
        touch(record, 'restored', executeCommands ? 'Workspace rebuilt; configured commands requested' : 'Workspace rebuilt with shells only');
        return plan;
      });
      committed = true;
    } catch (error) {
      if (createdName && !committed) {
        try { await this.tmux.kill(createdName); }
        catch (cleanup) { throw new Error(error.message + '; rollback failed: ' + cleanup.message); }
      }
      throw error;
    }
    // Start commands only after the complete workspace and its record are durable.
    for (const command of commands) await this.tmux.sendCommand(command.session, command.pane, command.command);
    await this.refresh();
  }
  async terminate(input) {
    await this.store.transaction(async (records) => {
      const record = records.find((r) => r.id === (input.record?.id || input.id));
      const sessions = await this.tmux.list();
      const live = record
        ? sessions.find((session) => session.owner === record.id) || sessions.find((session) => session.name === record.tmuxSession)
        : sessions.find((session) => session.name === input.tmuxSession);
      const name = live?.name || record?.tmuxSession || input.tmuxSession;
      if (record && live && !owns(record, live)) throw new Error('Session identity changed; refusing to terminate a different session.');
      if (!record && live && !sameLiveIdentity(input.live, live)) throw new Error('Session identity changed; refusing to terminate a different session.');
      if (record && live) await this.snapshotRecord(record);
      if (live) await this.tmux.kill(name);
      if (record) touch(record, 'terminated', 'tmux stopped; layout and history retained');
    });
    await this.refresh();
  }
  async edit(input, callback) {
    await this.store.transaction((records) => callback(find(records, input)));
    await this.refresh();
  }
  async markAttached(input) {
    if (!input) return;
    await this.edit(input, (r) => { r.lastAttachedAt = new Date().toISOString(); touch(r, 'attached', 'Opened tmux terminal'); });
  }
  async renameRecord(input, title) {
    if (!title?.trim()) throw new Error('A title is required');
    await this.edit(input, (r) => { r.title = title.trim(); touch(r, 'renamed', 'Title updated'); });
  }
  async renameSession(input, title, tmuxSession) {
    if (!title?.trim()) throw new Error('A title is required');
    checkTmuxName(tmuxSession);
    await this.store.transaction(async (records) => {
      const record = records.find((r) => r.id === (input.record?.id || input.id));
      const live = await this.tmux.list();
      if (!record) {
        const running = live.find((session) => session.name === input.tmuxSession);
        if (!sameLiveIdentity(input.live, running)) throw new Error('Session identity changed; refusing to rename a different session.');
        if (tmuxSession !== running.name && live.some((session) => session.name === tmuxSession)) {
          throw new Error(`A tmux session named ${tmuxSession} already exists.`);
        }
        if (tmuxSession !== running.name) await this.tmux.rename(running.name, tmuxSession);
        return;
      }
      const running = live.find((session) => session.owner === record.id) || live.find((session) => session.name === record.tmuxSession);
      if (running && !owns(record, running)) throw new Error('Session identity changed; refusing to rename a different session.');
      if (records.some((candidate) => candidate.id !== record.id && candidate.tmuxSession === tmuxSession)) {
        throw new Error(`A saved session named ${tmuxSession} already exists.`);
      }
      if (live.some((session) => session.name === tmuxSession && session !== running)) {
        throw new Error(`A tmux session named ${tmuxSession} already exists.`);
      }
      if (running && running.name !== tmuxSession) await this.tmux.rename(running.name, tmuxSession);
      const oldName = record.tmuxSession;
      record.title = title.trim();
      record.tmuxSession = tmuxSession;
      touch(record, 'renamed', oldName === tmuxSession
        ? 'Display title updated'
        : `tmux session renamed from ${oldName} to ${tmuxSession}`);
    });
    await this.refresh();
  }
  async setNote(input, note) { await this.edit(input, (r) => { r.note = note; touch(r, 'note', 'Task note updated'); }); }
  async setCommand(input, wi, pi, command) {
    checkCommand(command);
    await this.edit(input, (r) => {
      const window = r.windows[wi];
      if (!window) throw new Error('Window no longer exists');
      if (!window.panes?.length) window.panes = [{ cwd: window.cwd || r.cwd, command: window.command }];
      if (!window.panes[pi]) throw new Error('Pane no longer exists');
      window.panes[pi].command = command || null;
      if (pi === 0) window.command = command || null;
      touch(r, 'command', 'Restore command updated');
    });
  }
  async forget(input) {
    await this.store.transaction((records) => {
      const r = find(records, input);
      records.splice(records.indexOf(r), 1);
    });
    await this.refresh();
  }
  async deleteSession(input) {
    await this.store.transaction(async (records) => {
      const record = records.find((r) => r.id === (input.record?.id || input.id));
      const sessions = await this.tmux.list();
      const live = record
        ? sessions.find((session) => session.owner === record.id) || sessions.find((session) => session.name === record.tmuxSession)
        : sessions.find((session) => session.name === input.tmuxSession);
      const name = live?.name || record?.tmuxSession || input.tmuxSession;
      if (record && live && !owns(record, live)) throw new Error('Session identity changed; refusing to delete a different session.');
      if (!record && !sameLiveIdentity(input.live, live)) throw new Error('Session identity changed; refusing to delete a different session.');
      if (live) await this.tmux.kill(name);
      if (record) records.splice(records.indexOf(record), 1);
    });
    await this.refresh();
  }
}
async function checkDirectory(cwd) {
  if (typeof cwd !== 'string' || /[\x00\r\n]/.test(cwd) || !(await fs.stat(cwd).catch(() => null))?.isDirectory()) {
    throw new Error('Working directory does not exist: ' + cwd + '. Restore the directory before rebuilding.');
  }
}
function checkCommand(command) {
  if (command != null && (typeof command !== 'string' || /[\x00\r\n]/.test(command))) throw new Error('Use a single-line startup command');
}
function checkTmuxName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[:.\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Use 1–80 characters without dots, colons or control characters');
  }
}

module.exports = { GitInspector, SessionManager, checkTmuxName, preserveCommands, owns, sameLiveIdentity };
