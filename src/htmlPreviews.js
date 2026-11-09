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
    const item = {
      panel,
      state,
      context,
      token: randomBytes(16).toString("hex"),
      closed: false,
    };
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.items.add(item);
    this.active = item;
    panel.onDidDispose(() => {
      item.closed = true;
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
        if (message?.type === "refresh") {
          this.workspace.service(item.context.controller).retryNow();
          if (item.server) this.send(item, "reload");
          else await this.load(item);
        }
        if (message?.type === "browser") await this.openBrowser(item);
      } catch (error) {
        vscode.window.showErrorMessage("TmuxDock preview: " + error.message);
      }
    });
    return item;
  }
  async open(resource, context) {
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
      "Preview · " + path.basename(resource.path),
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
      },
      context,
    );
    await this.load(item);
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
    const server = new PreviewServer(
      this.workspace.service(c.controller),
      c.root,
      { clipboard: true },
    );
    try {
      await server.start();
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
    item.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src ${server.origin};"><style>html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:var(--vscode-font-size,12px) var(--vscode-font-family,sans-serif)}header{height:34px;display:flex;align-items:center;gap:10px;padding:0 12px}span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--vscode-widget-border,transparent);border-radius:3px;padding:3px 7px;cursor:pointer}button:hover{background:var(--vscode-toolbar-hoverBackground)}iframe{width:100%;height:calc(100% - 34px);border:0}</style></head><body><header><span title="${escape(item.state.file)}">${escape(c.controller.host.label)} · ${escape(c.record?.title || c.entry.title)} · ${escape(item.state.file)}</span><small id="state">Live</small><button id="refresh" title="Reload this preview">Refresh</button><button id="browser" title="Open in VS Code browser">Browser</button></header><iframe id="page" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" src="${escape(item.url)}"></iframe><script nonce="${nonce}">(${installPreviewCopy.toString()})(${JSON.stringify(server.origin)});const api=acquireVsCodeApi();api.setState(${JSON.stringify(item.state).replace(/</g, "\\u003c")});for(const id of ['refresh','browser'])document.getElementById(id).onclick=()=>api.postMessage({type:id});document.getElementById('page').onload=()=>document.getElementById('state').textContent='Live';window.addEventListener('message',e=>{const m=e.data;if(m?.token!==${JSON.stringify(nonce)})return;if(m.type==='reload'){const f=document.getElementById('page');document.getElementById('state').textContent='Updating';f.src=f.src;}if(m.type==='offline')document.getElementById('state').textContent='Offline';});</script></body></html>`;
    server.on("change", () => {
      clearTimeout(item.timer);
      item.timer = setTimeout(() => this.send(item, "reload"), 300);
    });
    server.on("offline", () => this.send(item, "offline"));
    server.on("online", () => this.send(item, "reload"));
  }
  send(item, type) {
    if (!item.closed)
      return item.panel.webview.postMessage({ type, token: item.token });
  }
  empty(item, message) {
    if (item.closed) return;
    const nonce = item.token;
    item.panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head><body style="font:14px sans-serif;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px">${escape(message)}<script nonce="${nonce}">acquireVsCodeApi().setState(${JSON.stringify(item.state || null).replace(/</g, "\\u003c")})</script></body></html>`;
  }
  stop(item) {
    clearTimeout(item.timer);
    item.server?.dispose();
    item.server = null;
    item.url = null;
  }
  refresh() {
    for (const item of this.items) if (item.server) this.send(item, "reload");
  }
  suspend() {
    for (const item of this.items) {
      this.stop(item);
      this.empty(item, "Session Files is disabled.");
    }
  }
  reconcile() {
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
        item.panel.title = "Preview · " + path.basename(item.state.file);
        try {
          await this.load(item);
        } catch (error) {
          this.empty(item, error.message);
        }
      }
    }
  }
  async openBrowser(item = this.active) {
    if (item?.url)
      await vscode.commands.executeCommand(
        "simpleBrowser.api.open",
        vscode.Uri.parse(item.url),
        {
          viewColumn: vscode.ViewColumn.Active,
          preserveFocus: false,
        },
      );
  }
  dispose() {
    for (const item of [...this.items]) item.panel.dispose();
  }
}
module.exports = { HtmlPreviews };
