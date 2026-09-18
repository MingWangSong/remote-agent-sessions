'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HostRegistry } = require('../src/hostRegistry');

class MemoryMemento {
  constructor() { this.values = new Map(); }
  get(key, fallback) { return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback; }
  async update(key, value) { this.values.set(key, structuredClone(value)); }
}

test('local host registry adds, deduplicates, updates and removes SSH aliases', async () => {
  const registry = new HostRegistry(new MemoryMemento());
  const first = await registry.add({ sshHost: 'test-host', label: 'Test Host', defaultCwd: '/home/test' });
  const duplicate = await registry.add({ sshHost: 'test-host', label: 'Duplicate' });
  assert.equal(duplicate.id, first.id);
  assert.equal(registry.list().length, 1);
  await registry.update({ ...first, label: 'Primary Dev', tmuxPath: '/usr/bin/tmux', socketName: 'agents' });
  assert.equal(registry.list()[0].label, 'Primary Dev');
  assert.equal(registry.list()[0].socketName, 'agents');
  assert.equal(await registry.remove(first.id), true);
  assert.deepEqual(registry.list(), []);
});

test('local host registry refuses malformed persisted data', () => {
  const memento = new MemoryMemento();
  memento.values.set('remoteAgentSessions.hosts.v2', [{ id: 'x', label: 'x', sshHost: '-bad' }]);
  assert.throws(() => new HostRegistry(memento).list(), /cannot start/);
});

test('the same SSH alias can manage distinct named tmux sockets', async () => {
  const registry = new HostRegistry(new MemoryMemento());
  const defaultServer = await registry.add({ sshHost: 'dev', label: 'default' });
  const isolatedServer = await registry.add({ sshHost: 'dev', label: 'isolated', socketName: 'team-a' });
  assert.notEqual(defaultServer.id, isolatedServer.id);
  assert.equal(registry.list().length, 2);
  await assert.rejects(
    registry.update({ ...isolatedServer, socketName: '' }),
    /already configured/
  );
});
