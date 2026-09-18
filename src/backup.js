'use strict';

const { normalizeHost } = require('./hostRegistry');
const { validateRecords } = require('./store');

function parseBackup(input) {
  if (!input || input.schemaVersion !== 2 || !Array.isArray(input.hosts)) {
    throw new Error('Unsupported backup format; expected a TmuxDock schemaVersion 2 backup');
  }
  const ids = new Set();
  const targets = new Set();
  const hosts = input.hosts.map((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.host) throw new Error('Invalid host entry in backup');
    const host = normalizeHost(entry.host);
    const target = `${host.sshHost}\0${host.socketName}`;
    if (ids.has(host.id) || targets.has(target)) throw new Error('Duplicate host in backup');
    ids.add(host.id);
    targets.add(target);
    const sessions = structuredClone(validateRecords(entry.sessions));
    return { host, sessions };
  });
  return { schemaVersion: 2, exportedAt: input.exportedAt, hosts };
}

function mergeRecords(current, imported, hostId) {
  validateRecords(current);
  validateRecords(imported);
  let added = 0;
  let skipped = 0;
  for (const source of imported) {
    if (current.some((record) => record.id === source.id || record.tmuxSession === source.tmuxSession)) {
      skipped += 1;
      continue;
    }
    current.push({ ...structuredClone(source), host: hostId });
    added += 1;
  }
  return { added, skipped };
}

module.exports = { parseBackup, mergeRecords };
