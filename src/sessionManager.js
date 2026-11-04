'use strict';

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRecord, event, mergeSessions, uniqueLiteralTmuxName } = require('./model');
const { builtinAgent, needsAgentBinding, agentCommand } = require('./agentSessions');
const execFileAsync = promisify(execFile);

class GitInspector {
  constructor(runner = execFileAsync) { this.runner = runner; }
  async inspect(cwd) {
    try {
      // Fixed script, with the directory passed as an argument: one SSH round trip,
      // including detached/unborn HEAD handling and the non-repository case.
      const script = 'root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 0; ' +
        'branch=$(git -C "$1" symbolic-ref --short -q HEAD 2>/dev/null || git -C "$1" rev-parse --short HEAD 2>/dev/null) || branch=; ' +
        "printf '%s\\000%s' \"$root\" \"$branch\"";
      const result = await this.runner('sh', ['-c', script, 'tmuxdock-git', cwd], { encoding: 'utf8', timeout: 5000 });
      const [repoRoot, gitBranch] = String(result.stdout || '').split('\0');
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
      if (oldPane?.agent) pane.agent = structuredClone(oldPane.agent);
    }
    window.command = window.panes[0]?.command || null;
  }
  return windows;
}

async function mapLimit(items, limit, callback) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await callback(item); }
  }));
}

class SessionManager {
  constructor(store, tmux, git = new GitInspector(), directoryChecker = checkDirectory, agents = null) {
    this.store = store; this.tmux = tmux; this.git = git;
    this.directoryChecker = directoryChecker;
    this.agents = agents;
    this.records = []; this.entries = []; this.refreshPromise = null; this.lastError = null;
    this.refreshGeneration = 0;
    this.liveSessions = [];
  }
  async initialize() { return this.refresh(); }
  async refresh(snapshot = true) {
    // Interactive list checks never wait for a slow background snapshot.
    if (!snapshot) return this.doRefresh(false);
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(snapshot).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async doRefresh(snapshot) {
    const generation = ++this.refreshGeneration;
    // Keep disk history visible even when tmux is unavailable.
    this.records = await this.store.load();
    let live;
    try { live = await this.tmux.list(); }
    catch (error) {
      if (generation === this.refreshGeneration) {
        this.lastError = error;
        this.entries = mergeSessions(this.records, []).map((e) => ({ ...e, status: 'unavailable' }));
      }
      throw error;
    }
    if (generation === this.refreshGeneration) {
      this.liveSessions = live;
      this.lastError = null;
    }
    if (snapshot && live.length) {
      // Do remote I/O outside the database lock so polling cannot block a click.
      const snapshots = new Map();
      const gitByDirectory = new Map();
      await mapLimit(this.records, 3, async source => {
        const running = live.find((s) => s.owner === source.id) || live.find((s) => s.name === source.tmuxSession);
        if (!owns(source, running)) return;
        const copy = structuredClone(source);
        copy.tmuxSession = running.name;
        if (!gitByDirectory.has(copy.cwd)) gitByDirectory.set(copy.cwd, this.git.inspect(copy.cwd));
        await this.snapshotRecord(copy, running.snapshotWindows, gitByDirectory.get(copy.cwd));
        snapshots.set(source.id, { copy, running, previousName: source.tmuxSession,
          updatedAt: source.updatedAt, snapshotAt: source.snapshotAt });
      });
      await this.store.transaction(async (records) => {
        for (const record of records) {
          const captured = snapshots.get(record.id);
          if (!captured || record.tmuxSession !== captured.previousName) continue;
          // Another window may have restored, terminated or edited the record
          // while this request was in flight. Never apply the older snapshot.
          if (record.updatedAt !== captured.updatedAt || record.snapshotAt !== captured.snapshotAt) continue;
          const { copy, running } = captured;
          if (owns(record, running)) {
            record.tmuxSession = running.name;
            if (!record.identityVersion) {
              await this.tmux.setOwner(record.tmuxSession, record.id);
              record.identityVersion = 1;
              running.owner = record.id;
            }
            // Keep notes and commands changed while the remote snapshot was in flight.
            record.windows = preserveCommands(copy.windows, record.windows);
            record.snapshotAt = copy.snapshotAt;
            record.repoRoot = copy.repoRoot;
            record.gitBranch = copy.gitBranch;
          }
        }
      });
    }
    if (generation === this.refreshGeneration) {
      this.records = await this.store.load();
      this.liveSessions = live;
      this.lastError = null;
      this.entries = mergeSessions(this.records, live);
    }
    return this.entries;
  }
  async snapshotRecord(record, capturedWindows, gitResult) {
    const [freshWindows, git] = await Promise.all([
      capturedWindows || this.tmux.listWindows(record.tmuxSession), gitResult || this.git.inspect(record.cwd)
    ]);
    const windows = preserveCommands(freshWindows, record.windows);
    // Persist only actual changes so polling does not continuously rewrite disk.
    if (JSON.stringify(windows) !== JSON.stringify(record.windows)) {
      record.windows = windows;
      record.snapshotAt = new Date().toISOString();
    }
    Object.assign(record, git);
  }
  async create(input) {
    if (!input.title?.trim()) throw new Error('A session title is required');
    checkCommand(input.command);
    const [, git] = await Promise.all([this.directoryChecker(input.cwd), this.git.inspect(input.cwd)]);
    const record = await this.store.transaction(async (records) => {
      const live = await this.tmux.list();
      const used = new Set([...live.map((s) => s.name), ...records.map((r) => r.tmuxSession)]);
      const preferredName = String(input.tmuxSession || input.title).trim();
      checkTmuxName(preferredName);
      const tmuxSession = uniqueLiteralTmuxName(preferredName, used);
      const record = createRecord({ ...input, title: tmuxSession, tmuxSession,
        ...git, windows: [{
          name: 'agent', cwd: input.cwd, command: input.command || null,
          panes: [{ cwd: input.cwd, command: input.command || null, active: true }]
        }] });
      if (builtinAgent(input.agent?.type)) record.agent = { type: input.agent.type, recoveryVersion: 1, launchState: 'pending' };
      record.identityVersion = 1;
      records.push(record);
      return structuredClone(record);
    });
    // Durable intent exists before starting any process; a crash leaves a recoverable record.
    await this.restore(record, true);
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
        cwd, windows, createdAt: live.created, ...(await this.git.inspect(cwd)) });
      record.identityVersion = 1;
      await this.tmux.setOwner(record.tmuxSession, record.id);
      touch(record, 'adopted', 'Existing tmux session saved, including windows and panes');
      records.push(record);
      return structuredClone(record);
    });
    await this.refresh(false);
    return result;
  }
  async restore(input, executeCommands = false) {
    // Resolve and verify conversation identities before starting any replacement
    // tmux process. Legacy records must be explicitly bound, never guessed by --last.
    if (executeCommands) await this.prepareAgentRecovery(input);
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
        const directories = new Set();
        for (const w of windows) {
          for (const p of w.panes?.length ? w.panes : [w]) {
            directories.add(p.cwd || w.cwd || record.cwd);
            checkCommand(p.command);
          }
        }
        await mapLimit([...directories], 3, directory => this.directoryChecker(directory));
        for (const w of windows) {
          for (const p of w.panes?.length ? w.panes : [w]) {
            if (executeCommands && p.agent && p.agent.launchState !== 'new') {
              if (!this.agents) throw new Error('Agent conversation recovery is unavailable for this host');
              await this.agents.verify(p.agent);
            }
          }
        }
        const firstDirectory = windows[0].panes?.[0]?.cwd || windows[0].cwd || record.cwd;
        const singlePane = windows.length === 1 && (windows[0].panes?.length || 1) === 1;
        const firstSavedPane = windows[0].panes?.length ? windows[0].panes[0] : windows[0];
        const willSelectPane = singlePane && windows[0].active && firstSavedPane.active;
        let firstPane = await this.tmux.create(record.tmuxSession, firstDirectory, windows[0].name);
        createdName = record.tmuxSession;
        let initialSnapshot;
        if (singlePane && !willSelectPane && this.tmux.initializeSnapshot) initialSnapshot = await this.tmux.initializeSnapshot(record.tmuxSession, record.id);
        else await this.tmux.setOwner(record.tmuxSession, record.id);
        record.identityVersion = 1;
        const plan = [];
        let activePane;
        for (const [wi, w] of windows.entries()) {
          const panes = w.panes?.length ? w.panes : [{ cwd: w.cwd || record.cwd, command: w.command }];
          if (wi > 0) firstPane = await this.tmux.createWindow(record.tmuxSession, { ...w, cwd: panes[0].cwd || w.cwd || record.cwd });
          for (const [pi, p] of panes.entries()) {
            const pane = pi === 0 ? firstPane : await this.tmux.split(firstPane, p.cwd || w.cwd || record.cwd);
            if (p.command && executeCommands) {
              const command = p.agent ? agentCommand(p.agent, p.agent.launchState === 'new') : p.command;
              plan.push({ session: record.tmuxSession, pane, command });
              if (p.agent) {
                p.agent.launchState = 'started';
                if (record.agent?.sessionId === p.agent.sessionId) record.agent.launchState = 'started';
              }
            }
            if (p.active) {
              // A freshly created first window already has its first pane selected.
              if (wi !== 0 || pi !== 0) await this.tmux.select(pane);
              if (w.active) activePane = pane;
            }
          }
          if (w.layout && panes.length > 1) await this.tmux.layout(firstPane, w.layout);
        }
        if (activePane) await this.tmux.select(activePane);
        record.windows = preserveCommands(initialSnapshot || await this.tmux.listWindows(record.tmuxSession), windows, true);
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
    await this.refresh(false);
  }

  async prepareAgentRecovery(input) {
    let record = find(await this.store.load(), input);
    if (needsAgentBinding(record)) {
      throw new Error('This older record has no Agent conversation ID. Bind the original conversation before restoring, or restore shells only.');
    }
    if (builtinAgent(record.agent?.type) && record.agent.recoveryVersion === 1 && !record.agent.manualRestore && !record.agent.sessionId) {
      if (!this.agents) throw new Error('Agent conversation recovery is unavailable for this host');
      const binding = await this.agents.prepare(record.agent.type, record.title, record.cwd);
      await this.saveAgentBinding(record, binding);
      record = find(await this.store.load(), input);
    }
  }

  async saveAgentBinding(input, binding) {
    await this.store.transaction(records => {
      const record = find(records, input);
      if (!record.windows.length) record.windows = [{ name: 'agent', cwd: record.cwd, panes: [] }];
      const window = record.windows[0];
      if (!window.panes?.length) window.panes = [{ cwd: window.cwd || record.cwd, active: true }];
      record.agent = structuredClone(binding);
      window.panes[0].agent = structuredClone(binding);
      window.panes[0].command = agentCommand(binding);
      window.command = window.panes[0].command;
      touch(record, 'agent-bound', `Bound ${binding.type} conversation ${binding.sessionId}`);
    });
  }

  async bindAgentSession(input, type, sessionId) {
    if (!this.agents) throw new Error('Agent conversation recovery is unavailable for this host');
    const record = find(await this.store.load(), input);
    const binding = await this.agents.bind(type, sessionId, record.title);
    await this.saveAgentBinding(input, binding);
    await this.reloadRecords();
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
      if (record && live) await this.snapshotRecord(record, live.snapshotWindows);
      if (live) await this.tmux.kill(name);
      if (record) touch(record, 'terminated', 'tmux stopped; layout and history retained');
    });
    await this.refresh(false);
  }
  async edit(input, callback) {
    await this.store.transaction((records) => callback(find(records, input)));
    await this.reloadRecords();
  }
  async reloadRecords() {
    const generation = ++this.refreshGeneration;
    const records = await this.store.load();
    if (generation === this.refreshGeneration) {
      this.records = records;
      this.entries = mergeSessions(records, this.lastError ? [] : this.liveSessions);
      if (this.lastError) this.entries = this.entries.map(entry => ({ ...entry, status: 'unavailable' }));
    }
    return this.entries;
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
      if (record.agent?.recoveryVersion === 1 && record.agent.sessionId && !record.agent.manualRestore) {
        const renamed = this.agents ? await this.agents.rename(record.agent, title.trim()) : { ...record.agent, name: title.trim() };
        record.agent = renamed;
        for (const window of record.windows) for (const pane of window.panes || []) {
          if (pane.agent?.sessionId === renamed.sessionId) {
            pane.agent = { ...pane.agent, name: renamed.name };
            pane.command = agentCommand(pane.agent);
          }
        }
      }
      touch(record, 'renamed', oldName === tmuxSession
        ? 'Display title updated'
        : `tmux session renamed from ${oldName} to ${tmuxSession}`);
    });
    await this.refresh(false);
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
      delete window.panes[pi].agent;
      if (wi === 0 && pi === 0 && r.agent) r.agent.manualRestore = true;
      if (pi === 0) window.command = command || null;
      touch(r, 'command', 'Restore command updated');
    });
  }
  async forget(input) {
    await this.store.transaction((records) => {
      const r = find(records, input);
      records.splice(records.indexOf(r), 1);
    });
    await this.reloadRecords();
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
    await this.refresh(false);
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
