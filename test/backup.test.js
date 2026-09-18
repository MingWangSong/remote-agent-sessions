'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBackup, mergeRecords } = require('../src/backup');

function record(id, tmuxSession) {
  return { id, title: tmuxSession, tmuxSession, cwd: '/srv/app', windows: [] };
}

test('backup: schema 2 is validated and cloned', () => {
  const source = {
    schemaVersion: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    hosts: [{ host: { id: 'host-1', label: 'Dev', sshHost: 'dev', tmuxPath: 'tmux' }, sessions: [record('a', 'agent-a')] }]
  };
  const parsed = parseBackup(source);
  assert.equal(parsed.hosts[0].host.socketName, '');
  source.hosts[0].sessions[0].title = 'changed';
  assert.equal(parsed.hosts[0].sessions[0].title, 'agent-a');
});

test('backup: rejects malformed and duplicate hosts', () => {
  assert.throws(() => parseBackup({ schemaVersion: 1, hosts: [] }), /Unsupported backup format/);
  assert.throws(() => parseBackup({ schemaVersion: 2, hosts: [
    { host: { id: 'a', sshHost: 'dev' }, sessions: [] },
    { host: { id: 'b', sshHost: 'dev' }, sessions: [] }
  ] }), /Duplicate host/);
});

test('backup: merge preserves existing records and rewrites host ownership', () => {
  const current = [record('existing', 'agent-a')];
  const result = mergeRecords(current, [record('duplicate-name', 'agent-a'), record('new', 'agent-b')], 'target-host');
  assert.deepEqual(result, { added: 1, skipped: 1 });
  assert.equal(current.length, 2);
  assert.equal(current[1].host, 'target-host');
});
