'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { hostKey } = require('./sessionFileRoots');

class SessionOrderPanels {
  constructor(extensionUri, provider) {
    this.media = vscode.Uri.joinPath(extensionUri, 'media');
    this.provider = provider;
    this.panels = new Map();
  }

  open(controller) {
    const key = hostKey(controller.host);
    const existing = this.panels.get(key);
    if (existing) return existing.reveal();
    const panel = vscode.window.createWebviewPanel('tmuxdock.sessionOrder',
      `Reorder Sessions · ${controller.host.label}`, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [this.media] });
    this.panels.set(key, panel);
    const currentHost = () => this.provider.controllers.find(item => hostKey(item.host) === key);
    let lastLayout;
    let ready = false;
    const publish = (done = false, message = '') => {
      if (!ready) return;
      const current = currentHost();
      const sections = current ? this.provider.orderSections(current) : [];
      const layout = JSON.stringify(sections);
      if (!done && lastLayout === layout) return;
      lastLayout = layout;
      void panel.webview.postMessage({ type: 'layout', sections, done,
        message: message || (current ? '' : 'This host is no longer configured.') });
    };
    const changes = this.provider.onDidChangeTreeData(() => publish());
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready') {
        ready = true;
        publish(true);
      } else if (message?.type === 'move') {
        const current = currentHost();
        try {
          const saved = current && await this.provider.reorder(current, message);
          publish(true, saved ? '' : 'The list changed. Choose a position and try again.');
        } catch (error) {
          publish(true, `Could not save the order. ${error.message}`);
        }
      }
    });
    panel.onDidDispose(() => {
      changes.dispose();
      messages.dispose();
      this.panels.delete(key);
    });

    const nonce = randomBytes(16).toString('base64');
    const asset = name => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.media, name));
    panel.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'">
  <link rel="stylesheet" href="${asset('sessionOrder.css')}">
  <title>Reorder Sessions</title>
</head>
<body>
  <main>
    <p>Drag a session or category to the line where it should appear.</p>
    <div id="sections"></div>
    <output id="status" role="status"></output>
  </main>
  <script nonce="${nonce}" src="${asset('sessionOrder.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

module.exports = { SessionOrderPanels };
