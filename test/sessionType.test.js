'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commandType, sessionType, TYPE_ICONS } = require('../src/sessionType');

test('agent commands are identified by executable rather than title or arbitrary arguments', () => {
  assert.equal(commandType('/opt/bin/codex resume abc'), 'codex');
  assert.equal(commandType('env MODE=test claude --continue'), 'claude');
  assert.equal(commandType('"/path with spaces/codex"'), 'codex');
  for (const text of ['bash', 'node', 'echo codex', 'git checkout claude', 'my-codex-tool']) assert.equal(commandType(text), null);
});

test('live pane commands identify unmanaged sessions and prefer the active agent', () => {
  assert.equal(sessionType({ live: { currentCommand: 'claude', commands: ['codex', 'claude'] } }), 'claude');
  assert.equal(sessionType({ live: { currentCommand: 'bash', commands: ['bash', 'codex'] } }), 'codex');
  assert.equal(sessionType({ title: 'claude session', live: { currentCommand: 'bash' } }), 'shell');
});

test('stopped records retain explicit agent type or infer it from their saved commands', () => {
  assert.equal(sessionType({ record: { agent: { type: 'codex' } } }), 'codex');
  assert.equal(sessionType({ record: { windows: [{ panes: [{ command: 'claude --resume abc' }] }] } }), 'claude');
  assert.equal(sessionType({ record: { agent: { type: 'custom' }, windows: [{ command: 'npm test' }] } }), 'shell');
  assert.equal(new Set(Object.values(TYPE_ICONS)).size, 3);
});
