'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

exports.run = async function () {
  const api = await vscode.extensions.getExtension(process.env.RAS_TEST_EXTENSION_ID).activate();
  const testDirectory = process.env.RAS_TEST_DIRECTORY;
  const socket = process.env.RAS_TEST_SOCKET;
  const root = path.join(testDirectory, 'project');
  const htmlPath = path.join(root, 'report.html');
  const markdownPath = path.join(root, 'notes.md');
  const offline = path.join(testDirectory, 'ssh-offline');
  const outageTest = path.join(testDirectory, 'ssh-outage-test');
  await fs.writeFile(htmlPath, '<!doctype html><h1>Retained preview</h1><link rel="stylesheet" href="style.css">');
  await fs.writeFile(path.join(root, 'style.css'), 'h1{color:blue}');
  await fs.writeFile(path.join(root, 'draft.txt'), 'Original text');
  await fs.writeFile(markdownPath, '# Before outage');
  const host = await api.registry.add({ sshHost: 'fake-host', label: 'Outage fixture', defaultCwd: root, socketName: socket });
  await api.provider.reloadHosts();
  const controller = api.controllers.find(candidate => candidate.host.id === host.id);
  const record = await controller.manager.create({ title: 'reconnect-fixture', cwd: root });
  const entry = controller.manager.entries.find(candidate => candidate.id === record.id);
  const files = api.sessionWorkspace;
  files.select(controller, entry, true);
  const nodes = await files.getChildren(files.rootItem());
  await files.openFile(nodes.find(node => node.name === 'draft.txt'));
  const draft = vscode.window.activeTextEditor;
  assert.equal(draft.document.uri.path, path.join(root, 'draft.txt'));
  await draft.edit(builder => builder.insert(new vscode.Position(0, 0), 'Unsaved '));
  const html = await files.preview(nodes.find(node => node.name === 'report.html'));
  const browser = await files.previews.openBrowser(html);
  const events = new Map([[html, []], [browser, []]]);
  const needsReload = new Set();
  for (const item of events.keys()) {
    item.server.on('interrupted', () => needsReload.add(item));
    item.server.on('change', () => needsReload.add(item));
  }
  const originalSend = files.previews.send;
  files.previews.send = function (item, message) {
    events.get(item)?.push(message);
    return originalSend.call(this, item, message);
  };
  const layout = () => vscode.window.tabGroups.all.map(group =>
    [group.viewColumn, group.tabs.map(tab => [tab.label, tab.input?.uri?.toString()])]);
  const tmux = (...args) => execFileSync(process.env.RAS_TMUX || 'tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
  const records = [record];
  const terminals = [];
  const attached = () => records.every(item => Number(tmux('display-message', '-t', item.tmuxSession, '-p', '#{session_attached}')) === 1);
  try {
    await waitFor(() => [...events.keys()].every(item =>
      item.server.rendered.has(htmlPath) && item.server.rendered.has(path.join(root, 'style.css'))), 'both HTML pages to load');
    await fs.writeFile(outageTest, '');
    await vscode.commands.executeCommand('workbench.action.newGroupRight');
    await api.attachEntry(controller, entry);
    terminals.push(vscode.window.terminals.find(candidate => candidate.name === record.title));
    for (let index = 1; index <= 2; index++) {
      const other = await controller.manager.create({ title: 'reconnect-fixture-' + index, cwd: root });
      records.push(other);
      if (index === 1) await vscode.commands.executeCommand('workbench.action.newGroupRight');
      await api.attachEntry(controller, controller.manager.entries.find(candidate => candidate.id === other.id));
      terminals.push(vscode.window.terminals.find(candidate => candidate.name === other.title));
    }
    const pids = await Promise.all(terminals.map(terminal => terminal.processId));
    await waitFor(attached, 'initial tmux attach');
    const markdown = nodes.find(node => node.name === 'notes.md');
    await vscode.commands.executeCommand('remoteAgentSessions.previewMarkdown', markdown);
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.viewType === 'vscode.markdown.preview.editor', 'native markdown');
    const native = vscode.window.tabGroups.activeTabGroup.activeTab;
    const before = layout();
    assert.equal(before.length, 3);
    const service = files.service(controller);
    await waitFor(() => [...service.watches.values()].some(watch => watch.file === markdownPath && watch.signature), 'initial markdown watch');
    await waitFor(() => [...events.keys()].every(item => !item.timer), 'initial preview updates');
    for (const history of events.values()) history.length = 0;
    needsReload.clear();
    await fs.writeFile(offline, '');
    for (const item of records) tmux('detach-client', '-s', item.tmuxSession);
    service.channel.child?.kill();
    await waitFor(() => [...events.values()].every(history => history.includes('offline')), 'both preview notices');
    assert.match(files.fileConnection.text, /Reconnecting/);
    await waitFor(() => fs.stat(offline + '-retry').then(() => true, () => false), 'a retry while still offline');
    for (const terminal of terminals) assert.equal(terminal.exitStatus, undefined);
    assert.deepEqual(layout(), before);
    for (const history of events.values()) assert.ok(!history.includes('reload'));
    await fs.writeFile(markdownPath, '# Updated during SSH outage');
    await fs.rm(offline);
    await waitFor(() => [...events.values()].every(history => history.includes('online')), 'preview recovery');
    await waitFor(attached, 'reattach to original tmux session');
    await waitFor(() => vscode.workspace.textDocuments.some(document =>
      document.uri.toString() === native.input.uri.toString() && document.getText().includes('Updated during SSH outage')), 'Markdown recovery update');
    assert.deepEqual(await Promise.all(terminals.map(terminal => terminal.processId)), pids);
    assert.equal(draft.document.isDirty, true);
    assert.equal(draft.document.getText(), 'Unsaved Original text');
    assert.equal(await fs.readFile(path.join(root, 'draft.txt'), 'utf8'), 'Original text');
    assert.deepEqual(layout(), before);
    for (const [item, history] of events) assert.ok(!history.includes('reload') || needsReload.has(item),
      'A recovered preview may reload only for a changed resource or an interrupted request');
    const result = 'SSH outage retained three terminal PIDs, tab order and three editor groups, HTML, Browser and Markdown tabs, and unsaved native file edits. All connections recovered automatically.';
    console.log('PASS:', result);
    await fs.mkdir(path.dirname(process.env.RAS_TEST_REPORT), { recursive: true });
    await fs.writeFile(process.env.RAS_TEST_REPORT, JSON.stringify({ vscode: vscode.version, result }, null, 2));
  } finally {
    await fs.rm(offline, { force: true });
    await fs.rm(outageTest, { force: true });
    files.previews.send = originalSend;
    html.panel.dispose();
    browser.panel.dispose();
    for (const terminal of terminals) terminal?.dispose();
  }
};
