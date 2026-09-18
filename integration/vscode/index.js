'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 20000) {
  for (let elapsed = 0; elapsed < timeout; elapsed += 100) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for VS Code/SSH/tmux state');
}

exports.run = async function () {
  const results = [];
  const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS:', name); };
  const manifest = require('../../package.json');
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension);
  const api = await extension.activate();
  const directory = path.join(process.env.RAS_TEST_DIRECTORY, 'project');
  const socketName = process.env.RAS_TEST_SOCKET;
  const host = await api.registry.add({
    sshHost: 'fake-host', label: 'Local SSH Test Host', defaultCwd: directory,
    tmuxPath: 'tmux', socketName
  });
  await api.provider.reloadHosts();
  const controller = api.controllers.find((candidate) => candidate.host.id === host.id);
  assert.ok(controller);
  let record;

  await check('UI extension activates locally and registers multi-host commands', async () => {
    assert.equal(extension.extensionKind, vscode.ExtensionKind.UI);
    assert.equal(extension.packageJSON.displayName, 'TmuxDock');
    assert.ok(extension.packageJSON.contributes.commands.every((item) => item.category === 'TmuxDock'));
    const commands = await vscode.commands.getCommands(true);
    for (const command of extension.packageJSON.contributes.commands) assert.ok(commands.includes(command.command), command.command);
    assert.equal(api.controllers.length, 1);
    assert.equal(controller.online, true);
    const titleCommands = extension.packageJSON.contributes.menus['view/title'].map((item) => item.command);
    assert.ok(!titleCommands.includes('remoteAgentSessions.create'));
    assert.ok(!titleCommands.includes('remoteAgentSessions.refresh'));
    assert.ok(extension.packageJSON.contributes.menus['view/item/context'].some((item) =>
      item.command === 'remoteAgentSessions.create' && item.when.includes('sshHostOnline')));
    assert.ok(extension.packageJSON.contributes.menus['view/item/context'].some((item) =>
      item.command === 'remoteAgentSessions.refresh' && item.when.includes('sshHost')));
  });

  await check('Host is the tree root and its remote tmux sessions are children', async () => {
    const roots = api.provider.getChildren();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].contextValue, 'sshHostOnline');
    assert.equal(roots[0].controller.host.sshHost, 'fake-host');
  });

  await check('Create through SSH appears as a live managed child', async () => {
    record = await controller.manager.create({ title: 'VS Code SSH acceptance', cwd: directory, host: host.id });
    await api.provider.refresh(controller, false);
    const hostItem = api.provider.getChildren()[0];
    const item = api.provider.getChildren(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    assert.equal(item.contextValue, 'sessionLiveManaged');
    assert.equal(item.command.command, 'remoteAgentSessions.attach');
    assert.equal(item.description, '');
  });

  await check('Actual SSH terminal opens in the active editor area and is reused', async () => {
    const hostItem = api.provider.getChildren()[0];
    const item = api.provider.getChildren(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    await vscode.commands.executeCommand('remoteAgentSessions.attach', item);
    await waitFor(async () => (await controller.tmux.list()).some((session) => session.name === record.tmuxSession && session.attached === 1));
    const attached = vscode.window.terminals.find((terminal) => terminal.name === `Local SSH Test Host: ${record.title}`);
    assert.equal(attached.creationOptions.location.viewColumn, vscode.ViewColumn.Active);
    assert.equal(attached.creationOptions.location.preserveFocus, false);
    const count = vscode.window.terminals.length;
    await vscode.commands.executeCommand('remoteAgentSessions.attach', item);
    assert.equal(vscode.window.terminals.length, count);
  });

  await check('Closing the local terminal detaches while remote tmux survives', async () => {
    vscode.window.terminals.find((terminal) => terminal.name === `Local SSH Test Host: ${record.title}`).dispose();
    await waitFor(async () => (await controller.tmux.list()).some((session) => session.name === record.tmuxSession && session.attached === 0));
    assert.equal(await controller.tmux.exists(record.tmuxSession), true);
  });

  await check('SSH refresh snapshots a new remote window', async () => {
    await controller.tmux.createWindow(record.tmuxSession, { name: 'auto-saved', cwd: directory });
    await api.provider.refresh(controller);
    assert.equal((await controller.manager.store.load()).find((item) => item.id === record.id).windows.length, 2);
  });

  await check('Server loss remains recoverable in the local controller', async () => {
    await controller.tmux.kill(record.tmuxSession);
    await api.provider.refresh(controller);
    const entry = controller.manager.entries.find((item) => item.record?.id === record.id);
    assert.equal(entry.status, 'recoverable');
    const hostItem = api.provider.getChildren()[0];
    const treeItem = api.provider.getChildren(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    assert.equal(treeItem.description, 'rebuild available');
    await controller.manager.restore(entry.record, false);
    assert.equal((await controller.tmux.listWindows(record.tmuxSession)).length, 2);
  });

  await check('Notes and host-aware details persist locally', async () => {
    await controller.manager.setNote(record, '下一步：验证本地控制器');
    await api.provider.refresh(controller, false);
    const hostItem = api.provider.getChildren()[0];
    const item = api.provider.getChildren(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    await vscode.commands.executeCommand('remoteAgentSessions.showDetails', item);
    const text = vscode.window.activeTextEditor.document.getText();
    assert.match(text, /Local SSH Test Host/);
    assert.match(text, /下一步：验证本地控制器/);
    assert.match(text, /Local metadata/);
  });

  await check('Saved and pre-existing sessions can be renamed and permanently deleted', async () => {
    const lifecycle = await controller.manager.create({ title: 'Lifecycle', cwd: directory, host: host.id });
    let entry = controller.manager.entries.find((item) => item.record?.id === lifecycle.id);
    await controller.manager.renameSession(entry, 'Lifecycle renamed', 'vscode-lifecycle-renamed');
    assert.equal(await controller.tmux.exists(lifecycle.tmuxSession), false);
    assert.equal(await controller.tmux.exists('vscode-lifecycle-renamed'), true);
    entry = controller.manager.entries.find((item) => item.record?.id === lifecycle.id);
    await controller.manager.deleteSession(entry);
    assert.equal(await controller.tmux.exists('vscode-lifecycle-renamed'), false);
    assert.equal((await controller.manager.store.load()).some((item) => item.id === lifecycle.id), false);

    await controller.tmux.create('vscode-unmanaged', directory);
    await controller.manager.refresh();
    entry = controller.manager.entries.find((item) => item.tmuxSession === 'vscode-unmanaged');
    await controller.manager.renameSession(entry, entry.title, 'vscode-unmanaged-renamed');
    entry = controller.manager.entries.find((item) => item.tmuxSession === 'vscode-unmanaged-renamed');
    await controller.manager.deleteSession(entry);
    assert.equal(await controller.tmux.exists('vscode-unmanaged-renamed'), false);
  });

  for (const terminal of vscode.window.terminals) if (terminal.name.startsWith('Local SSH Test Host:')) terminal.dispose();
  await controller.manager.terminate(record);
  await controller.manager.forget(record);
  await api.registry.remove(host.id);
  await fs.mkdir(path.dirname(process.env.RAS_TEST_REPORT), { recursive: true });
  await fs.writeFile(process.env.RAS_TEST_REPORT, JSON.stringify({
    vscode: vscode.version,
    extensionKind: 'ui',
    transport: 'local fake SSH process with isolated tmux socket',
    passed: results.length,
    checks: results
  }, null, 2));
};
