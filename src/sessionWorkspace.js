"use strict";
const vscode = require("vscode");
const path = require("node:path").posix;
const { randomBytes } = require("node:crypto");
const { RemoteFiles, relative } = require("./remoteFiles");
const { PreviewServer } = require("./previewService");
const transfers = require("./fileTransfers");
const SCHEME = "tmuxdock-remote";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function uri(host, file) {
  return vscode.Uri.from({ scheme: SCHEME, authority: host, path: file });
}
function fileType(type) {
  return type === "directory"
    ? vscode.FileType.Directory
    : type === "file"
      ? vscode.FileType.File
      : vscode.FileType.SymbolicLink;
}

class SessionWorkspace {
  constructor(context, provider, chooseDirectory) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.context = context;
    this.provider = provider;
    this.chooseDirectory = chooseDirectory;
    this.services = new Map();
    this.treeWatches = new Map();
    this.documents = new Map();
    this.transferAborts = new Set();
    this.cache = new Map();
    this.limits = new Map();
    this.expanded = new Set(
      context.workspaceState.get("workspace.expanded", []),
    );
    this.generation = 0;
    this.previewGeneration = 0;
    this.pinned = context.workspaceState.get("workspace.pinned", false);
    this.previewPinned = false;
    this.disposed = false;
    this.treeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.treeEmitter.event;
    this.fileEmitter = new vscode.EventEmitter();
    this.view = vscode.window.createTreeView("remoteAgentSessions.files", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    context.subscriptions.push(
      this,
      this.view,
      vscode.workspace.registerFileSystemProvider(SCHEME, this.fileProvider(), {
        isReadonly: true,
        isCaseSensitive: true,
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => this.watchDocument(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.documents.get(doc.uri.toString())?.dispose();
        this.documents.delete(doc.uri.toString());
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.fromUri(editor?.document.uri),
      ),
      this.view.onDidChangeVisibility(() => {
        if (!this.view.visible) this.clearTreeWatches();
        else this.treeEmitter.fire();
      }),
      this.view.onDidExpandElement((e) => {
        this.expanded.add(e.element.uri.toString());
        context.workspaceState.update(
          "workspace.expanded",
          [...this.expanded].slice(-200),
        );
      }),
      this.view.onDidCollapseElement((e) => {
        const key = e.element.uri?.toString();
        this.expanded.delete(key);
        context.workspaceState.update(
          "workspace.expanded",
          [...this.expanded].slice(-200),
        );
        for (const [uri, w] of this.treeWatches)
          if (uri === key || uri.startsWith(key + "/")) {
            w.dispose();
            this.treeWatches.delete(uri);
          }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("remoteAgentSessions.sessionFilesEnabled"))
          this.setEnabled();
      }),
    );
    const register = (id, fn) =>
      context.subscriptions.push(
        vscode.commands.registerCommand(
          "remoteAgentSessions." + id,
          (...args) =>
            Promise.resolve()
              .then(() =>
                ["openFile", "previewHtml", "linkDirectory"].includes(id)
                  ? vscode.window.withProgress(
                      {
                        location: vscode.ProgressLocation.Notification,
                        title:
                          "TmuxDock · " +
                          (id === "previewHtml"
                            ? "Loading HTML preview"
                            : id === "openFile"
                              ? "Opening remote file"
                              : "Link working directory"),
                      },
                      () => fn(...args),
                    )
                  : fn(...args),
              )
              .catch((error) =>
                vscode.window.showErrorMessage(
                  "TmuxDock files: " + error.message,
                ),
              ),
        ),
      );
    register("showFiles", async (item) => {
      if (item?.controller && item?.entry)
        this.select(item.controller, item.entry, true);
      await vscode.commands.executeCommand(
        "workbench.view.extension.tmuxdockFiles",
      );
    });
    register("linkDirectory", (item) => this.link(item));
    register("refreshFiles", () => {
      this.cache.clear();
      this.treeEmitter.fire();
      for (const s of this.services.values()) s.retryNow();
      if (this.panel) this.sendPreview("reload");
    });
    register("pinFiles", () => {
      this.pinned = !this.pinned;
      context.workspaceState.update("workspace.pinned", this.pinned);
      this.updateTitle();
    });
    register("openFile", (item) => this.openFile(item));
    register("loadMoreFiles", (item) => {
      const key = item.parent.uri.toString();
      this.limits.set(key, (this.limits.get(key) || 200) + 200);
      this.treeEmitter.fire();
    });
    register("previewHtml", (item) => this.preview(item));
    register("previewMarkdown", async (item) => {
      const resource =
        item?.uri || vscode.window.activeTextEditor?.document.uri;
      if (
        resource?.scheme !== SCHEME ||
        !/\.(md|markdown)$/i.test(resource.path)
      )
        throw new Error("Select a Markdown file in Session Files");
      const doc = await vscode.workspace.openTextDocument(resource);
      this.watchDocument(doc);
      await vscode.commands.executeCommand(
        "markdown.showPreviewToSide",
        resource,
      );
    });
    register("uploadFiles", (item) => this.uploadFiles(item));
    register("downloadFile", (item) => this.downloadFile(item));
    register("openPreviewBrowser", async () => {
      if (!this.previewUrl) return;
      const commands = await vscode.commands.getCommands(true);
      await vscode.commands.executeCommand(
        commands.includes("workbench.action.browser.open")
          ? "workbench.action.browser.open"
          : "simpleBrowser.show",
        this.previewUrl,
      );
    });
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer("tmuxdock.preview", {
        deserializeWebviewPanel: async (panel, state) => {
          await this.ready;
          if (this.disposed) return;
          this.attachPanel(panel);
          this.previewPinned = Boolean(state?.pinned);
          const c = provider.controllers.find(
            (c) => c.host.id === state?.hostId,
          );
          const r = c?.manager.records.find((r) => r.id === state?.sessionId);
          if (c && r && r.workspaceRoot === state.root) {
            const saved = {
              controller: c,
              record: r,
              entry: { id: r.id, title: r.title, record: r },
              root: r.workspaceRoot,
            };
            const target =
              !this.previewPinned && this.current ? this.current : saved;
            const file =
              target.controller.host.id === state.hostId &&
              target.entry.id === state.sessionId
                ? state.file
                : this.context.workspaceState.get(
                    "preview." +
                      target.controller.host.id +
                      ":" +
                      target.entry.id,
                  );
            if (file && target.root)
              await this.preview({
                uri: uri(target.controller.host.id, file),
                context: target,
              });
            else
              this.emptyPreview(
                "Select an HTML file in this session to preview.",
              );
          } else
            this.emptyPreview("Choose a session and an HTML file to preview.");
        },
      }),
    );
    this.reconcileTimer = setInterval(() => this.reconcile(), 2500);
    this.reconcileTimer.unref?.();
    this.setEnabled();
  }
  setEnabled() {
    this.enabled = vscode.workspace
      .getConfiguration("remoteAgentSessions")
      .get("sessionFilesEnabled", true);
    if (!this.enabled) {
      for (const abort of this.transferAborts) abort.abort();
      this.clearTreeWatches();
      for (const w of this.documents.values()) w.dispose();
      this.documents.clear();
      this.closeServer();
      for (const s of this.services.values()) s.dispose();
      this.services.clear();
      this.emptyPreview("Session Files is disabled.");
    }
    if (this.enabled)
      for (const doc of vscode.workspace.textDocuments) this.watchDocument(doc);
    this.updateTitle();
    this.treeEmitter.fire();
  }
  reconcile() {
    if (this.current) {
      const c = this.provider.controllers.find(
        (c) => c.host.id === this.current.controller.host.id,
      );
      const r = c?.manager.records.find(
        (r) => r.id === this.current.record?.id,
      );
      if (!c || (this.current.record && !r)) {
        this.current = null;
        this.key = null;
        this.generation++;
        this.clearTreeWatches();
        this.cache.clear();
        this.updateTitle();
        this.treeEmitter.fire();
      } else if (r) {
        this.select(c, { ...this.current.entry, record: r }, true);
      }
    }
    if (this.server && this.previewContext) {
      const c = this.provider.controllers.find(
        (c) => c.host.id === this.previewContext.controller.host.id,
      );
      const r = c?.manager.records.find(
        (r) => r.id === this.previewContext.record?.id,
      );
      if (!r || r.workspaceRoot !== this.previewContext.root) {
        this.closeServer();
        this.emptyPreview("This session directory is no longer linked.");
      }
    }
    for (const [id, service] of this.services) {
      const c = this.provider.controllers.find((c) => c.host.id === id);
      if (!c) {
        service.dispose();
        this.services.delete(id);
        continue;
      }
      if (
        service.connectionKey !==
        JSON.stringify([c.host.sshHost, c.ssh.sshPath])
      ) {
        service.dispose();
        this.services.delete(id);
        continue;
      }
      service.setRoots(
        new Set(
          c.manager.records
            .filter((r) => r.workspaceRoot)
            .map((r) => path.resolve(r.workspaceRoot)),
        ),
      );
    }
  }
  service(controller) {
    if (!this.enabled) throw new Error("Session Files is disabled");
    let files = this.services.get(controller.host.id);
    if (
      files &&
      files.connectionKey !==
        JSON.stringify([controller.host.sshHost, controller.ssh.sshPath])
    ) {
      files.dispose();
      this.services.delete(controller.host.id);
      files = null;
    }
    if (!files) {
      files = new RemoteFiles(controller.ssh);
      files.connectionKey = JSON.stringify([
        controller.host.sshHost,
        controller.ssh.sshPath,
      ]);
      this.services.set(controller.host.id, files);
      files.on("change", (file, change) => {
        this.fileEmitter.fire([
          {
            type:
              change?.type === "deleted"
                ? vscode.FileChangeType.Deleted
                : change?.type === "created"
                  ? vscode.FileChangeType.Created
                  : vscode.FileChangeType.Changed,
            uri: uri(controller.host.id, file),
          },
        ]);
        for (const key of this.cache.keys())
          if (key.startsWith(controller.host.id + ":")) {
            const directory = key.slice(
              controller.host.id.length + 1,
              key.lastIndexOf(":"),
            );
            if (directory === file || directory === path.dirname(file))
              this.cache.delete(key);
          }
        if (
          this.current?.controller.host.id === controller.host.id &&
          this.current.root &&
          (() => {
            try {
              relative(this.current.root, file);
              return true;
            } catch {
              return false;
            }
          })() &&
          this.view.visible
        )
          this.treeEmitter.fire();
      });
      files.on("offline", (error, root) => {
        if (
          this.current?.controller.host.id === controller.host.id &&
          (!root || root === this.current.root)
        ) {
          this.offline = error.message;
          this.updateTitle();
        }
      });
      files.on("online", (root) => {
        if (
          this.current?.controller.host.id === controller.host.id &&
          root === this.current.root &&
          this.offline
        ) {
          this.offline = null;
          this.updateTitle();
        }
      });
    }
    files.setRoots(
      new Set(
        controller.manager.records
          .filter((r) => r.workspaceRoot)
          .map((r) => path.resolve(r.workspaceRoot)),
      ),
    );
    return files;
  }
  access(resource) {
    const controller = this.provider.controllers.find(
      (c) => c.host.id === resource.authority,
    );
    if (!controller) throw new Error("This SSH host is no longer configured");
    return this.service(controller);
  }
  fileProvider() {
    const self = this;
    const wrap = async (callback) => {
      try {
        await self.ready;
        return await callback();
      } catch (e) {
        throw (
          e.code === "NoPermissions"
            ? vscode.FileSystemError.NoPermissions
            : e.code === "NotFound"
              ? vscode.FileSystemError.FileNotFound
              : vscode.FileSystemError.Unavailable
        )(e.message);
      }
    };
    return {
      onDidChangeFile: this.fileEmitter.event,
      stat: (u) =>
        wrap(async () => {
          const s = await self.access(u).stat(u.path);
          return { ...s, type: fileType(s.type) };
        }),
      readFile: (u) => wrap(() => self.access(u).read(u.path)),
      readDirectory: (u) =>
        wrap(async () => {
          const f = self.access(u);
          const out = [];
          let offset = 0;
          do {
            const page = await f.list(u.path, offset);
            if (page.total > 2000)
              throw new Error(
                "Use Session Files pagination for this large directory",
              );
            out.push(...page.entries.map((e) => [e.name, fileType(e.type)]));
            offset = page.next;
          } while (offset != null);
          return out;
        }),
      watch: (u) => {
        try {
          return self.access(u).watch(u.path);
        } catch {
          return new vscode.Disposable(() => {});
        }
      },
      writeFile: () => {
        throw vscode.FileSystemError.NoPermissions(
          "Session Files is read-only",
        );
      },
      delete: () => {
        throw vscode.FileSystemError.NoPermissions();
      },
      rename: () => {
        throw vscode.FileSystemError.NoPermissions();
      },
      createDirectory: () => {
        throw vscode.FileSystemError.NoPermissions();
      },
    };
  }
  watchDocument(doc) {
    if (doc.uri.scheme !== SCHEME || this.documents.has(doc.uri.toString()))
      return;
    try {
      this.documents.set(
        doc.uri.toString(),
        this.access(doc.uri).watch(doc.uri.path),
      );
    } catch {}
  }
  restore() {
    const saved = this.context.workspaceState.get("workspace.last");
    const c = this.provider.controllers.find(
      (c) => c.host.id === saved?.hostId,
    );
    const r = c?.manager.records.find((r) => r.id === saved?.sessionId);
    if (c && r) this.select(c, { id: r.id, record: r, title: r.title }, true);
    for (const d of vscode.workspace.textDocuments) this.watchDocument(d);
    this.resolveReady();
  }
  select(controller, entry, force = false) {
    if (!this.enabled || this.disposed || (!force && this.pinned)) return;
    controller =
      this.provider.controllers.find((c) => c.host.id === controller.host.id) ||
      controller;
    const record =
      controller.manager.records.find(
        (r) => r.id === (entry.record?.id || entry.id),
      ) || entry.record;
    const next = { controller, entry, record, root: record?.workspaceRoot };
    const key = controller.host.id + ":" + entry.id + ":" + (next.root || "");
    if (key === this.key) {
      this.current = next;
      this.updateTitle();
      return;
    }
    this.key = key;
    this.current = next;
    this.generation++;
    this.offline = null;
    this.clearTreeWatches();
    this.updateTitle();
    this.treeEmitter.fire();
    this.context.workspaceState.update("workspace.last", {
      hostId: controller.host.id,
      sessionId: entry.id,
    });
    if (this.panel && !this.previewPinned) {
      const saved = this.context.workspaceState.get(
        "preview." + controller.host.id + ":" + entry.id,
      );
      if (saved && next.root)
        this.preview({
          uri: uri(controller.host.id, saved),
          context: next,
        }).catch((e) => this.emptyPreview(e.message));
      else {
        this.closeServer();
        this.emptyPreview("Select an HTML file in this session to preview.");
      }
    }
  }
  fromUri(resource) {
    if (this.pinned || resource?.scheme !== SCHEME) return;
    const c = this.provider.controllers.find(
      (c) => c.host.id === resource.authority,
    );
    if (!c) return;
    if (this.current?.controller === c && this.current.root) {
      try {
        relative(this.current.root, resource.path);
        return;
      } catch {}
    }
    const r = c.manager.records.find(
      (r) =>
        r.workspaceRoot &&
        (() => {
          try {
            relative(r.workspaceRoot, resource.path);
            return true;
          } catch {
            return false;
          }
        })(),
    );
    if (r) this.select(c, { id: r.id, record: r, title: r.title });
  }
  updateTitle() {
    const c = this.current;
    this.view.description = c
      ? `${this.pinned ? "Pinned · " : ""}${c.controller.host.label} · ${c.record?.title || c.entry.title}`
      : "Select a session";
    this.view.message = !this.enabled
      ? "Session Files is disabled."
      : !c
        ? "Select a TmuxDock session to browse its working directory."
        : !c.root
          ? "This older session has no fixed root. Use Link Working Directory to choose it."
          : `${c.root}${this.offline ? " · Unavailable: " + this.offline : ""}`;
  }
  clearTreeWatches() {
    for (const w of this.treeWatches.values()) w.dispose();
    this.treeWatches.clear();
  }
  getParent(item) {
    return item.parentNode;
  }
  getTreeItem(item) {
    if (item.message) {
      const t = new vscode.TreeItem(item.message);
      t.command = item.command;
      return t;
    }
    const t = new vscode.TreeItem(
      item.name,
      item.type === "directory"
        ? this.expanded.has(item.uri.toString())
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    t.iconPath = new vscode.ThemeIcon(
      item.type === "directory" ? "folder" : "file",
    );
    t.id = item.uri.toString();
    t.resourceUri = item.uri;
    t.contextValue =
      item.type === "directory"
        ? "remoteDirectory"
        : /\.html?$/i.test(item.name)
          ? "remoteHtml"
          : /\.(md|markdown)$/i.test(item.name)
            ? "remoteMarkdown"
            : "remoteFile";
    t.tooltip = `${item.context.controller.host.label}\n${item.uri.path}`;
    if (item.type === "file")
      t.command = {
        command: "remoteAgentSessions.openFile",
        title: "Open Remote File",
        arguments: [item],
      };
    else if (item.type !== "directory") {
      t.description = "link / unsupported";
      t.tooltip += "\nSymbolic links are not followed.";
    }
    return t;
  }
  async getChildren(parent) {
    const c = this.current;
    if (!this.enabled || !c) return [];
    if (!c.root)
      return [
        {
          message: "Link Working Directory…",
          command: {
            command: "remoteAgentSessions.linkDirectory",
            title: "Link Working Directory",
          },
        },
      ];
    const generation = this.generation;
    const root = parent || {
      uri: uri(c.controller.host.id, c.root),
      context: c,
      limit: 200,
    };
    root.limit = this.limits.get(root.uri.toString()) || 200;
    if (
      parent &&
      (parent.context.controller.host.id !== c.controller.host.id ||
        parent.context.root !== c.root)
    )
      return [];
    try {
      const service = this.service(c.controller);
      if (this.view.visible && !this.treeWatches.has(root.uri.toString()))
        this.treeWatches.set(root.uri.toString(), service.watch(root.uri.path));
      const cacheKey =
        c.controller.host.id + ":" + root.uri.path + ":" + (root.limit || 200);
      let list = this.cache.get(cacheKey);
      if (!list) {
        list = [];
        let offset = 0;
        do {
          const page = await service.list(root.uri.path, offset);
          list.push(...page.entries);
          offset = page.next;
          if (offset == null || list.length >= (root.limit || 200)) {
            list.next = offset;
            list.skipped = page.skipped;
            break;
          }
        } while (true);
        this.cache.set(cacheKey, list);
        if (this.cache.size > 128)
          this.cache.delete(this.cache.keys().next().value);
      }
      if (generation !== this.generation) return [];
      const entries = list
        .filter((e) => ![".git", "node_modules"].includes(e.name))
        .map((e) => ({
          ...e,
          uri: uri(c.controller.host.id, path.join(root.uri.path, e.name)),
          context: c,
          limit: 200,
          parentNode: parent,
        }));
      if (list.next != null)
        entries.push({
          message: "Load more…",
          command: {
            command: "remoteAgentSessions.loadMoreFiles",
            title: "Load more",
            arguments: [{ parent: root }],
          },
        });
      if (list.skipped)
        entries.push({
          message: `${list.skipped} names cannot be represented as UTF-8`,
        });
      return entries;
    } catch (error) {
      if (generation !== this.generation) return [];
      this.offline = error.message;
      this.updateTitle();
      return [{ message: "Unavailable · " + error.message }];
    }
  }
  async link(item) {
    if (item?.controller && item?.entry)
      this.select(item.controller, item.entry, true);
    const c = this.current;
    if (!c) throw new Error("Select a session first");
    if (!c.record)
      throw new Error(
        "Use Enable Recovery to save this existing session before linking its directory",
      );
    const root = await this.chooseDirectory(c.controller, c.record.cwd);
    if (!root) return;
    await c.controller.manager.edit(c.record, (r) => {
      r.workspaceRoot = root;
      r.rootSource = "explicit";
    });
    this.select(
      c.controller,
      {
        ...c.entry,
        record: c.controller.manager.records.find((r) => r.id === c.record.id),
      },
      true,
    );
  }
  async openFile(item) {
    if (!item?.uri) return;
    this.fromUri(item.uri);
    const s = await this.access(item.uri).stat(item.uri.path);
    if (s.size > 2 * 1024 * 1024) {
      const answer = await vscode.window.showWarningMessage(
        "This file is larger than 2 MiB. Open it in the read-only viewer?",
        "Open",
      );
      if (answer !== "Open") return;
    }
    await vscode.commands.executeCommand("vscode.open", item.uri, {
      preview:
        vscode.window.activeTextEditor?.document.uri.toString() !==
        item.uri.toString(),
      viewColumn: vscode.ViewColumn.Active,
    });
  }
  async transfer(title, action) {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "TmuxDock · " + title,
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        this.transferAborts.add(abort);
        const listener = token.onCancellationRequested(() => abort.abort());
        try {
          await action(abort.signal);
          return true;
        } catch (error) {
          if (!abort.signal.aborted) throw error;
          return false;
        } finally {
          listener.dispose();
          this.transferAborts.delete(abort);
        }
      },
    );
  }
  async uploadFiles(item) {
    const c = item?.context || this.current;
    if (!this.enabled || !c?.root)
      throw new Error("Select a linked session directory first");
    const directory = item?.type === "directory" ? item.uri.path : c.root;
    relative(c.root, directory);
    const service = this.service(c.controller);
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Upload files",
    });
    if (!selected?.length) return;
    for (const local of selected) {
      if (local.scheme !== "file")
        throw new Error("Choose a local file to upload");
      const destination = path.join(
        directory,
        require("node:path").basename(local.fsPath),
      );
      relative(c.root, destination);
      let exists;
      try {
        exists = await service.stat(destination, c.root);
      } catch (error) {
        if (error.code !== "NotFound") throw error;
      }
      if (exists) {
        if (exists.type !== "file")
          throw new Error("The destination is not a regular file");
        if (
          (await vscode.window.showWarningMessage(
            `Replace ${path.basename(destination)} on ${c.controller.host.label}?`,
            { modal: true },
            "Replace",
          )) !== "Replace"
        )
          continue;
      }
      const completed = await this.transfer(
        "Uploading " + path.basename(destination),
        async (signal) => {
          await service.stat(directory, c.root);
          await transfers.upload(
            c.controller.ssh,
            local.fsPath,
            destination,
            signal,
          );
        },
      );
      if (!completed) break;
    }
    this.cache.clear();
    this.treeEmitter.fire();
    service.retryNow();
  }
  async downloadFile(item) {
    if (!item?.uri || item.type !== "file")
      throw new Error("Select a file in Session Files");
    const c = item.context;
    relative(c.root, item.uri.path);
    const destination = await vscode.window.showSaveDialog({
      saveLabel: "Download file",
      defaultUri: vscode.Uri.file(
        require("node:path").join(require("node:os").homedir(), item.name),
      ),
    });
    if (!destination) return;
    if (destination.scheme !== "file")
      throw new Error("Choose a local download destination");
    await this.transfer("Downloading " + item.name, async (signal) => {
      await this.service(c.controller).stat(item.uri.path, c.root);
      await transfers.download(
        c.controller.ssh,
        item.uri.path,
        destination.fsPath,
        signal,
      );
    });
  }
  attachPanel(panel) {
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = null;
        this.closeServer();
      }
    });
    panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "refresh") this.sendPreview("reload");
      if (message?.type === "pin") {
        this.previewPinned = !this.previewPinned;
        this.sendPreview("pin", { pinned: this.previewPinned });
      }
      if (message?.type === "browser")
        vscode.commands.executeCommand(
          "remoteAgentSessions.openPreviewBrowser",
        );
    });
  }
  closeServer() {
    this.previewGeneration++;
    clearTimeout(this.reloadTimer);
    this.server?.dispose();
    this.server = null;
    this.previewUrl = null;
  }
  sendPreview(type, data = {}) {
    return this.panel?.webview.postMessage({
      type,
      ...data,
      token: this.panelToken,
    });
  }
  emptyPreview(message) {
    if (!this.panel) return;
    const nonce = randomBytes(16).toString("hex");
    this.panelToken = nonce;
    this.panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head><body style="font:14px sans-serif;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px">${escape(message)}<script nonce="${nonce}">acquireVsCodeApi().setState(null)</script></body></html>`;
  }

  async preview(item) {
    let resource = item?.uri;
    const c = item?.context || this.current;
    if (!resource) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === SCHEME) resource = active;
    }
    if (!resource || !c?.root)
      throw new Error("Select an HTML file in a linked session directory");
    if (
      resource.authority !== c.controller.host.id ||
      !/\.html?$/i.test(resource.path)
    )
      throw new Error("Select an HTML file in the current session");
    relative(c.root, resource.path);
    if (!vscode.workspace.isTrusted)
      throw new Error(
        "HTML preview requires a trusted workspace; file viewing remains read-only",
      );
    if (!this.panel)
      this.attachPanel(
        vscode.window.createWebviewPanel(
          "tmuxdock.preview",
          "TmuxDock HTML",
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [],
          },
        ),
      );
    this.closeServer();
    const generation = this.previewGeneration;
    this.emptyPreview("Loading remote preview…");
    const server = new PreviewServer(this.service(c.controller), c.root);
    try {
      await server.start();
    } catch (e) {
      server.dispose();
      if (generation === this.previewGeneration) this.emptyPreview(e.message);
      throw e;
    }
    if (generation !== this.previewGeneration || !this.panel) {
      server.dispose();
      return;
    }
    this.server = server;
    this.previewUrl = server.url(resource.path);
    this.previewContext = c;
    this.context.workspaceState.update(
      "preview." + c.controller.host.id + ":" + c.entry.id,
      resource.path,
    );
    const state = {
      hostId: c.controller.host.id,
      sessionId: c.entry.id,
      root: c.root,
      file: resource.path,
      pinned: this.previewPinned,
    };
    this.panel.title = "Preview · " + path.basename(resource.path);
    const nonce = randomBytes(16).toString("hex");
    this.panelToken = nonce;
    this.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src ${server.origin};"><style>html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px sans-serif}header{height:38px;display:flex;align-items:center;gap:10px;padding:0 12px}span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 9px;cursor:pointer}iframe{width:100%;height:calc(100% - 38px);border:0}</style></head><body><header><span title="${escape(resource.path)}">${escape(c.controller.host.label)} · ${escape(c.record?.title || c.entry.title)} · ${escape(resource.path)}</span><small id="state">Live</small><button id="pin">${this.previewPinned ? "Unpin" : "Pin"}</button><button id="refresh">Refresh</button><button id="browser">Browser</button></header><iframe id="page" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" src="${escape(this.previewUrl)}"></iframe><script nonce="${nonce}">const api=acquireVsCodeApi();let state=${JSON.stringify(state).replace(/</g, "\\u003c")};api.setState(state);for(const id of ['pin','refresh','browser'])document.getElementById(id).onclick=()=>api.postMessage({type:id});document.getElementById('page').onload=()=>document.getElementById('state').textContent='Live';window.addEventListener('message',e=>{const m=e.data;if(m?.token!==${JSON.stringify(nonce)})return;if(m?.type==='reload'){const frame=document.getElementById('page');document.getElementById('state').textContent='Updating';frame.src=frame.src;}if(m?.type==='offline')document.getElementById('state').textContent='Offline';if(m?.type==='pin'){state.pinned=m.pinned;api.setState(state);document.getElementById('pin').textContent=m.pinned?'Unpin':'Pin';}});</script></body></html>`;
    server.on("change", () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.sendPreview("reload"), 300);
    });
    server.on("offline", () => {
      this.sendPreview("offline");
    });
  }
  dispose() {
    this.disposed = true;
    for (const abort of this.transferAborts) abort.abort();
    clearInterval(this.reconcileTimer);
    this.clearTreeWatches();
    for (const w of this.documents.values()) w.dispose();
    this.documents.clear();
    this.closeServer();
    this.panel?.dispose();
    for (const s of this.services.values()) s.dispose();
    this.services.clear();
    this.treeEmitter.dispose();
    this.fileEmitter.dispose();
  }
}
module.exports = { SessionWorkspace, SCHEME, uri };
