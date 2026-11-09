"use strict";
const vscode = require("vscode");
const fs = require("node:fs/promises");
const localPath = require("node:path");
const path = localPath.posix;
const { randomUUID } = require("node:crypto");
const { relative, entryNameError } = require("./remoteFiles");
const transfers = require("./fileTransfers");
const MIME = "application/vnd.code.tree.remoteagentsessions.files";
const within = (parent, file) =>
  file === parent || file.startsWith(parent === "/" ? "/" : parent + "/");
function topPaths(items, getPath) {
  return items.filter(
    (item, i) =>
      !items.some(
        (other, j) =>
          j !== i &&
          within(getPath(other), getPath(item)) &&
          (getPath(other) !== getPath(item) || j < i),
      ),
  );
}
class SessionFileActions {
  constructor(workspace) {
    this.workspace = workspace;
    this.dragMimeTypes = [MIME, "text/uri-list"];
    this.dropMimeTypes = [MIME, "files", "text/uri-list"];
  }
  target(item) {
    const w = this.workspace;
    const c = item?.context || w.current;
    if (!w.enabled || !c?.root)
      throw new Error("Select a linked session directory first");
    const directory =
      item?.type === "directory"
        ? item.uri.path
        : item?.parentNode?.uri.path || c.root;
    relative(c.root, directory);
    return { c, directory };
  }
  handleDrag(source, transfer, token) {
    if (token?.isCancellationRequested) return;
    const items = topPaths(
      source.filter(
        (item) =>
          item.uri &&
          !item.isWorkspaceRoot &&
          ["file", "directory"].includes(item.type),
      ),
      (item) => item.uri.path,
    );
    if (!items.length) return;
    const c = items[0].context;
    if (
      items.some(
        (item) =>
          item.context.controller.host.id !== c.controller.host.id ||
          item.context.root !== c.root,
      )
    )
      return;
    transfer.set(
      MIME,
      new vscode.DataTransferItem(
        JSON.stringify({
          hostId: c.controller.host.id,
          root: c.root,
          paths: items.map((item) => item.uri.path),
        }),
      ),
    );
    transfer.set(
      "text/uri-list",
      new vscode.DataTransferItem(
        items.map((item) => item.uri.toString()).join("\r\n"),
      ),
    );
  }
  async handleDrop(target, transfer, token) {
    if (token?.isCancellationRequested) return;
    try {
      const { c, directory } = this.target(target);
      const internal = transfer.get(MIME);
      if (internal)
        return await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "TmuxDock · Moving files",
          },
          async () => {
            const data = JSON.parse(await internal.asString());
            if (
              data.hostId !== c.controller.host.id ||
              data.root !== c.root ||
              !Array.isArray(data.paths)
            )
              throw new Error(
                "Move files within the same session working directory",
              );
            const sources = topPaths(
              [...new Set(data.paths)],
              (value) => value,
            );
            const service = this.workspace.service(c.controller);
            const edit = new vscode.WorkspaceEdit();
            const destinations = new Set();
            const planned = [];
            for (const source of sources) {
              relative(c.root, source);
              if (source === c.root || within(source, directory))
                throw new Error("A directory cannot be moved into itself");
              const destination = path.join(directory, path.basename(source));
              if (source === destination) continue;
              if (destinations.has(destination))
                throw new Error(
                  "Selected files have the same destination name",
                );
              destinations.add(destination);
              planned.push({ source, destination });
            }
            // Preflight together through the bounded shared channel, before any move.
            await Promise.all(
              planned.map(async ({ source, destination }) => {
                await Promise.all([
                  service.stat(source, c.root),
                  service.stat(destination, c.root).then(
                    () => {
                      throw new Error(
                        "A file or directory named " +
                          path.basename(destination) +
                          " already exists",
                      );
                    },
                    (error) => {
                      if (error.code !== "NotFound") throw error;
                    },
                  ),
                ]);
              }),
            );
            for (const { source, destination } of planned) {
              edit.renameFile(
                vscode.Uri.from({
                  scheme: "tmuxdock-remote",
                  authority: data.hostId,
                  path: source,
                }),
                vscode.Uri.from({
                  scheme: "tmuxdock-remote",
                  authority: data.hostId,
                  path: destination,
                }),
                { overwrite: false },
              );
            }
            if (token?.isCancellationRequested) return;
            if (!planned.length) return true;
            if (!(await vscode.workspace.applyEdit(edit)))
              throw new Error(
                "Move was not completed; check the destination and retry",
              );
            return true;
          },
        );
      const locals = [];
      const list = transfer.get("text/uri-list");
      if (list)
        for (const line of (await list.asString()).split(/\r?\n/)) {
          if (line.trim() && !line.startsWith("#"))
            locals.push(vscode.Uri.parse(line.trim()));
        }
      for (const [, item] of transfer) {
        const file = item.asFile();
        if (file?.uri) locals.push(file.uri);
      }
      if (!locals.length)
        throw new Error(
          "Drag local files or folders from Finder or your file manager",
        );
      if (token?.isCancellationRequested) return;
      return await this.upload(
        locals,
        {
          context: c,
          type: "directory",
          uri: vscode.Uri.from({
            scheme: "tmuxdock-remote",
            authority: c.controller.host.id,
            path: directory,
          }),
        },
        token,
      );
    } catch (error) {
      vscode.window.showErrorMessage("TmuxDock files: " + error.message);
      return false;
    }
  }
  async rename(source, destination, options) {
    if (
      source.authority !== destination.authority ||
      source.scheme !== destination.scheme
    )
      throw Object.assign(new Error("Move files within one SSH host"), {
        code: "NoPermissions",
      });
    const w = this.workspace;
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === "vscode.markdown.preview.editor" &&
          tab.input.uri.authority === source.authority &&
          tab.input.uri.query.startsWith("tmuxdockPreview=") &&
          within(source.path, tab.input.uri.path),
      );
    if (tabs.some((tab) => tab.isDirty))
      throw new Error(
        "Save or close Markdown previews before moving this file",
      );
    await w.access(source).move(source.path, destination.path, options);
    await w.previews.retarget(source.authority, source.path, destination.path);
    for (const tab of tabs) {
      const old = tab.input.uri;
      const next = old.with({
        path: destination.path + old.path.slice(source.path.length),
      });
      try {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          next,
          tab.input.viewType,
          {
            viewColumn: tab.group.viewColumn,
            preview: false,
            preserveFocus: !tab.isActive,
          },
        );
        await vscode.window.tabGroups.close(tab, true);
      } catch (error) {
        vscode.window.showWarningMessage(
          "File moved. Reopen its Markdown preview: " + error.message,
        );
      }
    }
  }
  putLocal(controller, source, destination, options) {
    return transfers.put(controller.ssh, source, destination, options);
  }
  async upload(locals, target, token) {
    const w = this.workspace;
    const { c, directory } = this.target(target);
    if (locals.some((local) => local.scheme !== "file"))
      throw new Error("Only local files and folders can be uploaded");
    const selected = topPaths(locals, (item) =>
      item.fsPath.replaceAll(localPath.sep, "/"),
    );
    const service = w.service(c.controller);
    for (const local of selected) {
      if (token?.isCancellationRequested) return false;
      const stat = await fs.lstat(local.fsPath);
      if (!stat.isFile() && !stat.isDirectory())
        throw new Error(
          "Choose regular files or folders; symbolic links are not followed",
        );
      const name = localPath.basename(local.fsPath);
      const error = entryNameError(name);
      if (error) throw new Error(error);
      const destination = path.join(directory, name);
      let exists;
      try {
        exists = await service.stat(destination, c.root);
      } catch (error) {
        if (error.code !== "NotFound") throw error;
      }
      if (exists) {
        if (stat.isDirectory() || exists.type !== "file")
          throw new Error(
            "A file or folder named " +
              name +
              " already exists. Rename it before uploading",
          );
        if (
          (await vscode.window.showWarningMessage(
            `Replace ${name} on ${c.controller.host.label}?`,
            { modal: true },
            "Replace",
          )) !== "Replace"
        )
          continue;
      }
      const complete = await w.transfer("Uploading " + name, async (signal) => {
        const cancel = () => {
          // The progress notification owns the same cancellation controller.
          w.transferAborts.forEach((abort) => {
            if (abort.signal === signal) abort.abort();
          });
        };
        // Tree DnD RPC can supply a serialized token without its Event method.
        // The native progress notification still provides working cancellation.
        const listener = typeof token?.onCancellationRequested === "function"
          ? token.onCancellationRequested(cancel)
          : undefined;
        if (token?.isCancellationRequested) cancel();
        const temporary = path.join(
          directory,
          ".tmuxdock-upload-" + randomUUID(),
        );
        let stage;
        try {
          signal.throwIfAborted();
          stage = await service.create(temporary, "directory", c.root);
          const payload = path.join(temporary, "payload");
          await this.putLocal(c.controller, local.fsPath, payload, {
            directory: stat.isDirectory(),
            signal,
          });
          signal.throwIfAborted();
          await service.move(
            payload,
            destination,
            {
              overwrite: Boolean(exists),
              expectedDestination: exists?.signature,
            },
            c.root,
          );
        } finally {
          listener?.dispose();
          if (stage)
            await service
              .discardUpload(temporary, stage.signature, c.root)
              .catch((error) => {
                if (!w.disposed)
                  vscode.window.showWarningMessage(
                    "Upload staging cleanup needs a retry: " + error.message,
                  );
              });
        }
      });
      if (!complete) return false;
    }
    w.cache.clear();
    w.treeEmitter.fire();
    service.retryNow();
    return true;
  }
}
module.exports = { SessionFileActions, MIME, topPaths };
