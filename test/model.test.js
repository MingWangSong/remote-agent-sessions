'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecord, mergeSessions, slugify, uniqueLiteralTmuxName, uniqueTmuxName } = require('../src/model');

test('slugify creates tmux-safe names', () => {
  assert.equal(slugify('Fix Payment Callback #42'), 'fix-payment-callback-42');
  assert.equal(slugify('中文任务'), 'agent');
  assert.equal(uniqueTmuxName('agent', new Set(['agent', 'agent-2'])), 'agent-3');
  assert.equal(uniqueLiteralTmuxName('中文任务', new Set()), '中文任务');
  assert.equal(uniqueLiteralTmuxName('My Task', new Set(['My Task'])), 'My Task-2');
});

test('mergeSessions distinguishes live, recoverable, and pre-existing sessions', () => {
  const liveRecord = createRecord({ id: 'one', title: 'Live task', tmuxSession: 'live', cwd: '/tmp/live' });
  const missingRecord = createRecord({ id: 'two', title: 'Missing task', tmuxSession: 'missing', cwd: '/tmp/missing' });
  const entries = mergeSessions([liveRecord, missingRecord], [
    { name: 'live', activity: '2026-01-01T00:00:00.000Z' },
    { name: 'manual', activity: '2026-01-02T00:00:00.000Z' }
  ]);

  assert.equal(entries.length, 3);
  assert.equal(entries.find((item) => item.tmuxSession === 'live').status, 'live');
  assert.equal(entries.find((item) => item.tmuxSession === 'missing').status, 'recoverable');
  assert.equal(entries.find((item) => item.tmuxSession === 'manual').managed, false);
});
