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

test('pane enumeration deduplicates sessions and collects commands across all windows', () => {
  const base = ['agent', '1700000000', '0', '2', '1700000100', '$1', 'owner'];
  const stdout = [
    [...base, 'codex', '0', '1'], [...base, 'bash', '1', '0'], [...base, 'claude', '1', '1']
  ].map(row => row.join(FIELD_SEPARATOR)).join('\n');
  const sessions = parseTmuxList(stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].currentCommand, 'claude');
  assert.deepEqual(sessions[0].commands, ['codex', 'bash', 'claude']);
});

test('session inventory carries a complete reusable multi-pane layout snapshot', () => {
  const base = ['agent', '1700000000', '0', '1', '1700000100', '$1', 'owner'];
  const stdout = [
    [...base, 'codex', '1', '1', '@1', 'main', 'layout', '%1', '/a'],
    [...base, 'bash', '1', '0', '@1', 'main', 'layout', '%2', '/b']
  ].map(row => row.join(FIELD_SEPARATOR)).join('\n');
  const session = parseTmuxList(stdout)[0];
  assert.equal(session.snapshotWindows.length, 1);
  assert.deepEqual(session.snapshotWindows[0].panes.map(pane => pane.cwd), ['/a', '/b']);
  assert.equal(session.snapshotWindows[0].panes[0].active, true);
  assert.equal(session.snapshotWindows[0].layout, 'layout');
});

test('TmuxClient preserves direct argv and quotes grouped commands', async () => {
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
  assert.equal(calls[1].file, 'sh');
  assert.equal(calls[1].args[0], '-c');
  assert.deepEqual(calls[2].args, ['-u', 'rename-session', '-t', '=name with spaces', 'renamed']);
});

test('grouped transport preserves arbitrary literal argv and never runs injected text outside the pane', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxdock-argv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'argv.jsonl'), marker = path.join(dir, 'must-not-exist');
  const executable = path.join(dir, "tmux mock 'quoted");
  await fs.writeFile(executable, '#!/usr/bin/env node\n' +
    `const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');` +
    "if(a.at(-1)==='FAIL'){process.stderr.write('injected failure');process.exit(7);}", { mode: 0o700 });
  const tmux = new TmuxClient(executable, undefined, ['-L', 'isolated']);
  const payload = 'echo "$TOKEN"; $(touch ' + marker + ') `touch ' + marker + '` \' " ; \\';
  await tmux.sendCommand('name with spaces', '%5', payload);
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    ['-u', '-L', 'isolated', 'send-keys', '-t', '%5', '-l', '--', payload],
    ['-u', '-L', 'isolated', 'send-keys', '-t', '%5', 'Enter']
  ]);
  assert.equal(await fs.stat(marker).catch(() => null), null);
  await fs.writeFile(log, '');
  await assert.rejects(tmux.sendCommand('session', '%5', 'FAIL'), /injected failure/);
  const failedCalls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(failedCalls.length, 1, 'failed literal send must never be followed by Enter');
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

test('all windows and panes are captured in one remote call', async () => {
  let count = 0;
  const tmux = new TmuxClient('tmux', async (file, args) => {
    count++;
    assert.equal(args[1], 'list-panes');
    assert.ok(args.includes('-s'));
    return { stdout: [
      ['@1', 'one', 'layout1', '1', '%1', '/a b', 'sh', '1'],
      ['@1', 'one', 'layout1', '1', '%2', '/中文', 'claude', '0'],
      ['@2', 'two', 'layout2', '0', '%3', '/c', 'sh', '1']
    ].map(row => row.join(tmux.separator)).join('\n') + '\n' };
  });
  const windows = await tmux.listWindows('test');
  assert.equal(count, 1);
  assert.deepEqual(windows.map(w => w.panes.length), [2, 1]);
  assert.equal(windows[0].panes[1].cwd, '/中文');
  assert.equal(windows[1].active, false);
});
