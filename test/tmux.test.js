'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FIELD_SEPARATOR, TmuxClient, parseTmuxList } = require('../src/tmux');

test('parseTmuxList parses the stable field-separated format', () => {
  const line = ['agent-one', '1700000000', '1', '3', '1700000100'].join(FIELD_SEPARATOR);
  assert.deepEqual(parseTmuxList(`${line}\n`), [{
    name: 'agent-one',
    created: '2023-11-14T22:13:20.000Z',
    attached: 1,
    windows: 3,
    id: undefined,
    owner: null,
    activity: '2023-11-14T22:15:00.000Z'
  }]);
});

test('TmuxClient passes commands as argv instead of shell strings', async () => {
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    return { stdout: '%0\n' };
  };
  const tmux = new TmuxClient('/usr/bin/tmux', runner);
  await tmux.create('name with spaces', '/work/project');
  await tmux.sendCommand('name with spaces', 'agent', 'echo "$TOKEN"');
  await tmux.rename('name with spaces', 'renamed');

  assert.deepEqual(calls[0], {
    file: '/usr/bin/tmux',
    args: ['-u', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'name with spaces', '-n', 'agent', '-c', '/work/project', '-x', '160', '-y', '48']
  });
  assert.deepEqual(calls[1].args, ['-u', 'send-keys', '-t', '=name with spaces:agent', '-l', '--', 'echo "$TOKEN"']);
  assert.deepEqual(calls[3].args, ['-u', 'rename-session', '-t', '=name with spaces', 'renamed']);
});

test('TmuxClient treats an absent tmux server as an empty list', async () => {
  const runner = async () => {
    const error = new Error('failed');
    error.stderr = 'no server running on /tmp/tmux-1000/default';
    throw error;
  };
  const tmux = new TmuxClient('tmux', runner);
  assert.deepEqual(await tmux.list(), []);
});

test('TmuxClient does not hide no-server-shaped errors from mutating commands', async () => {
  const runner = async () => {
    const error = new Error('failed');
    error.stderr = 'failed to connect to server';
    throw error;
  };
  const tmux = new TmuxClient('tmux', runner);
  await assert.rejects(() => tmux.create('agent', '/work'), /tmux new-session failed/);
});
