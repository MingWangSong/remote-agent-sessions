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
  const extension = vscode.extensions.getExtension(process.env.RAS_TEST_EXTENSION_ID || `${manifest.publisher}.${manifest.name}`);
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
  const sessionItems = host => api.provider.getChildren(host).flatMap(group =>
    group.kind === 'sessionGroup' ? api.provider.getChildren(group) : []);

  await check('UI extension activates locally and registers multi-host commands', async () => {
    assert.equal(extension.extensionKind, vscode.ExtensionKind.UI);
    assert.equal(extension.packageJSON.displayName, 'TmuxDock');
    assert.ok(extension.packageJSON.contributes.commands.every((item) => item.category === 'TmuxDock'));
    const commands = await vscode.commands.getCommands(true);
    for (const command of extension.packageJSON.contributes.commands) assert.ok(commands.includes(command.command), command.command);
    const menus = extension.packageJSON.contributes.menus;
    const common = menus['view/item/context'].filter(item => item.when.includes('session') && !item.when.includes('sshHost'));
    for (const name of ['terminate','addNote','editCommand','showDetails','bindAgentSession','linkDirectory'])
      assert.ok(!common.some(item => item.command === 'remoteAgentSessions.' + name));
    assert.ok(common.some(item => item.submenu === 'remoteAgentSessions.sessionMore'));
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

  await check('Legacy Codex binding selects a readable history instead of requiring a pasted UUID', async () => {
    const legacy = await controller.manager.create({ title: 'Legacy Codex acceptance', cwd: directory });
    await controller.manager.terminate(legacy);
    await controller.manager.store.transaction(records => {
      const old = records.find(record => record.id === legacy.id);
      old.agent = { type: 'codex' }; old.windows[0].panes[0].command = 'codex';
    });
    await controller.manager.reloadRecords();
    const originalAgents = controller.manager.agents;
    const originalId = '550e8400-e29b-41d4-a716-446655440000';
    let loaded = false, linked = false;
    controller.manager.agents = {
      listCodexConversations: async () => { loaded = true; return { conversations: [{ id: originalId,
        name: 'Readable original conversation', preview: 'Original user task', cwd: directory, updatedAt: 1730831111, archived: false }], nextCursor: null }; },
      bind: async (type, sessionId, name) => {
        linked = true; assert.equal(sessionId, originalId);
        return { type, sessionId, name, recoveryVersion: 1, launchState: 'started' };
      }
    };
    try {
      const item = sessionItems(api.provider.getChildren()[0]).find(item => item.entry.id === legacy.id);
      assert.ok(item.contextValue.endsWith('NeedsBinding'));
      const pending = vscode.commands.executeCommand('remoteAgentSessions.bindAgentSession', item);
      await waitFor(() => loaded); await sleep(100);
      assert.equal(linked, false, 'loading even one result must not bind it automatically');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await pending;
      const saved = (await controller.manager.store.load()).find(record => record.id === legacy.id);
      assert.equal(saved.agent.sessionId, originalId);
      assert.ok(!sessionItems(api.provider.getChildren()[0]).find(item => item.entry.id === legacy.id).contextValue.endsWith('NeedsBinding'));
      assert.equal(saved.windows[0].panes[0].agent.sessionId, originalId);
      assert.ok(saved.windows[0].panes[0].command.includes(originalId));
      assert.ok(!saved.windows[0].panes[0].command.includes('--last'));
    } finally { controller.manager.agents = originalAgents; }
    await controller.manager.forget(legacy);
  });

  await check('Create through SSH appears as a live managed child', async () => {
    record = await controller.manager.create({ title: 'VS Code SSH acceptance', cwd: directory, host: host.id });
    await api.provider.refresh(controller, false);
    const hostItem = api.provider.getChildren()[0];
    const item = sessionItems(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    assert.equal(item.contextValue, 'sessionLiveManaged');
    assert.equal(item.command.command, 'remoteAgentSessions.attach');
    assert.equal(item.description, '');
  });

  await check('Running and stopped sessions have separate stable groups; unavailable is not stopped', async () => {
    const stopped = await controller.manager.create({ title: 'Stopped grouping test', cwd: directory, host: host.id });
    await controller.manager.terminate(stopped);
    const root = api.provider.getChildren()[0];
    const groups = api.provider.getChildren(root);
    assert.deepEqual(groups.map(group => group.group), ['running', 'stopped']);
    assert.equal(groups[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.equal(groups[1].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.ok(api.provider.getChildren(groups[0]).every(item => item.entry.status === 'live'));
    assert.ok(api.provider.getChildren(groups[1]).every(item => item.entry.status === 'recoverable'));
    const runningItem = api.provider.getChildren(groups[0])[0];
    const transfer = new vscode.DataTransfer();
    api.provider.handleDrag([runningItem], transfer);
    const savedOrder = [...api.provider.order.saved(host.id)];
    await api.provider.handleDrop(groups[1], transfer);
    assert.deepEqual(api.provider.order.saved(host.id), savedOrder, 'cross-group drag must be ignored');
    await controller.manager.restore(stopped);
    assert.deepEqual(api.provider.getChildren(root).map(group => group.group), ['running']);
    const entries = controller.manager.entries;
    try {
      controller.online = false;
      controller.manager.entries = entries.map(entry => ({ ...entry, status: 'unavailable' }));
      const offlineGroups = api.provider.getChildren(root);
      assert.deepEqual(offlineGroups.map(group => group.group), ['unknown']);
      assert.equal(api.provider.getChildren(offlineGroups[0]).length, entries.length);
    } finally { controller.online = true; controller.manager.entries = entries; }
    await controller.manager.terminate(stopped);
    await controller.manager.forget(stopped);
  });

  await check('Codex, Claude and shell have distinct icons in both groups; rows show no branch', async () => {
    const saved = controller.manager.entries;
    try {
      controller.manager.entries = ['live', 'recoverable'].flatMap(status => ['codex', 'claude', 'shell'].map(type => ({
        id: `${status}-${type}`, title: `${type} task`, tmuxSession: `${status}-${type}`, managed: true, status,
        record: { id: `${status}-${type}`, agent: type === 'shell' ? null : { type }, gitBranch: 'must-not-appear-in-row' }
      })));
      const root = api.provider.getChildren()[0];
      for (const group of api.provider.getChildren(root)) {
        const items = api.provider.getChildren(group);
        assert.equal(new Set(items.map(item => item.iconPath.id || path.basename(item.iconPath.light.fsPath))).size, 3);
        for (const item of items) {
          if (item.entry.record.agent) {
            assert.equal(item.iconPath.light.scheme, 'file');
            assert.equal(item.iconPath.dark.scheme, 'file');
            for (const theme of ['light', 'dark']) {
              const svg = await fs.readFile(item.iconPath[theme].fsPath, 'utf8');
              assert.ok(svg.includes('<svg'));
              assert.ok(!svg.includes('<script'));
            }
          }
          assert.equal(item.label, item.entry.title);
          assert.ok(!item.description.includes('must-not-appear-in-row'));
          assert.ok(!item.label.includes('must-not-appear-in-row'));
        }
      }
    } finally { controller.manager.entries = saved; }
  });

  await check('Actual SSH terminal opens in the active editor area and is reused', async () => {
    const hostItem = api.provider.getChildren()[0];
    const item = sessionItems(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    const originalList = controller.tmux.list.bind(controller.tmux);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    controller.tmux.list = async () => { calls++; await gate; return originalList(); };
    const connecting = vscode.commands.executeCommand('remoteAgentSessions.attach', item);
    const duplicate = vscode.commands.executeCommand('remoteAgentSessions.attach', item);
    try {
      await waitFor(() => controller.sessionActivity.has(item.entry.id));
      const busyItem = sessionItems(hostItem).find(candidate => candidate.entry?.id === item.entry.id);
      assert.equal(busyItem.iconPath.id, 'loading~spin');
      assert.match(busyItem.description, /Connecting/);
      assert.equal(calls, 1, 'duplicate click must not start another SSH identity query');
    } finally { release(); }
    await Promise.all([connecting, duplicate]);
    controller.tmux.list = originalList;
    assert.equal(controller.sessionActivity.size, 0);
    await waitFor(async () => (await controller.tmux.list()).some((session) => session.name === record.tmuxSession && session.attached === 1));
    const attached = vscode.window.terminals.find((terminal) => terminal.name === record.title);
    assert.equal(attached.creationOptions.location.viewColumn, vscode.ViewColumn.Active);
    assert.equal(attached.creationOptions.location.preserveFocus, false);
    assert.equal(attached.creationOptions.name, record.title);
    assert.ok(!attached.name.includes(host.label));
    assert.ok(attached.creationOptions.message.includes(host.label));
    assert.ok(api.terminalStatus.text.includes(host.label));
    const count = vscode.window.terminals.length;
    await vscode.commands.executeCommand('remoteAgentSessions.attach', item);
    assert.equal(vscode.window.terminals.length, count);
  });

  await check('Reopening an existing terminal bypasses a slow host refresh without SSH', async () => {
    const root = api.provider.getChildren()[0];
    const item = sessionItems(root).find(candidate => candidate.entry?.id === record.id);
    const originalList = controller.tmux.list.bind(controller.tmux);
    let release, entered; const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let calls = 0;
    controller.tmux.list = async () => { calls++; entered(); await gate; return originalList(); };
    const refreshing = vscode.commands.executeCommand('remoteAgentSessions.refresh', root);
    try {
      await started;
      let focused = false;
      const attach = vscode.commands.executeCommand('remoteAgentSessions.attach', item).then(() => { focused = true; });
      await sleep(100);
      assert.equal(focused, true, 'local terminal focus must not wait for the host queue');
      assert.equal(calls, 1, 'local focus must not issue another SSH query');
      await attach;
    } finally { release(); await refreshing; controller.tmux.list = originalList; }
  });

  await check('Compact same-name tabs retain host identity in status, tooltip and details', async () => {
    const entry = controller.manager.entries.find(candidate => candidate.record?.id === record.id);
    const first = vscode.window.terminals.find(terminal => terminal.name === record.title);
    // Two host identities share the isolated fake SSH transport for this UI test.
    const other = { ...controller, host: { ...controller.host, id: host.id + '-second', label: 'Second SSH Host' } };
    let duplicate, unrelated;
    try {
      await api.attachEntry(other, entry);
      duplicate = vscode.window.terminals.find(terminal => terminal.name === `${record.title} · 2`);
      assert.ok(duplicate);
      assert.ok(!duplicate.name.includes('Second SSH Host'));
      assert.ok(duplicate.creationOptions.message.includes('Second SSH Host'));
      await waitFor(() => api.terminalStatus.text.includes('Second SSH Host'));
      assert.ok(api.terminalStatus.tooltip.value.includes('Second SSH Host'));
      await vscode.commands.executeCommand('workbench.action.previousEditor');
      await waitFor(() => api.terminalStatus.text.includes(host.label));
      await vscode.commands.executeCommand('workbench.action.nextEditor');
      await waitFor(() => api.terminalStatus.text.includes('Second SSH Host'));
      const action = api.terminalStatus.command;
      await vscode.commands.executeCommand(action.command, ...action.arguments);
      assert.ok(vscode.window.activeTextEditor.document.getText().includes('Second SSH Host'));
      await waitFor(() => api.terminalStatus.text === '');
      first.show();
      await waitFor(() => api.terminalStatus.text.includes(host.label));
      unrelated = vscode.window.createTerminal({ name: 'Unrelated local terminal', shellPath: '/bin/sh', isTransient: true });
      unrelated.show();
      await waitFor(() => api.terminalStatus.text === '');
      // The previous editor selection may still have a queued tab event.
      // An ordinary panel terminal must stay unidentified after it settles.
      await sleep(100);
      assert.equal(api.terminalStatus.text, '');
    } finally {
      duplicate?.dispose();
      unrelated?.dispose();
      first.show();
    }
    await waitFor(() => api.terminalStatus.text.includes(host.label));
    await waitFor(async () => (await controller.tmux.list()).find(session => session.name === record.tmuxSession)?.attached === 1);
    assert.equal(first.name, record.title, 'opening or closing a collision must not rename the original tab');
  });

  await check('Editor tab switching synchronizes session identity and visible sidebar selection', async () => {
    const extra = await controller.manager.create({ title: 'Tab selection check', cwd: directory, host: host.id });
    await api.provider.refresh(controller, false);
    const entry = controller.manager.entries.find(candidate => candidate.record?.id === extra.id);
    await api.attachEntry(controller, entry);
    const extraTerminal = vscode.window.terminals.find(terminal => terminal.name === extra.title);
    await vscode.commands.executeCommand('remoteAgentSessions.sessions.focus');
    await waitFor(() => api.view.visible);
    const activateTab = async title => {
      const index = vscode.window.tabGroups.activeTabGroup.tabs.findIndex(tab => tab.label === title);
      assert.ok(index >= 0 && index < 9);
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
    };
    try {
      await activateTab(record.title);
      await waitFor(() => api.terminalStatus.command?.arguments?.[0]?.entry.id === record.id);
      await waitFor(() => api.view.selection[0]?.entry?.id === record.id);
      await activateTab(extra.title);
      await waitFor(() => api.terminalStatus.command?.arguments?.[0]?.entry.id === extra.id);
      await waitFor(() => api.view.selection[0]?.entry?.id === extra.id);
    } finally {
      extraTerminal.dispose();
      await controller.manager.terminate(extra);
      await controller.manager.forget(extra);
      vscode.window.terminals.find(terminal => terminal.name === record.title).show();
    }
  });

  await check('Tree drag-and-drop persists a host-local order and reset restores creation order', async () => {
    const names = ['vscode-order-a', 'vscode-order-b'];
    for (const name of names) await controller.tmux.create(name, directory);
    await controller.manager.refresh(false);
    const root = api.provider.getChildren()[0];
    const items = sessionItems(root);
    const transfer = new vscode.DataTransfer();
    api.provider.handleDrag([items[items.length - 1]], transfer);
    await api.provider.handleDrop(items[0], transfer);
    assert.equal(sessionItems(root)[0].id, items[items.length - 1].id);
    const { SessionOrder } = require('../../src/sessionOrder');
    const reloaded = new SessionOrder(api.provider.order.storage);
    assert.equal(reloaded.sort(host.id, controller.manager.entries)[0].id, items[items.length - 1].entry.id);
    await vscode.commands.executeCommand('remoteAgentSessions.resetOrder', root);
    assert.equal(sessionItems(root)[0].id, items[0].id);
    for (const name of names) await controller.tmux.kill(name);
    await controller.manager.refresh(false);
  });

  await check('Closing the local terminal detaches while remote tmux survives', async () => {
    vscode.window.terminals.find((terminal) => terminal.name === record.title).dispose();
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
    const treeItem = sessionItems(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    assert.equal(treeItem.description, 'rebuild available');
    await controller.manager.restore(entry.record, false);
    assert.equal((await controller.tmux.listWindows(record.tmuxSession)).length, 2);
  });

  await check('Notes and host-aware details persist locally', async () => {
    await controller.manager.setNote(record, '下一步：验证本地控制器');
    await api.provider.refresh(controller, false);
    const hostItem = api.provider.getChildren()[0];
    const item = sessionItems(hostItem).find((candidate) => candidate.entry?.record?.id === record.id);
    await vscode.commands.executeCommand('remoteAgentSessions.showDetails', item);
    const text = vscode.window.activeTextEditor.document.getText();
    assert.match(text, /Local SSH Test Host/);
    assert.match(text, /下一步：验证本地控制器/);
    assert.match(text, /Local metadata/);
  });

  await check('Delete retains recovery and Forget removes saved records', async () => {
    const lifecycle = await controller.manager.create({ title: 'Lifecycle', cwd: directory, host: host.id });
    let entry = controller.manager.entries.find((item) => item.record?.id === lifecycle.id);
    await controller.manager.renameSession(entry, 'Lifecycle renamed', 'vscode-lifecycle-renamed');
    assert.equal(await controller.tmux.exists(lifecycle.tmuxSession), false);
    assert.equal(await controller.tmux.exists('vscode-lifecycle-renamed'), true);
    entry = controller.manager.entries.find((item) => item.record?.id === lifecycle.id);
    await controller.manager.deleteSession(entry);
    assert.equal(await controller.tmux.exists('vscode-lifecycle-renamed'), false);
    assert.equal((await controller.manager.store.load()).some((item) => item.id === lifecycle.id), true);
    await controller.manager.restore(lifecycle, false);
    assert.equal(await controller.tmux.exists('vscode-lifecycle-renamed'), true);
    await controller.manager.deleteSession(lifecycle);
    await controller.manager.forget(lifecycle);

    await controller.tmux.create('vscode-unmanaged', directory);
    await controller.manager.refresh();
    entry = controller.manager.entries.find((item) => item.tmuxSession === 'vscode-unmanaged');
    await controller.manager.renameSession(entry, entry.title, 'vscode-unmanaged-renamed');
    entry = controller.manager.entries.find((item) => item.tmuxSession === 'vscode-unmanaged-renamed');
    await controller.manager.deleteSession(entry);
    assert.equal(await controller.tmux.exists('vscode-unmanaged-renamed'), false);
  });

  await require('./workspace').run(api,controller,check);
  for (const terminal of vscode.window.terminals) terminal.dispose();
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
