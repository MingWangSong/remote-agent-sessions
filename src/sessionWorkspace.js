"use strict";
const vscode = require("vscode");
const path = require("node:path").posix;
const { randomBytes } = require("node:crypto");
const { RemoteFiles, relative, entryNameError } = require("./remoteFiles");
const { HtmlPreviews } = require("./htmlPreviews");
const { SessionFileRoots } = require("./sessionFileRoots");
const transfers = require("./fileTransfers");
const { SessionFileActions } = require("./sessionFileActions");
const SCHEME = "tmuxdock-remote";
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
    this.fileRoots = new SessionFileRoots(
      context.workspaceState,
      require("node:path").join(
        context.globalStorageUri.fsPath,
        "session-file-roots.json",
      ),
    );
    this.collapsedRoots = new Set(
      context.workspaceState.get("workspace.collapsedRoots", []),
    );
    this.treeWatches = new Map();
    this.documents = new Map();
    this.transferAborts = new Set();
    this.cache = new Map();
    this.limits = new Map();
    this.expanded = new Set(
      context.workspaceState.get("workspace.expanded", []),
    );
    this.generation = 0;
    this.pinned = context.workspaceState.get("workspace.pinned", false);
    this.previews = new HtmlPreviews(this);
    this.disposed = false;
    this.treeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.treeEmitter.event;
    this.fileEmitter = new vscode.EventEmitter();
    this.actions = new SessionFileActions(this);
    this.view = vscode.window.createTreeView("remoteAgentSessions.files", {
      treeDataProvider: this,
      dragAndDropController: this.actions,
      canSelectMany: true,
      showCollapseAll: true,
    });
    context.subscriptions.push(
      this,
      this.view,
      vscode.workspace.registerFileSystemProvider(SCHEME, this.fileProvider(), {
        isReadonly: false,
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
        if (e.element.isWorkspaceRoot) {
          this.collapsedRoots.delete(e.element.uri.toString());
          context.workspaceState.update("workspace.collapsedRoots", [
            ...this.collapsedRoots,
          ]);
        }
        context.workspaceState.update(
          "workspace.expanded",
          [...this.expanded].slice(-200),
        );
      }),
      this.view.onDidCollapseElement((e) => {
        const key = e.element.uri?.toString();
        this.expanded.delete(key);
        if (e.element.isWorkspaceRoot) {
          this.collapsedRoots.add(key);
          context.workspaceState.update("workspace.collapsedRoots", [
            ...this.collapsedRoots,
          ]);
        }
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
      this.previews.refresh();
    });
    register("pinFiles", () => {
      this.pinned = !this.pinned;
      context.workspaceState.update("workspace.pinned", this.pinned);
      if (!this.pinned && this.followTarget) this.select(...this.followTarget);
      this.updateTitle();
    });
    register("followFiles", () => {
      this.pinned = true;
      return vscode.commands.executeCommand("remoteAgentSessions.pinFiles");
    });
    register("openFile", (item) => this.openFile(item));
    register("newFile", (item) => this.createEntry(item, "file"));
    register("newFolder", (item) => this.createEntry(item, "directory"));
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
      // A unique document URI gives each explicit preview its own native tab,
      // including repeated previews of the same file. File reads stay path-based.
      const preview = resource.with({
        query: "tmuxdockPreview=" + randomBytes(8).toString("hex"),
      });
      const doc = await vscode.workspace.openTextDocument(preview);
      this.watchDocument(doc);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        preview,
        "vscode.markdown.preview.editor",
        {
          viewColumn: vscode.ViewColumn.Active,
          preview: false,
        },
      );
    });
    register("uploadFiles", (item) => this.uploadFiles(item));
    register("downloadFile", (item) => this.downloadFile(item));
    register("openPreviewBrowser", () => this.previews.openBrowser());
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
      this.previews.suspend();
      for (const s of this.services.values()) s.dispose();
      this.services.clear();
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
      const next = this.fileRoots.find(c, this.current.entry.id);
      if (!next) {
        this.current = null;
        this.key = null;
        this.generation++;
        this.clearTreeWatches();
        this.cache.clear();
        this.updateTitle();
        this.treeEmitter.fire();
      } else this.select(c, next.entry, true);
    }
    this.previews.reconcile();
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
      service.setRoots(this.fileRoots.roots(c));
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
        const resources = new Map();
        const base = uri(controller.host.id, file);
        resources.set(base.toString(), base);
        for (const key of this.documents.keys()) {
          const alias = vscode.Uri.parse(key);
          if (alias.authority === base.authority && alias.path === base.path)
            resources.set(key, alias);
        }
        this.fileEmitter.fire(
          [...resources.values()].map((resource) => ({
            type:
              change?.type === "deleted"
                ? vscode.FileChangeType.Deleted
                : change?.type === "created"
                  ? vscode.FileChangeType.Created
                  : vscode.FileChangeType.Changed,
            uri: resource,
          })),
        );
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
    files.setRoots(this.fileRoots.roots(controller));
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
              : e.code === "FileExists"
                ? vscode.FileSystemError.FileExists
                : e.code === "NotDirectory"
                  ? vscode.FileSystemError.FileNotADirectory
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
      writeFile: (u, data, options) =>
        wrap(() => self.access(u).write(u.path, data, options)),
      delete: () => {
        throw vscode.FileSystemError.NoPermissions();
      },
      rename: (a, b, options) => wrap(() => self.actions.rename(a, b, options)),
      createDirectory: (u) => wrap(() => self.access(u).mkdir(u.path)),
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
    const target = this.fileRoots.find(c, saved?.sessionId);
    if (target) this.select(c, target.entry, true);
    for (const d of vscode.workspace.textDocuments) this.watchDocument(d);
    this.resolveReady();
  }
  select(controller, entry, force = false) {
    if (!force) this.followTarget = [controller, entry];
    if (!this.enabled || this.disposed || (!force && this.pinned)) return;
    controller =
      this.provider.controllers.find((c) => c.host.id === controller.host.id) ||
      controller;
    const next = this.fileRoots.context(controller, entry);
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
    const candidates = [
      ...c.manager.records.map((record) =>
        this.fileRoots.context(
          c,
          { id: record.id, record, title: record.title },
          false,
        ),
      ),
      ...[...this.fileRoots.links.values()]
        .filter((link) => !link.managed)
        .map((link) => this.fileRoots.find(c, link.sessionId))
        .filter(Boolean),
    ];
    const owner = candidates.find((candidate) => {
      try {
        if (!candidate.root) return false;
        relative(candidate.root, resource.path);
        return true;
      } catch {
        return false;
      }
    });
    if (owner) this.select(c, owner.entry);
  }

  updateTitle() {
    const c = this.current;
    vscode.commands.executeCommand(
      "setContext",
      "tmuxdock.filesPinned",
      this.pinned,
    );
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
  rootItem() {
    const c = this.current;
    if (!this.enabled || !c?.root) return;
    if (!this.rootNode || this.rootNode.key !== this.key)
      this.rootNode = {
        key: this.key,
        isWorkspaceRoot: true,
        type: "directory",
        name: path.basename(c.root) || c.root,
        uri: uri(c.controller.host.id, c.root),
      };
    this.rootNode.context = c;
    return this.rootNode;
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
        ? (
            item.isWorkspaceRoot
              ? !this.collapsedRoots.has(item.uri.toString())
              : this.expanded.has(item.uri.toString())
          )
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
    if (!parent) return [this.rootItem()];
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
        .filter(
          (e) =>
            ![".git", "node_modules"].includes(e.name) &&
            !/^\.tmuxdock-upload-[a-f0-9-]{36}$/.test(e.name),
        )
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
    const root = await this.chooseDirectory(
      c.controller,
      c.root || c.record?.cwd,
    );
    if (!root) return;
    if (c.record)
      await c.controller.manager.edit(c.record, (r) => {
        r.workspaceRoot = root;
        r.rootSource = "explicit";
      });
    else await this.fileRoots.save(c.controller, c.entry, root);
    this.select(
      c.controller,
      {
        ...c.entry,
        record: c.controller.manager.records.find((r) => r.id === c.record?.id),
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
        "This file is larger than 2 MiB. Open it in the remote editor?",
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
  async createEntry(item, kind) {
    // Toolbar/command-palette actions always target the session root.
    const selected = item || this.rootItem();
    const c = item?.context || this.current;
    if (!this.enabled || !c?.root)
      throw new Error("Select a linked session directory first");
    const candidate =
      selected?.context?.controller.host.id === c.controller.host.id &&
      selected.context.root === c.root
        ? selected
        : null;
    const parent =
      candidate?.type === "directory"
        ? candidate
        : candidate?.parentNode || this.rootItem();
    const directory = parent?.uri.path || c.root;
    relative(c.root, directory);
    const name = await this.askEntryName(kind, directory);
    if (name === undefined) return;
    const error = entryNameError(name);
    if (error) throw new Error(error);
    const file = path.join(directory, name);
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "TmuxDock · Creating " + name,
      },
      () => this.service(c.controller).create(file, kind, c.root),
    );
    // A slow response from session A must not select a file in session B.
    if (
      this.current?.controller.host.id !== c.controller.host.id ||
      this.current.entry.id !== c.entry.id ||
      this.current.root !== c.root
    )
      return;
    const entry = {
      ...result,
      name,
      uri: uri(c.controller.host.id, file),
      context: c,
      parentNode: parent,
    };
    if (this.view.visible)
      await this.view
        .reveal(entry, {
          select: true,
          focus: false,
          expand: kind === "directory",
        })
        .catch(() => {});
    if (kind === "file")
      await vscode.commands.executeCommand("vscode.open", entry.uri, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
      });
    return entry;
  }
  askEntryName(kind, directory) {
    return vscode.window.showInputBox({
      title: kind === "file" ? "New File" : "New Folder",
      prompt: "Create in " + directory,
      placeHolder: kind === "file" ? "report.md" : "new-folder",
      validateInput: entryNameError,
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
    this.actions.target(item);
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "Upload files or folders",
    });
    if (selected?.length) return this.actions.upload(selected, item);
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
  async preview(item) {
    const resource = item?.uri || vscode.window.activeTextEditor?.document.uri;
    if (!resource) throw new Error("Select an HTML file in Session Files");
    return this.previews.open(resource, item?.context || this.current);
  }
  dispose() {
    this.disposed = true;
    for (const abort of this.transferAborts) abort.abort();
    clearInterval(this.reconcileTimer);
    this.clearTreeWatches();
    for (const w of this.documents.values()) w.dispose();
    this.documents.clear();
    this.previews.dispose();
    for (const s of this.services.values()) s.dispose();
    this.services.clear();
    this.treeEmitter.dispose();
    this.fileEmitter.dispose();
  }
}
module.exports = { SessionWorkspace, SCHEME, uri };
