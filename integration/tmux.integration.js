'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { createRecord } = require('../src/model');
const { SessionManager } = require('../src/sessionManager');
const { SessionStore } = require('../src/store');
const { TmuxClient } = require('../src/tmux');
const run = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-integration-'));
  const socket = 'ras-test-' + randomUUID();
  const runner = (file, args, opts) => run(file, args, { ...opts, env: { ...opts.env, SHELL: '/bin/sh' } });
  const tmux = new TmuxClient(process.env.RAS_TMUX || 'tmux', runner, ['-L', socket, '-f', '/dev/null']);
  const store = new SessionStore(path.join(directory, 'records', 'sessions.json'));
  const manager = new SessionManager(store, tmux);
  t.after(async () => {
    await tmux.run(['kill-server'], { allowNoServer: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  await manager.initialize();
  return { directory, socket, tmux, store, manager };
}
async function eventually(callback) {
  for (let i = 0; i < 50; i++) { if (await callback()) return; await pause(100); }
  throw new Error('Condition not satisfied within 5 seconds');
}

test('real tmux: create, run command, persist notes, reload manager and discover pre-existing sessions', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const r = await manager.create({ title: '中文任务', cwd: directory, command: 'printf RUN_OK' });
  assert.equal(manager.entries[0].status, 'live');
  await eventually(async () => (await tmux.run(['capture-pane', '-p', '-t', r.windows[0].panes[0].id])).includes('RUN_OK'));
  await manager.setNote(r, '继续检查失败重试');
  const reconnected = new SessionManager(store, tmux);
  await reconnected.initialize();
  assert.equal(reconnected.records[0].note, '继续检查失败重试');
  assert.equal(reconnected.records[0].windows[0].panes[0].command, 'printf RUN_OK');
  await tmux.create('manual', directory);
  await reconnected.refresh();
  assert.equal(reconnected.entries.find((e) => e.tmuxSession === 'manual').managed, false);
});

test('real tmux: server loss, all windows/panes/directories reconstructed and commands kept', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const subdir = path.join(directory, "项目 with 'quotes'"); await fs.mkdir(subdir);
  const r = await manager.create({ title: 'layout', cwd: directory });
  let windows = await tmux.listWindows(r.tmuxSession);
  await tmux.split(windows[0].panes[0].id, subdir);
  await tmux.createWindow(r.tmuxSession, { name: 'duplicate name', cwd: subdir });
  await tmux.createWindow(r.tmuxSession, { name: 'duplicate name', cwd: directory });
  await manager.refresh();
  await manager.setCommand(r, 0, 1, 'printf RESTORED_PANE');
  const before = (await store.load())[0];
  assert.deepEqual(before.windows.map((w) => w.panes.length), [2, 1, 1]);
  await tmux.run(['kill-server']);
  await pause(150);
  const restarted = new SessionManager(store, tmux);
  await restarted.initialize();
  assert.equal(restarted.entries[0].status, 'recoverable');
  await restarted.restore(r, true);
  const after = (await store.load())[0];
  assert.deepEqual(after.windows.map((w) => w.panes.map((p) => p.cwd)), before.windows.map((w) => w.panes.map((p) => p.cwd)));
  assert.deepEqual(after.windows.map((w) => w.name), before.windows.map((w) => w.name));
  assert.equal(after.windows[0].panes[1].command, 'printf RESTORED_PANE');
  await eventually(async () => (await tmux.run(['capture-pane', '-p', '-t', after.windows[0].panes[1].id])).includes('RESTORED_PANE'));
});

test('real tmux: concurrent create from independent managers uses unique names without lost records', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const second = new SessionManager(new SessionStore(store.filePath), tmux);
  await second.initialize();
  const results = await Promise.all([manager.create({ title: 'same', cwd: directory }), second.create({ title: 'same', cwd: directory })]);
  assert.equal(new Set(results.map((r) => r.tmuxSession)).size, 2);
  assert.equal((await store.load()).length, 2);
  await Promise.all([manager.setNote(results[0], 'one'), second.setNote(results[1], 'two')]);
  assert.deepEqual(new Set((await store.load()).map((r) => r.note)), new Set(['one', 'two']));
});

test('real tmux: repeated/concurrent restore never executes a command twice', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const r = await manager.create({ title: 'idempotent', cwd: directory });
  await manager.setCommand(r, 0, 0, 'printf x >> counter');
  await manager.terminate(r);
  const second = new SessionManager(new SessionStore(store.filePath), tmux);
  await Promise.all([manager.restore(r, true), second.restore(r, true)]);
  await eventually(async () => (await fs.readFile(path.join(directory, 'counter'), 'utf8').catch(() => '')) === 'x');
  await manager.restore(r, true);
  await pause(200);
  assert.equal(await fs.readFile(path.join(directory, 'counter'), 'utf8'), 'x');
});

test('real tmux: manual rename preserves identity, while same-name replacement is a conflict', async (t) => {
  const { directory, tmux, manager } = await fixture(t);
  const r = await manager.create({ title: 'identity', cwd: directory });
  await tmux.run(['rename-session', '-t', '=' + r.tmuxSession, 'renamed']);
  await manager.refresh();
  assert.equal(manager.records[0].tmuxSession, 'renamed');
  await tmux.kill('renamed'); await pause(100);
  await tmux.create('renamed', directory);
  await manager.refresh();
  assert.equal(manager.entries[0].status, 'conflict');
  await assert.rejects(manager.terminate(r), /identity changed/);
  await assert.rejects(manager.renameSession(r, 'Do not rename replacement', 'unsafe-rename'), /identity changed/);
  await assert.rejects(manager.deleteSession(r), /identity changed/);
  await assert.rejects(manager.restore(r), /different tmux session/);
  assert.equal(await tmux.exists('renamed'), true);
});

test('real tmux: missing directory fails before creating any restored process', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const r = await manager.create({ title: 'missing-directory', cwd: directory });
  await manager.terminate(r);
  await store.transaction((records) => { records[0].windows[0].panes[0].cwd = path.join(directory, 'gone'); });
  await assert.rejects(manager.restore(r), /does not exist/);
  assert.equal(await tmux.exists(r.tmuxSession), false);
  assert.equal((await store.load()).length, 1);
});

test('real tmux: mid-restore failure rolls back shells but keeps recovery data', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const r = await manager.create({ title: 'rollback', cwd: directory });
  await tmux.createWindow(r.tmuxSession, { name: 'second', cwd: directory });
  await manager.terminate(r);
  const original = tmux.createWindow;
  tmux.createWindow = async () => { throw new Error('Injected window failure'); };
  await assert.rejects(manager.restore(r), /Injected window failure/);
  tmux.createWindow = original;
  assert.equal(await tmux.exists(r.tmuxSession), false);
  assert.equal((await store.load())[0].windows.length, 2);
  await manager.restore(r);
  assert.equal((await tmux.listWindows(r.tmuxSession)).length, 2);
});

test('real tmux: adopted base-index=1 sessions preserve panes, and forget leaves processes running', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const p = await tmux.create('existing', directory);
  await tmux.run(['set-option', '-g', 'base-index', '1']);
  await tmux.run(['set-option', '-g', 'renumber-windows', 'on']);
  await tmux.split(p, directory);
  await manager.refresh();
  const r = await manager.adopt(manager.entries[0], 'Existing work');
  assert.equal(r.windows[0].panes.length, 2);
  await manager.terminate(r);
  await manager.restore(r);
  assert.equal((await tmux.listWindows('existing'))[0].panes.length, 2);
  await manager.forget(r);
  assert.equal((await store.load()).length, 0);
  assert.equal(await tmux.exists('existing'), true);
});

test('real tmux: command restore disabled opens shells without side effects', async (t) => {
  const { directory, manager } = await fixture(t);
  const r = await manager.create({ title: 'no-run', cwd: directory });
  await manager.setCommand(r, 0, 0, 'touch should-not-exist');
  await manager.terminate(r);
  await manager.restore(r, false);
  await pause(200);
  assert.equal(await fs.stat(path.join(directory, 'should-not-exist')).catch(() => null), null);
});

test('real tmux: v0.1 records migrate without losing configured commands', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  await tmux.create('legacy', directory);
  await store.save([createRecord({ tmuxSession: 'legacy', cwd: directory,
    windows: [{ name: 'agent', cwd: directory, command: 'legacy-agent resume old-id' }] })]);
  await manager.refresh();
  assert.equal(manager.entries[0].status, 'live');
  assert.equal(manager.records[0].identityVersion, 1);
  assert.equal(manager.records[0].windows[0].panes[0].command, 'legacy-agent resume old-id');
  assert.equal((await tmux.list())[0].owner, manager.records[0].id);
});

test('real Git: repository, branch and detached HEAD are captured from the task directory', async (t) => {
  const { directory, manager } = await fixture(t);
  await run('git', ['init', '-b', 'agent-work', directory]);
  await run('git', ['-C', directory, 'config', 'user.name', 'Acceptance Test']);
  await run('git', ['-C', directory, 'config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(directory, 'README'), 'fixture');
  await run('git', ['-C', directory, 'add', 'README']);
  await run('git', ['-C', directory, 'commit', '-m', 'fixture']);
  const subdir = path.join(directory, 'src'); await fs.mkdir(subdir);
  const record = await manager.create({ title: 'git-context', cwd: subdir });
  assert.equal(record.repoRoot, await fs.realpath(directory));
  assert.equal(record.gitBranch, 'agent-work');
  await run('git', ['-C', directory, 'checkout', '--detach']);
  await manager.refresh();
  const hash = (await run('git', ['-C', directory, 'rev-parse', '--short', 'HEAD'])).stdout.trim();
  assert.equal(manager.records[0].gitBranch, hash);
});

test('real tmux: rename and delete cover saved, recoverable and pre-existing lifecycle', async (t) => {
  const { directory, tmux, store, manager } = await fixture(t);
  const record = await manager.create({ title: 'Lifecycle', cwd: directory });
  const owner = (await tmux.list())[0].owner;
  await manager.renameSession(manager.entries[0], 'Renamed lifecycle', 'lifecycle-renamed');
  assert.equal(await tmux.exists('lifecycle'), false);
  assert.equal(await tmux.exists('lifecycle-renamed'), true);
  assert.equal((await tmux.list())[0].owner, owner);
  assert.equal((await store.load())[0].title, 'Renamed lifecycle');
  assert.equal((await store.load())[0].tmuxSession, 'lifecycle-renamed');
  await manager.deleteSession(manager.entries[0]);
  assert.equal(await tmux.exists('lifecycle-renamed'), false);
  assert.equal((await store.load()).length, 0);

  const recoverable = await manager.create({ title: 'Recoverable delete', cwd: directory });
  await manager.terminate(recoverable);
  await manager.deleteSession(manager.entries.find((entry) => entry.record?.id === recoverable.id));
  assert.equal((await store.load()).length, 0);

  await tmux.create('manual-old', directory);
  await manager.refresh();
  let unmanaged = manager.entries.find((entry) => entry.tmuxSession === 'manual-old');
  await manager.renameSession(unmanaged, 'manual-old', 'manual-new');
  assert.equal(await tmux.exists('manual-old'), false);
  assert.equal(await tmux.exists('manual-new'), true);
  unmanaged = manager.entries.find((entry) => entry.tmuxSession === 'manual-new');
  await manager.deleteSession(unmanaged);
  assert.equal(await tmux.exists('manual-new'), false);
});
