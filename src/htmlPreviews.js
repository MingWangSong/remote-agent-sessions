"use strict";
const vscode = require("vscode");
const path = require("node:path").posix;
const { randomBytes } = require("node:crypto");
const { relative } = require("./remoteFiles");
const { PreviewServer } = require("./previewService");
const { installPreviewCopy } = require("./previewClipboard");
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Each tab owns its page and HTTP origin. SSH reads/watches remain shared by host.
class HtmlPreviews {
  constructor(workspace) {
    this.workspace = workspace;
    this.items = new Set();
    this.externalServers = new Map();
    this.opening = Promise.resolve();
    workspace.context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer("tmuxdock.preview", {
        deserializeWebviewPanel: async (panel, state) => {
          await workspace.ready;
          if (workspace.disposed) return;
          const c = workspace.provider.controllers.find(
            (c) => c.host.id === state?.hostId,
          );
          const target = workspace.fileRoots.find(c, state?.sessionId);
          const item = this.attach(panel, state);
          if (!target || target.root !== state?.root) {
            this.empty(item, "This session directory is no longer linked.");
            return;
          }
          item.context = target;
          try {
            await this.load(item);
          } catch (error) {
            this.empty(item, error.message);
          }
        },
      }),
    );
  }
  attach(panel, state, context) {
    let resolveStateReady;
    const stateReady = new Promise(resolve => { resolveStateReady = resolve; });
    const item = {
      panel,
      state,
      context,
      token: randomBytes(16).toString("hex"),
      closed: false,
      stateReady,
      resolveStateReady,
    };
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.items.add(item);
    this.active = item;
    panel.onDidDispose(() => {
      item.closed = true;
      item.resolveStateReady(false);
      this.stop(item);
      this.items.delete(item);
      if (this.active === item)
        this.active = [...this.items].find((i) => i.panel.active);
    });
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = item;
        if (item.context)
          this.workspace.select(item.context.controller, item.context.entry);
      }
    });
    panel.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message?.type === "ready" && message.token === item.token) {
          item.resolveStateReady(true);
          return;
        }
        if (message?.type === "refresh") {
          if (!item.context) return;
          const files = this.workspace.service(item.context.controller);
          if (item.server && !item.server.unavailable) this.send(item, "reload");
          files.retryNow();
          if (item.server) return;
          await this.load(item);
        }
        if (message?.type === "browser") await this.openBrowser(item);
      } catch (error) {
        vscode.window.showErrorMessage("TmuxDock preview: " + error.message);
      }
    });
    return item;
  }
  open(resource, context, browser = false) {
    // A newly hidden webview may not execute its initial setState script.
    // Confirm that the renderer saved its identity before creating the next
    // preview, so rapid opens and Reload Window retain every independent tab.
    const pending = this.opening.then(() => this.create(resource, context, browser));
    this.opening = pending.catch(() => {});
    return pending;
  }
  async create(resource, context, browser = false) {
    if (this.disposed) throw new Error("HTML previews are closed");
    if (
      !context?.root ||
      resource.authority !== context.controller.host.id ||
      !/\.html?$/i.test(resource.path)
    )
      throw new Error("Select an HTML file in a linked session directory");
    relative(context.root, resource.path);
    if (!vscode.workspace.isTrusted)
      throw new Error("HTML preview requires a trusted workspace");
    const panel = vscode.window.createWebviewPanel(
      "tmuxdock.preview",
      (browser ? "Browser · " : "Preview · ") + path.basename(resource.path),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    const item = this.attach(
      panel,
      {
        hostId: context.controller.host.id,
        sessionId: context.entry.id,
        root: context.root,
        file: resource.path,
        ...(browser ? { browser: true } : {}),
      },
      context,
    );
    await this.load(item);
    let timer;
    try {
      await Promise.race([item.stateReady, new Promise(resolve => {
        timer = setTimeout(resolve, 3000);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
    return item;
  }
  async load(item) {
    if (item.closed) return;
    if (!vscode.workspace.isTrusted)
      throw new Error("HTML preview requires a trusted workspace");
    this.stop(item);
    this.empty(item, "Loading remote preview…");
    const c = item.context;
    relative(c.root, item.state.file);
    const files = this.workspace.service(c.controller);
    const server = new PreviewServer(
      files,
      c.root,
      { clipboard: true },
    );
    let reloadAfterReconnect = false;
    server.unavailable = files.isOffline(c.root);
    server.on("interrupted", () => { reloadAfterReconnect = true; });
    server.on("change", () => {
      clearTimeout(item.timer);
      item.timer = setTimeout(() => {
        item.timer = null;
        if (server.unavailable) reloadAfterReconnect = true;
        else this.send(item, "reload");
      }, 300);
    });
    server.on("offline", () => this.send(item, "offline"));
    server.on("online", () => {
      this.send(item, "online");
      if (reloadAfterReconnect) {
        reloadAfterReconnect = false;
        this.send(item, "reload");
      }
    });
    try {
      await server.start(item.state.file);
    } catch (error) {
      server.dispose();
      if (!item.closed) this.empty(item, error.message);
      throw error;
    }
    if (item.closed) {
      server.dispose();
      return;
    }
    item.server = server;
    item.url = server.url(item.state.file);
    const nonce = item.token;
    item.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src ${server.origin};">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:var(--vscode-font-size,12px) var(--vscode-font-family,sans-serif)}
header{height:34px;display:flex;align-items:center;gap:10px;padding:0 12px}
span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--vscode-widget-border,transparent);border-radius:3px;padding:3px 7px;cursor:pointer}
button:hover{background:var(--vscode-toolbar-hoverBackground)}
iframe{width:100%;height:calc(100% - 34px);border:0}
#connection{position:absolute;top:44px;right:12px;max-width:calc(100% - 48px);padding:8px 12px;border:1px solid var(--vscode-notifications-border);border-radius:4px;background:var(--vscode-notifications-background);color:var(--vscode-notifications-foreground);box-shadow:0 2px 8px var(--vscode-widget-shadow);pointer-events:none}
#connection[data-state="offline"]{border-color:var(--vscode-notificationsWarningIcon-foreground)}
</style></head><body>
<header><span title="${escape(item.state.file)}">${escape(c.controller.host.label)} · ${escape(c.record?.title || c.entry.title)} · ${escape(item.state.file)}</span>
<button id="refresh" title="Reload this preview or retry its connection">Refresh</button>
<button id="browser" title="Open in your default browser">Browser</button></header>
<iframe id="page" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" src="${escape(item.url)}"></iframe>
<div id="connection" role="status" aria-live="polite" ${server.unavailable ? 'data-state="offline"' : 'hidden'}>${server.unavailable ? "Disconnected · reconnecting automatically" : ""}</div>
<script nonce="${nonce}">
(${installPreviewCopy.toString()})(${JSON.stringify(server.origin)});
const api=acquireVsCodeApi();
api.setState(${JSON.stringify(item.state).replace(/</g, "\\u003c")});
api.postMessage({type:'ready',token:${JSON.stringify(nonce)}});
for(const id of ['refresh','browser']) {
  const button=document.getElementById(id);
  if(button) button.onclick=()=>api.postMessage({type:id});
}
const status=document.getElementById('connection');
let timer;
window.addEventListener('message',e=>{
  const m=e.data;
  if(m?.token!==${JSON.stringify(nonce)})return;
  if(m.type==='reload'){
    const frame=document.getElementById('page');
    frame.src=frame.src;
  } else if (m.type==='online'||m.type==='offline') {
    clearTimeout(timer);
    status.dataset.state=m.type;
    status.textContent=m.type==='offline'?'Disconnected · reconnecting automatically':'Reconnected';
    status.hidden=false;
    if(m.type==='online')timer=setTimeout(()=>{status.hidden=true;},2500);
  }
});
</script></body></html>`;
  }
  send(item, type) {
    if (!item.closed)
      return item.panel.webview.postMessage({ type, token: item.token });
  }
  empty(item, message) {
    if (item.closed) return;
    const nonce = item.token;
    item.panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head><body style="font:14px sans-serif;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px">${escape(message)}<script nonce="${nonce}">const api=acquireVsCodeApi();api.setState(${JSON.stringify(item.state || null).replace(/</g, "\\u003c")});api.postMessage({type:'ready',token:${JSON.stringify(nonce)}});</script></body></html>`;
  }
  stop(item) {
    clearTimeout(item.timer);
    item.timer = null;
    if (item.server && this.externalServers.has(item.server)) item.server.removeAllListeners();
    else item.server?.dispose();
    item.server = null;
    item.url = null;
  }
  refresh() {
    for (const item of this.items)
      if (item.server && !item.server.unavailable) this.send(item, "reload");
  }
  suspend() {
    this.disposeExternal();
    for (const item of this.items) {
      this.stop(item);
      this.empty(item, "Session Files is disabled.");
    }
  }
  reconcile() {
    for (const [server, state] of this.externalServers) {
      const controller = this.workspace.provider.controllers.find(c => c.host.id === state.hostId);
      const target = this.workspace.fileRoots.find(controller, state.sessionId);
      if (!target || target.root !== state.root) {
        server.dispose();
        this.externalServers.delete(server);
      }
    }
    for (const item of this.items) {
      const c = this.workspace.provider.controllers.find(
        (c) => c.host.id === item.state?.hostId,
      );
      const target = this.workspace.fileRoots.find(c, item.state?.sessionId);
      if (item.server && (!target || target.root !== item.state.root)) {
        this.stop(item);
        this.empty(item, "This session directory is no longer linked.");
      }
    }
  }
  async retarget(hostId, source, destination) {
    for (const item of this.items) {
      if (
        item.state?.hostId === hostId &&
        (item.state.file === source || item.state.file.startsWith(source + "/"))
      ) {
        item.state.file = destination + item.state.file.slice(source.length);
        item.panel.title = (item.state.browser ? "Browser · " : "Preview · ") + path.basename(item.state.file);
        try {
          await this.load(item);
        } catch (error) {
          this.empty(item, error.message);
        }
      }
    }
  }
  async openBrowser(item = this.active) {
    if (!item?.server || !item.context || item.closed)
      throw new Error("Open an HTML preview before opening it in your browser");
    if (!vscode.workspace.isTrusted)
      throw new Error("HTML preview requires a trusted workspace");
    const server = item.server;
    const retained = this.externalServers.has(server);
    // Keep the scoped localhost endpoint usable after its editor tab closes.
    // No remote listener or downloaded single-file copy is needed.
    this.externalServers.set(server, { ...item.state });
    try {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(server.url(item.state.file)));
      if (!opened) throw new Error("Your default browser could not be opened. Try Browser again");
      return opened;
    } catch (error) {
      if (!retained) {
        this.externalServers.delete(server);
        if (item.closed || item.server !== server) server.dispose();
      }
      throw error;
    }
  }
  // Retain support for existing Browser tabs saved by 3.3.8.
  async openInternalBrowser(item = this.active) {
    if (item?.url && item.context)
      return this.open(vscode.Uri.from({
        scheme: "tmuxdock-remote", authority: item.state.hostId, path: item.state.file,
      }), item.context, true);
  }
  dispose() {
    this.disposed = true;
    for (const item of [...this.items]) item.panel.dispose();
    this.disposeExternal();
  }
  disposeExternal() {
    for (const server of this.externalServers.keys()) server.dispose();
    this.externalServers.clear();
  }
}
module.exports = { HtmlPreviews };
