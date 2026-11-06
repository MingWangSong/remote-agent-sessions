'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(100); }
  throw new Error('Timed out waiting for native terminal reload');
}
function layout() {
  return vscode.window.tabGroups.all.map(group => ({ active: group.isActive,
    tabs: group.tabs.map(tab => ({ label: tab.label, active: tab.isActive, terminal: tab.input instanceof vscode.TabInputTerminal })) }));
}

exports.run = async () => {
  const directory = path.join(process.env.RAS_TEST_DIRECTORY, 'project');
  const checkpoint = path.join(process.env.RAS_TEST_DIRECTORY, 'reload-state.json');
  const manifest = require('../../package.json');
  const extension = vscode.extensions.getExtension(process.env.RAS_TEST_EXTENSION_ID || `${manifest.publisher}.${manifest.name}`);
  const api = await extension.activate();
  let state = await fs.readFile(checkpoint, 'utf8').then(JSON.parse).catch(() => null);
  const check = async (name, fn) => {
    try { await fn(); }
    catch (error) { throw new Error(name + ': ' + error.stack + '\n' + JSON.stringify({ expected: state.terminals,
      status:api.terminalStatus.text, activeTerminal:vscode.window.activeTerminal?.name, selection:api.view.selection.map(i=>i.entry?.id),
      actual: vscode.window.terminals.map(terminal => ({ name: terminal.name, options: terminal.creationOptions, exit: terminal.exitStatus })), layout: layout() }), { cause: error }); }
    state.checks.push(name); console.log('PASS:', name);
  };
  const terminalNamed = title => vscode.window.terminals.find(terminal => terminal.name === title);
  const entryFor = (controller, id) => controller.manager.entries.find(entry => entry.id === id);
  const reload = async () => {
    // VS Code debounces native terminal layout persistence by 500ms.
    await sleep(1000);
    state.layout = layout();
    state.terminals = await Promise.all(vscode.window.terminals.map(async terminal => ({ name: terminal.name, pid: await terminal.processId })));
    state.previousHostPid = process.pid;
    await fs.writeFile(checkpoint, JSON.stringify(state));
    console.log('RELOAD_PHASE:', state.phase);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    await new Promise(() => {});
  };

  if (!state) {
    state = { phase: 1, checks: [], hosts: [], records: [] };
    for (let i = 0; i < 2; i++) {
      const host = await api.registry.add({ sshHost: `fake-host-${i}`, label: `Reload host ${i}`,
        defaultCwd: directory, tmuxPath: 'tmux', socketName: process.env.RAS_TEST_SOCKET + (i ? '-second' : '') });
      state.hosts.push(host);
    }
    await api.provider.reloadHosts();
    const [first, second] = state.hosts.map(host => api.controllers.find(controller => controller.host.id === host.id));
    for (const [i, controller] of [first, second].entries()) {
      const record = await controller.manager.create({ title: 'Reload task', cwd: directory, command: `printf x >> launch-${i}` });
      state.records.push(record);
      await waitFor(async () => (await fs.readFile(path.join(directory, `launch-${i}`), 'utf8').catch(() => '')) === 'x');
    }
    await fs.writeFile(path.join(directory, 'keep.txt'), 'ordinary editor keeps its position\n');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(directory, 'keep.txt')), { preview: false });
    await api.attachEntry(first, entryFor(first, state.records[0].id));
    await vscode.commands.executeCommand('workbench.action.newGroupRight');
    await api.attachEntry(second, entryFor(second, state.records[1].id));
    state.secondName = 'Reload task · 2';
    await waitFor(() => Boolean(terminalNamed(state.secondName)));
    const panelRecord = await first.manager.create({ title: 'Panel task', cwd: directory });
    state.panelRecord = panelRecord;
    const panelController = { ...first, configuration: { get: (key, fallback) => key === 'sessionTerminalLocation' ? 'panel' : first.configuration.get(key, fallback) } };
    await api.attachEntry(panelController, entryFor(first, panelRecord.id));
    const closed = await first.manager.create({ title: 'Closed before reload', cwd: directory });
    await api.attachEntry(first, entryFor(first, closed.id));
    terminalNamed(closed.title).dispose();
    await waitFor(() => !terminalNamed(closed.title));
    state.closed = closed;
    const ordinary = vscode.window.createTerminal({ name: 'Ordinary persistent terminal', shellPath: '/bin/sh',
      location: { viewColumn: vscode.ViewColumn.One }, isTransient: false });
    ordinary.show();
    // Terminal.show queues a workbench focus request. Wait until that request
    // has completed before issuing a second focus request for another editor.
    await waitFor(() => vscode.window.activeTerminal === ordinary &&
      vscode.window.tabGroups.activeTabGroup.activeTab?.label === ordinary.name);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    terminalNamed(state.secondName).show();
    try {
      await waitFor(() => api.terminalStatus.text.includes(second.host.label));
    } catch(error) {
      throw new Error(error.message + '\n' + JSON.stringify({status:api.terminalStatus.text,
        activeTerminal:vscode.window.activeTerminal?.name,layout:layout()}));
    }
    await waitFor(async () => (await first.tmux.list()).find(session => session.name === state.records[0].tmuxSession)?.attached === 1);
    await waitFor(async () => (await second.tmux.list()).find(session => session.name === state.records[1].tmuxSession)?.attached === 1);
    await reload();
  }

  const [first, second] = state.hosts.map(host => api.controllers.find(controller => controller.host.id === host.id));
  await check(`reload ${state.phase}: native terminals keep their process IDs, names, order, groups and selected tab`, async () => {
    assert.notEqual(process.pid, state.previousHostPid, 'a real extension host restart must have occurred');
    await waitFor(() => state.terminals.every(saved => terminalNamed(saved.name)));
    const actual = await Promise.all(vscode.window.terminals.map(async terminal => ({ name: terminal.name, pid: await terminal.processId })));
    const byName = (a, b) => a.name.localeCompare(b.name);
    assert.deepEqual(actual.sort(byName), [...state.terminals].sort(byName), 'native API enumeration may reorder panel terminals; process identities must remain unchanged');
    await waitFor(() => JSON.stringify(layout()) === JSON.stringify(state.layout));
    assert.deepEqual(layout(), state.layout);
    assert.equal(terminalNamed('Closed before reload'), undefined);
  });
  await check(`reload ${state.phase}: original sessions survive and startup commands are not repeated`, async () => {
    for (let i = 0; i < 2; i++) {
      const record = state.records[i]; const controller = i ? second : first;
      assert.equal(await fs.readFile(path.join(directory, `launch-${i}`), 'utf8'), 'x');
      const live = (await controller.tmux.list()).find(session => session.name === record.tmuxSession);
      assert.equal(live.owner, record.id);
      assert.equal(live.attached, i === 0 && state.phase === 2 ? 0 : 1);
    }
  });

  if (state.phase === 1) {
    await check('reloaded same-name terminal restores host status, sidebar selection and local reuse', async () => {
      await waitFor(() => api.terminalStatus.text.includes(second.host.label));
      await vscode.commands.executeCommand('remoteAgentSessions.sessions.focus');
      await waitFor(() => api.view.visible);
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      terminalNamed('Reload task').show(false);
      await waitFor(() => api.terminalStatus.text.includes(first.host.label));
      await waitFor(() => api.view.selection[0]?.entry?.id === state.records[0].id);
      const originalList = second.tmux.list; const count = vscode.window.terminals.length;
      second.tmux.list = async () => { throw new Error('Reusing a restored terminal must not query SSH'); };
      try { await api.attachEntry(second, entryFor(second, state.records[1].id)); }
      finally { second.tmux.list = originalList; }
      assert.equal(vscode.window.terminals.length, count);
      await waitFor(() => api.terminalStatus.text.includes(second.host.label));
      await waitFor(() => api.view.selection[0]?.entry?.id === state.records[1].id);
      terminalNamed('Panel task').show();
      await waitFor(() => api.terminalStatus.text.includes(first.host.label));
      await vscode.commands.executeCommand('workbench.action.closePanel');
    });
    terminalNamed('Reload task').dispose();
    await waitFor(() => !terminalNamed('Reload task'));
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(directory, 'keep.txt')), { viewColumn: vscode.ViewColumn.One, preview: false });
    await waitFor(() => api.terminalStatus.text === '');
    state.phase = 2;
    await reload();
  }

  await check('second reload keeps the ordinary file selected and does not resurrect a closed session tab', async () => {
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.label, 'keep.txt');
    assert.equal(api.terminalStatus.text, '');
    assert.equal(terminalNamed('Reload task'), undefined);
    const count = vscode.window.terminals.length;
    await api.attachEntry(second, entryFor(second, state.records[1].id));
    assert.equal(vscode.window.terminals.length, count);
    await waitFor(() => api.terminalStatus.text.includes(second.host.label));
  });
  for (const terminal of vscode.window.terminals) terminal.dispose();
  for (const controller of [first, second]) {
    await controller.tmux.run(['kill-server'], { allowNoServer: true });
    await api.registry.remove(controller.host.id);
  }
  await fs.mkdir(path.dirname(process.env.RAS_TEST_REPORT), { recursive: true });
  await fs.writeFile(process.env.RAS_TEST_REPORT, JSON.stringify({ passed: state.checks.length, checks: state.checks, reloads: 2 }, null, 2));
};
