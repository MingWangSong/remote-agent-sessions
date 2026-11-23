'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setImmediate: tick } = require('node:timers/promises');

function fixture() {
  const panels = [];
  const vscode = {
    ViewColumn: { Active: -1 }, workspace: { isTrusted: true },
    window: {
      registerWebviewPanelSerializer() { return { dispose() {} }; },
      createWebviewPanel(_type, title) {
        let onMessage, onDispose;
        const panel = {
          title,
          webview: { onDidReceiveMessage(fn) { onMessage = fn; } },
          onDidDispose(fn) { onDispose = fn; }, onDidChangeViewState() {},
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
  const previews = new module.exports.HtmlPreviews({ context: { subscriptions: [] } });
  previews.load = async item => previews.empty(item, 'Loading remote preview');
  const context = { root: '/work', controller: { host: { id: 'host' } }, entry: { id: 'session' } };
  const open = name => previews.open({ authority: 'host', path: '/work/' + name }, context);
  return { previews, panels, open };
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
