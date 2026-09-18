'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SshClient } = require('../src/ssh');
const { TmuxClient } = require('../src/tmux');
const { GitInspector, SessionManager } = require('../src/sessionManager');
const { SessionStore } = require('../src/store');

const sshHost = process.env.RAS_SSH_HOST;

test('local controller manages and rebuilds an isolated tmux server through real SSH', { skip: !sshHost }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-ssh-'));
  const socketName = `ras-v2-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const host = { id: 'ssh-acceptance', label: sshHost, sshHost, tmuxPath: 'tmux', socketName };
  const ssh = new SshClient(host, { sshPath: process.env.RAS_SSH_PATH || 'ssh' });
  const defaultTmux = new TmuxClient('tmux', ssh.run.bind(ssh));
  const tmux = new TmuxClient('tmux', ssh.run.bind(ssh), ['-L', socketName]);
  t.after(async () => {
    await tmux.run(['kill-server'], { allowNoServer: true }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  });

  const before = (await defaultTmux.list()).map(({ id, created, name }) => ({ id, created, name }));
  const remoteHome = await ssh.homeDirectory();
  await ssh.checkDirectory(remoteHome);
  const childDirectories = await ssh.listDirectories(remoteHome);
  assert.ok(Array.isArray(childDirectories));
  assert.ok(childDirectories.every((directory) => path.posix.dirname(directory) === remoteHome));
  const manager = new SessionManager(
    new SessionStore(path.join(temp, 'sessions.json')),
    tmux,
    new GitInspector(ssh.run.bind(ssh)),
    ssh.checkDirectory.bind(ssh)
  );

  const record = await manager.create({
    title: 'SSH controller acceptance', cwd: remoteHome,
    command: "printf 'RAS_V2_SSH_OK\\n'", host: host.id
  });
  assert.equal(manager.entries.find((entry) => entry.record?.id === record.id).status, 'live');
  await tmux.createWindow(record.tmuxSession, { name: 'second', cwd: remoteHome });
  await tmux.split(`=${record.tmuxSession}:second`, remoteHome);
  await manager.setNote(record, 'remote SSH acceptance note');
  await manager.refresh();
  assert.equal(manager.records[0].windows.length, 2);
  assert.equal(manager.records[0].windows[1].panes.length, 2);

  await tmux.kill(record.tmuxSession);
  await manager.refresh();
  assert.equal(manager.entries[0].status, 'recoverable');
  await manager.restore(record, true);
  assert.equal((await tmux.listWindows(record.tmuxSession)).length, 2);
  const output = await tmux.run(['capture-pane', '-p', '-t', `=${record.tmuxSession}:agent`]);
  assert.match(output, /RAS_V2_SSH_OK/);
  assert.equal((await manager.store.load())[0].note, 'remote SSH acceptance note');

  let entry = manager.entries.find((candidate) => candidate.record?.id === record.id);
  await manager.renameSession(entry, 'SSH lifecycle renamed', 'ssh-lifecycle-renamed');
  assert.equal(await tmux.exists(record.tmuxSession), false);
  assert.equal(await tmux.exists('ssh-lifecycle-renamed'), true);
  entry = manager.entries.find((candidate) => candidate.record?.id === record.id);
  await manager.deleteSession(entry);
  assert.equal(await tmux.exists('ssh-lifecycle-renamed'), false);
  assert.equal((await manager.store.load()).length, 0);
  const after = (await defaultTmux.list()).map(({ id, created, name }) => ({ id, created, name }));
  assert.deepEqual(after, before, 'default tmux server must remain unchanged');
});
