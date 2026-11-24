'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setImmediate: tick } = require('node:timers/promises');
const { EventEmitter } = require('node:events');

function fixture() {
  const panels = [];
  const external = [];
  const vscode = {
    ViewColumn: { Active: -1 }, workspace: { isTrusted: true },
    Uri: { parse: text => new URL(text) },
    env: { async openExternal(uri) { external.push(uri.toString()); return true; } },
    window: {
      registerWebviewPanelSerializer() { return { dispose() {} }; },
      createWebviewPanel(_type, title) {
        let onMessage, onDispose;
        const panel = {
          title,
          webview: { onDidReceiveMessage(fn) { onMessage = fn; } },
          onDidDispose(fn) { onDispose = fn; }, onDidChangeViewState() {},
          receive: message => onMessage(message),
          dispose() { onDispose(); },
          render() {
            const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/)[1];
            vm.runInNewContext(script, { acquireVsCodeApi: () => ({
              setState(state) { panel.savedState = state; }, postMessage: message => onMessage(message),
            }) });
          },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const filename = require.resolve('../src/htmlPreviews');
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
    name => name === 'vscode' ? vscode : name.startsWith('./') ? require('../src/' + name.slice(2)) : require(name), module, module.exports,
  );
  const context = { root: '/work', controller: { host: { id: 'host' } }, entry: { id: 'session' } };
  const workspace = { context: { subscriptions: [] }, provider: { controllers: [context.controller] },
    fileRoots: { find: () => context } };
  const previews = new module.exports.HtmlPreviews(workspace);
  previews.load = async item => previews.empty(item, 'Loading remote preview');
  const open = name => previews.open({ authority: 'host', path: '/work/' + name }, context);
  return { previews, panels, open, external, vscode, workspace };
}

async function loaded(f, name = '资料 #1.html') {
  const opening = f.open(name);
  await tick();
  f.panels.at(-1).render();
  const item = await opening;
  const server = new EventEmitter();
  server.url = file => 'http://fixture.localhost:1234/' + file.slice('/work/'.length).split('/').map(encodeURIComponent).join('/');
  server.dispose = () => { server.disposed = true; server.removeAllListeners(); };
  item.server = server;
  item.url = server.url(item.state.file);
  return item;
}

test('rapid preview opens save each native webview identity before the next tab can hide it', async () => {
  const { previews, panels, open } = fixture();
  const first = open('first.html');
  const second = open('second.html');
  await tick();
  assert.equal(panels.length, 1);
  assert.equal(panels[0].savedState, undefined);
  panels[0].render();
  await first;
  await tick();
  assert.equal(panels.length, 2);
  assert.equal(panels[0].savedState.file, '/work/first.html');
  panels[1].render();
  await second;
  assert.equal(panels[1].savedState.file, '/work/second.html');
  assert.equal(panels[1].savedState.sessionId, 'session');
  previews.dispose();
});

test('disposing previews releases a pending renderer confirmation without creating queued tabs', async () => {
  const { previews, panels, open } = fixture();
  const first = open('first.html');
  const second = open('second.html');
  const rejected = assert.rejects(second, /previews are closed/);
  await tick();
  previews.dispose();
  assert.equal((await first).closed, true);
  await rejected;
  assert.equal(panels.length, 1);
});

test('Browser button uses the system opener with an encoded localhost URL and keeps that endpoint after closing its editor', async () => {
  const f = fixture(), item = await loaded(f), server = item.server;
  await item.panel.receive({ type: 'browser' });
  assert.deepEqual(f.external, ['http://fixture.localhost:1234/%E8%B5%84%E6%96%99%20%231.html']);
  assert.equal(f.panels.length, 1, 'Browser must not create another VS Code tab');
  assert.equal(f.previews.externalServers.size, 1);
  item.panel.dispose();
  assert.equal(server.disposed, undefined, 'the external browser still needs the localhost server');
  f.previews.dispose();
  assert.equal(server.disposed, true, 'window shutdown releases the retained server');
});

test('a failed default browser launch is retryable and does not retain an unused endpoint', async () => {
  const f = fixture(), item = await loaded(f), server = item.server;
  f.vscode.env.openExternal = async () => false;
  await assert.rejects(f.previews.openBrowser(item), /default browser could not be opened/);
  assert.equal(f.previews.externalServers.size, 0);
  assert.equal(server.disposed, undefined, 'the original preview must keep working');
  f.vscode.env.openExternal = async () => true;
  await f.previews.openBrowser(item);
  f.vscode.env.openExternal = async () => false;
  await assert.rejects(f.previews.openBrowser(item), /default browser could not be opened/);
  assert.equal(f.previews.externalServers.size, 1, 'a failed second launch cannot revoke the first browser tab');
  f.previews.dispose();
});

test('unlinking a directory or disabling Session Files revokes retained external browser endpoints', async () => {
  for (const action of ['unlink', 'disable']) {
    const f = fixture(), item = await loaded(f), server = item.server;
    await f.previews.openBrowser(item);
    item.panel.dispose();
    if (action === 'unlink') {
      f.workspace.fileRoots.find = () => null;
      f.previews.reconcile();
    } else f.previews.suspend();
    assert.equal(f.previews.externalServers.size, 0);
    assert.equal(server.disposed, true);
    f.previews.dispose();
  }
});

test('closing a preview while the system opener is pending does not leak a failed launch', async () => {
  const f = fixture(), item = await loaded(f), server = item.server;
  f.vscode.env.openExternal = async () => { item.panel.dispose(); throw new Error('Launch interrupted'); };
  await assert.rejects(f.previews.openBrowser(item), /Launch interrupted/);
  assert.equal(f.previews.externalServers.size, 0);
  assert.equal(server.disposed, true);
  f.previews.dispose();
});
