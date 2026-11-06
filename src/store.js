'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const lockfile = require('proper-lockfile');
const { validateBinding, builtinAgent } = require('./agentSessions');

function validateRecords(records) {
  if (!Array.isArray(records)) throw new Error('sessions must be an array');
  const ids = new Set();
  const names = new Set();
  for (const r of records) {
    if (!r || typeof r.id !== 'string' || !r.id || typeof r.title !== 'string' ||
        typeof r.tmuxSession !== 'string' || !r.tmuxSession || /[:.\x00-\x1f]/.test(r.tmuxSession) ||
        typeof r.cwd !== 'string' || !path.isAbsolute(r.cwd) || !Array.isArray(r.windows)) {
      throw new Error('Invalid session record; database has not been modified');
    }
    for (const key of ['workspaceRoot','lastCwd']) if (r[key] !== undefined && (typeof r[key] !== 'string' || !r[key].startsWith('/') || /[\x00\r\n]/.test(r[key]))) throw new Error('Invalid workspace directory');
    if (ids.has(r.id) || names.has(r.tmuxSession)) throw new Error('Duplicate session in database');
    ids.add(r.id); names.add(r.tmuxSession);
    if (r.events !== undefined && !Array.isArray(r.events)) throw new Error('Invalid event history');
    if (r.agent?.recoveryVersion === 1 && !r.agent.manualRestore) {
      if (r.agent.sessionId) validateBinding(r.agent);
      else if (!builtinAgent(r.agent.type) || r.agent.launchState !== 'pending') throw new Error('Invalid pending Agent binding');
    }
    for (const w of r.windows) {
      if (!w || typeof w.name !== 'string' || !Array.isArray(w.panes || [])) throw new Error('Invalid window');
      for (const p of [w, ...(w.panes || [])]) {
        if (p.cwd && (typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd) || /[\x00\r\n]/.test(p.cwd))) throw new Error('Invalid pane directory');
        if (p.command != null && (typeof p.command !== 'string' || /[\x00\r\n]/.test(p.command))) throw new Error('Startup commands must be single-line strings');
        if (p.agent) validateBinding(p.agent);
      }
    }
  }
  return records;
}

class SessionStore {
  constructor(filePath) { this.filePath = filePath; }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (data.schemaVersion !== 1) throw new Error('Unsupported session database format');
      return validateRecords(data.sessions);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Unable to read session database ' + this.filePath + ': ' + error.message +
        '. Previous version: ' + this.filePath + '.bak');
    }
  }

  // Lock covers read, mutate, and commit across all VS Code extension hosts.
  async transaction(callback) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let compromised;
    const release = await lockfile.lock(this.filePath, {
      realpath: false, stale: 30000, update: 5000,
      retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: (error) => { compromised = error; }
    });
    try {
      const records = await this.load();
      const before = JSON.stringify(records);
      const result = await callback(records);
      if (compromised) throw compromised;
      validateRecords(records);
      if (JSON.stringify(records) !== before) await this.write(records);
      return result;
    } finally { await release(); }
  }

  async write(records) {
    const temporaryPath = this.filePath + '.' + crypto.randomUUID() + '.tmp';
    try {
      const data = JSON.stringify({ schemaVersion: 1, sessions: records }, null, 2) + '\n';
      const handle = await fs.open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      try { await fs.copyFile(this.filePath, this.filePath + '.bak'); await fs.chmod(this.filePath + '.bak', 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(temporaryPath, this.filePath);
      const directory = await fs.open(path.dirname(this.filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await fs.rm(temporaryPath, { force: true }); }
  }

  async save(records) {
    const snapshot = structuredClone(validateRecords(records));
    await this.transaction((current) => current.splice(0, current.length, ...snapshot));
  }
}

module.exports = { SessionStore, validateRecords };
