'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function slugify(value, fallback = 'agent') {
  const slug = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return slug || fallback;
}

function uniqueTmuxName(preferred, usedNames) {
  const base = slugify(preferred);
  if (!usedNames.has(base)) return base;
  let index = 2;
  while (usedNames.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function uniqueLiteralTmuxName(preferred, usedNames) {
  const base = String(preferred).trim();
  if (!usedNames.has(base)) return base;
  let index = 2;
  while (usedNames.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function createRecord(input) {
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    id: input.id || newId(),
    title: input.title || input.tmuxSession,
    tmuxSession: input.tmuxSession,
    host: input.host || os.hostname(),
    cwd: input.cwd || os.homedir(),
    repoRoot: input.repoRoot || null,
    gitBranch: input.gitBranch || null,
    agent: input.agent || null,
    windows: Array.isArray(input.windows) ? input.windows : [],
    note: input.note || '',
    archived: false,
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
    lastAttachedAt: input.lastAttachedAt || null,
    events: input.events || [event('created', 'Session record created')]
  };
}

function event(type, message, details) {
  return {
    at: nowIso(),
    type,
    message,
    ...(details ? { details } : {})
  };
}

function mergeSessions(records, liveSessions) {
  const liveByName = new Map(liveSessions.map((session) => [session.name, session]));
  const result = [];

  for (const record of records.filter((item) => !item.archived)) {
    const live = liveByName.get(record.tmuxSession);
    result.push({
      id: record.id,
      record,
      live: live || null,
      managed: true,
      status: live ? ((live.owner === record.id || (!record.identityVersion && !live.owner)) ? 'live' : 'conflict') : 'recoverable',
      title: record.title,
      tmuxSession: record.tmuxSession,
      cwd: record.cwd
    });
    liveByName.delete(record.tmuxSession);
  }

  for (const live of liveByName.values()) {
    result.push({
      id: `tmux:${live.name}`,
      record: null,
      live,
      managed: false,
      status: 'live',
      title: live.name,
      tmuxSession: live.name,
      cwd: null
    });
  }

  return result.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
    const aTime = a.live?.activity || a.record?.updatedAt || '';
    const bTime = b.live?.activity || b.record?.updatedAt || '';
    return String(bTime).localeCompare(String(aTime));
  });
}

function basenameForTitle(cwd) {
  return path.basename(cwd) || 'agent';
}

module.exports = {
  basenameForTitle,
  createRecord,
  event,
  mergeSessions,
  newId,
  nowIso,
  slugify,
  uniqueLiteralTmuxName,
  uniqueTmuxName
};
