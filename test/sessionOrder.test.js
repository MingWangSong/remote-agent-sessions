'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionOrder, sessionKey } = require('../src/sessionOrder');
const { mergeSessions, createRecord } = require('../src/model');
const storage = () => {
  const values = new Map();
  return { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) };
};
function session(name, day) {
  return { name, id: '$' + day, created: `2026-01-0${day}T00:00:00Z`, activity: '2099-01-01' };
}

test('default order is oldest first and ignores activity, notes and status changes', () => {
  const record = createRecord({ id: 'saved', tmuxSession: 'old', createdAt: '2025-01-01', cwd: '/tmp' });
  const entries = mergeSessions([record], [session('second', 2), session('first', 1)]);
  assert.deepEqual(entries.map(e => e.tmuxSession), ['old', 'first', 'second']);
  record.updatedAt = '2099-01-01';
  const refreshed = mergeSessions([record], [session('first', 1), { ...session('second', 2), activity: '1900-01-01' }]);
  assert.deepEqual(refreshed.map(e => e.tmuxSession), ['old', 'first', 'second']);
});

test('drag order persists across reload, rename, new sessions and host isolation; reset restores creation order', async () => {
  const state = storage();
  const order = new SessionOrder(state);
  const entries = mergeSessions([], [session('first', 1), session('second', 2), session('third', 3)]);
  await order.move('host', entries, [sessionKey(entries[2])], sessionKey(entries[0]));
  const reloaded = new SessionOrder(state);
  assert.deepEqual(reloaded.sort('host', entries).map(e => e.title), ['third', 'first', 'second']);
  const renamed = mergeSessions([], [{ ...session('first', 1), name: 'renamed' }, session('second', 2), session('third', 3), session('new', 4)]);
  assert.deepEqual(reloaded.sort('host', renamed).map(e => e.title), ['third', 'renamed', 'second', 'new']);
  assert.deepEqual(reloaded.sort('other', entries).map(e => e.title), ['first', 'second', 'third']);
  await reloaded.reset('host');
  assert.deepEqual(reloaded.sort('host', entries).map(e => e.title), ['first', 'second', 'third']);
});

test('multi-selection moves together and dropping on the host appends to the end', async () => {
  const order = new SessionOrder(storage());
  const entries = mergeSessions([], [session('a', 1), session('b', 2), session('c', 3)]);
  await order.move('host', entries, entries.slice(0, 2).map(sessionKey), null);
  assert.deepEqual(order.sort('host', entries).map(e => e.title), ['c', 'a', 'b']);
});
