'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Inspect the rendered workbench in this isolated test instance. The public
// terminal API exposes neither restored icons nor an icon update method.
async function inspectIcons() {
  const targets = await fetch(`http://127.0.0.1:${process.env.RAS_TEST_DEBUG_PORT}/json/list`).then(r => r.json());
  const page = targets.find(target => target.type === 'page' && target.url.includes('workbench'));
  assert.ok(page, 'isolated VS Code workbench must be inspectable');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out inspecting icon DOM')), 10000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id === 1) { clearTimeout(timeout); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); }
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: true,
        expression: `(async () => {
          await document.fonts.ready;
          return [...document.querySelectorAll('.tabs-container .tab')].map(tab => ({
            label: tab.textContent, aria: tab.getAttribute('aria-label'),
            theme: document.querySelector('.monaco-workbench').classList.contains('vs') ? 'light' :
              document.querySelector('.monaco-workbench').classList.contains('vs-dark') ? 'dark' : 'other',
            icons: [...tab.querySelectorAll('[class*="codicon-"]')].map(icon => {
              const style = getComputedStyle(icon, '::before');
              const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
              const context = canvas.getContext('2d');
              context.font = '40px ' + style.fontFamily; context.fillStyle = '#123456';
              context.fillText(style.content.replace(/^"|"$/g, ''), 2, 36);
              const pixels = context.getImageData(0, 0, 48, 48).data;
              let brandPixels = 0, inkPixels = 0;
              for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i+3] > 200) inkPixels++;
                if (pixels[i] === 217 && pixels[i+1] === 119 && pixels[i+2] === 87 && pixels[i+3] > 200) brandPixels++;
              }
              return { classes: icon.className, font: style.fontFamily, content: style.content, color: style.color,
                brandPixels, inkPixels,
                loaded: document.fonts.check('16px ' + style.fontFamily) };
            })
          }));
        })()` } }));
    });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  } finally { socket.close(); }
}

exports.run = async () => {
  const checkpoint = path.join(process.env.RAS_TEST_DIRECTORY, 'icons-state.json');
  const manifest = require('../../package.json');
  const api = await vscode.extensions.getExtension(process.env.RAS_TEST_EXTENSION_ID || `${manifest.publisher}.${manifest.name}`).activate();
  let state = await fs.readFile(checkpoint, 'utf8').then(JSON.parse).catch(() => null);
  if (!state) {
    const host = await api.registry.add({ sshHost: 'fake-host', label: 'Icon persistence test',
      defaultCwd: path.join(process.env.RAS_TEST_DIRECTORY, 'project'), tmuxPath: 'tmux', socketName: process.env.RAS_TEST_SOCKET });
    await api.provider.reloadHosts();
    const controller = api.controllers.find(controller => controller.host.id === host.id);
    for (const type of ['codex', 'claude', 'shell']) {
      const record = await controller.manager.create({ title: `Icon ${type}`, cwd: host.defaultCwd });
      const entry = controller.manager.entries.find(entry => entry.id === record.id);
      // Choose the display type without starting an agent or making model calls.
      if (type !== 'shell') entry.record.agent = { type };
      await api.attachEntry(controller, entry);
    }
    await fs.writeFile(path.join(host.defaultCwd, 'inactive-icons.txt'), 'Leave agent tabs inactive during restore.\n');
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(host.defaultCwd, 'inactive-icons.txt')), { preview: false });
    state = { phase: 0, checks: [], host };
  }

  const fullRestart = Boolean(process.env.RAS_TEST_FULL_RESTART);
  const stages = fullRestart ? ['before reload', 'after reload', 'after full app restart', 'after reload following full restart']
    : ['before reload', 'after first reload', 'after second reload'];
  // Keep every inactive test tab visible in small Xvfb workbenches. A clipped
  // or virtualized tab is not evidence that its contributed glyph is missing.
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  for (const [theme, label] of [['Default Dark Modern', 'dark'], ['Default Light Modern', 'light']]) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    let tabs;
    for (let attempt = 0; attempt < 100; attempt++) {
      tabs = await inspectIcons();
      if (tabs.every(tab => tab.theme === label) && ['codex', 'claude'].every(type => tabs.find(tab => tab.label.includes(`Icon ${type}`))?.icons.some(icon =>
        icon.classes.includes(`codicon-tmuxdock-${type}`) && icon.loaded && icon.font.includes('session-marks.woff')))) break;
      await sleep(100);
    }
    for (const [type, character] of [['codex', '\ue001'], ['claude', '\ue002']]) {
      const tab = tabs.find(tab => tab.label.includes(`Icon ${type}`));
      assert.equal(tab?.theme, label, `${stages[state.phase]} / ${label}: requested theme and tab must render: ${JSON.stringify({tabs:tabs.map(t=>t.label), terminals:vscode.window.terminals.map(t=>t.name)})}`);
      const icon = tab?.icons.find(icon => icon.classes.includes(`codicon-tmuxdock-${type}`));
      assert.ok(icon, `${stages[state.phase]} / ${label}: missing ${type} icon: ${JSON.stringify(tabs)}`);
      assert.ok(icon.font.includes('session-marks.woff'), JSON.stringify(icon));
      assert.ok(icon.loaded, 'actual contributed font must load');
      assert.equal(icon.content.replace(/^"|"$/g, ''), character);
      assert.ok(icon.inkPixels > 100, 'official glyph must contain visible outlines');
      if (type === 'claude') assert.ok(icon.brandPixels > 100, 'Claude glyph must retain official terracotta pixels');
    }
    assert.ok(tabs.find(tab => tab.label.includes('Icon shell'))?.icons.some(icon => icon.classes.includes('codicon-terminal')));
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.label, 'inactive-icons.txt');
    state.checks.push(`${stages[state.phase]} / ${label}: official Codex, Claude and shell icons render with loaded fonts`);
  }

  if (state.phase < stages.length - 1) {
    state.phase++;
    await fs.writeFile(checkpoint, JSON.stringify(state));
    await sleep(1500);
    if (fullRestart && state.phase === 2) return true; // driver quits; harness launches the same profile afresh
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    await new Promise(() => {});
  }
  const controller = api.controllers.find(controller => controller.host.id === state.host.id);
  for (const terminal of vscode.window.terminals) terminal.dispose();
  await controller.tmux.run(['kill-server'], { allowNoServer: true });
  await fs.mkdir(path.dirname(process.env.RAS_TEST_REPORT), { recursive: true });
  await fs.writeFile(process.env.RAS_TEST_REPORT, JSON.stringify({ passed: state.checks.length, checks: state.checks,
    reloads: 2, fullRestarts: fullRestart ? 1 : 0 }, null, 2));
  return false;
};
