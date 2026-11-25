"use strict";
const vscode = require("vscode");
const path = require("node:path").posix;
const { randomBytes } = require("node:crypto");
const { relative } = require("./remoteFiles");
const { PreviewServer, validPreviewAddress } = require("./previewService");
const { hostKey } = require("./sessionFileRoots");
const { installPreviewCopy } = require("./previewClipboard");
const { setTimeout: delay } = require("node:timers/promises");
const BROWSER_LINKS = "workspace.browserPreviews.v1";
function sameBrowserResource(a, b) {
  return a && a.hostId === b.hostId && a.sessionId === b.sessionId &&
    a.root === b.root && a.file === b.file;
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function validateResource(resource, context) {
  if (!context?.root || !resource || resource.authority !== context.controller.host.id || !/\.html?$/i.test(resource.path))
    throw new Error("Select an HTML file in a linked session directory");
  relative(context.root, resource.path);
  if (!vscode.workspace.isTrusted)
    throw new Error("HTML preview requires a trusted workspace");
}

// Each tab owns its page and HTTP origin. SSH reads/watches remain shared by host.
class HtmlPreviews {
  constructor(workspace) {
    this.workspace = workspace;
    this.items = new Set();
    this.externalServers = new Map();
    this.browserStorage = workspace.context.workspaceState;
    const saved = this.browserStorage.get(BROWSER_LINKS, []);
    this.browserLinks = new Map((Array.isArray(saved) ? saved : [])
      .filter(link => validPreviewAddress(link) && typeof link.target === "string" && typeof link.hostId === "string" &&
        typeof link.sessionId === "string" && typeof link.root === "string" && typeof link.file === "string")
      .map(link => [link.host, link]));
    this.pendingBrowserSave = Promise.resolve();
    this.launching = new Map();
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
    validateResource(resource, context);
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
  saveBrowserLinks() {
    const update = this.pendingBrowserSave.then(() =>
      this.browserStorage.update(BROWSER_LINKS, [...this.browserLinks.values()]));
    this.pendingBrowserSave = update.catch(() => {});
    return update;
  }
  browserTarget(link) {
    const controller = this.workspace.provider.controllers.find(c => c.host.id === link.hostId);
    if (!controller || link.target !== hostKey(controller.host)) return;
    const target = this.workspace.fileRoots.find(controller, link.sessionId);
    if (target?.root !== link.root) return;
    return target;
  }
  async restoreBrowserLinks({ loadRecords = false } = {}) {
    if (this.disposed || !this.workspace.enabled || !vscode.workspace.isTrusted || !this.browserLinks.size) return;
    if (loadRecords) {
      const hosts = new Set([...this.browserLinks.values()].map(link => link.hostId));
      // Start the local listeners before the initial SSH inventory. Managed
      // links can be verified from the saved session records even while offline.
      await Promise.allSettled(this.workspace.provider.controllers
        .filter(controller => hosts.has(controller.host.id))
        .map(controller => controller.manager.reloadRecords()));
    }
    await Promise.allSettled([...this.browserLinks.values()].map(link => this.restoreBrowserLink(link)));
  }
  async restoreBrowserLink(link) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.disposed || !this.workspace.enabled || this.browserLinks.get(link.host) !== link ||
          [...this.externalServers.keys()].some(server => server.host === link.host)) return;
      const context = this.browserTarget(link);
      if (!context) return;
      validateResource({ authority: link.hostId, path: link.file }, context);
      const server = new PreviewServer(this.workspace.service(context.controller), context.root, { watch: false });
      server.browser = true;
      try {
        await server.start(link.file, link);
        if (this.disposed || !this.workspace.enabled || this.browserLinks.get(link.host) !== link || !this.browserTarget(link)) {
          server.dispose();
          return;
        }
        this.externalServers.set(server, link);
        return;
      } catch (error) {
        server.dispose();
        if (error.code !== "EADDRINUSE" || attempt === 4) return;
        // The previous window can still be releasing its listener during Reload.
        await delay(125 * (attempt + 1));
      }
    }
  }
  reconcile() {
    if (this.workspace.provider.reloading) return;
    let revoked = false;
    for (const [host, link] of this.browserLinks) {
      if (!this.browserTarget(link)) {
        this.browserLinks.delete(host);
        revoked = true;
      }
    }
    if (revoked) this.saveBrowserLinks().catch(() => {});
    for (const [server, state] of this.externalServers) {
      if (!this.browserTarget(state)) {
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
  async openResourceInBrowser(resource, context) {
    if (this.disposed) throw new Error("HTML previews are closed");
    validateResource(resource, context);
    const state = { hostId: resource.authority, sessionId: context.entry.id, root: context.root, file: resource.path };
    const preview = [...this.items].find(item => !item.closed && item.server && sameBrowserResource(item.state, state));
    if (preview) return this.openBrowser(preview);
    for (const [server, link] of this.externalServers)
      if (!server.closed && sameBrowserResource(link, state) && link.target === hostKey(context.controller.host))
        return this.openBrowser({ server, state: link, context });
    const server = new PreviewServer(this.workspace.service(context.controller), context.root, { watch: false });
    try {
      await server.start(resource.path);
      if (this.disposed || this.workspace.disposed || this.workspace.enabled === false)
        throw new Error("Session Files is closed");
      return await this.openBrowser({ server, state, context });
    } catch (error) {
      this.externalServers.delete(server);
      server.dispose();
      throw error;
    }
  }
  async openBrowser(item = this.active) {
    if (!item?.server || !item.context || item.closed)
      throw new Error("Open an HTML preview before opening it in your browser");
    if (!vscode.workspace.isTrusted)
      throw new Error("HTML preview requires a trusted workspace");
    for (const [server, state] of this.externalServers) {
      if (!server.closed && sameBrowserResource(state, item.state) && state.target === hostKey(item.context.controller.host)) {
        item = { ...item, server, state };
        break;
      }
    }
    const server = item.server;
    if (this.launching.has(server)) return this.launching.get(server);
    const launch = this.launchBrowser(item).finally(() => this.launching.delete(server));
    this.launching.set(server, launch);
    return launch;
  }
  async launchBrowser(item, openExternal = uri => vscode.env.openExternal(uri)) {
    const { server } = item;
    const retained = this.externalServers.has(server);
    const link = { ...item.state, host: server.host, port: server.port, target: hostKey(item.context.controller.host) };
    if (!validPreviewAddress(link)) throw new Error("Invalid preview address");
    server.browser = true;
    this.externalServers.set(server, link);
    if (!retained) this.browserLinks.set(link.host, link);
    try {
      // Save before handing the URL to the OS, so a reload can bind it again.
      if (!retained) await this.saveBrowserLinks();
      if (this.disposed || this.workspace.enabled === false) throw new Error("Session Files is closed");
      const opened = await openExternal(vscode.Uri.parse(server.url(item.state.file)));
      if (!opened) throw new Error("Your default browser could not be opened. Try Browser again");
      return opened;
    } catch (error) {
      if (!retained) {
        this.externalServers.delete(server);
        this.browserLinks.delete(link.host);
        await this.saveBrowserLinks().catch(() => {});
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
