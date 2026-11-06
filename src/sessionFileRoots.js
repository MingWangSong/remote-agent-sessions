"use strict";
const KEY = "workspace.fileRoots.v1";
const fs = require("node:fs");
function validRoot(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function hostKey(host) {
  return JSON.stringify([
    host.id,
    host.sshHost,
    host.tmuxPath || "tmux",
    host.socketName || "",
  ]);
}
function activeDirectory(entry) {
  const windows = entry.live?.snapshotWindows || [];
  const window = windows.find((w) => w.active) || windows[0];
  return (
    (window?.panes?.find((p) => p.active) || window?.panes?.[0])?.cwd ||
    window?.cwd ||
    entry.cwd
  );
}
// File browsing does not imply adopting a tmux session or binding an Agent.
// Legacy roots are frozen once in this workspace's existing VS Code memento.
class SessionFileRoots {
  constructor(storage, seedPath) {
    this.storage = storage;
    const saved = storage.get(KEY, []);
    let seeds = [];
    if (seedPath) {
      try {
        seeds = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT")
          console.warn("TmuxDock: file-root seeds unavailable");
      }
    }
    this.links = new Map(
      [
        ...(Array.isArray(seeds) ? seeds : []),
        ...(Array.isArray(saved) ? saved : []),
      ]
        .filter(
          (link) =>
            typeof link?.key === "string" &&
            typeof link.host === "string" &&
            typeof link.sessionId === "string" &&
            validRoot(link.root),
        )
        .map((link) => [link.key, link]),
    );
    this.pending = Promise.resolve();
  }
  key(controller, id) {
    return JSON.stringify([hostKey(controller.host), id]);
  }
  saved(controller, id) {
    return this.links.get(this.key(controller, id));
  }
  async save(controller, entry, root) {
    if (!validRoot(root))
      throw new Error("Choose an absolute working directory");
    const link = {
      key: this.key(controller, entry.id),
      host: hostKey(controller.host),
      sessionId: entry.id,
      title: entry.title,
      tmuxSession: entry.tmuxSession,
      managed: Boolean(entry.record),
      root,
    };
    this.links.set(link.key, link);
    const result = this.pending.then(() =>
      this.storage.update(KEY, [...this.links.values()]),
    );
    this.pending = result.catch(() => {});
    await result;
  }
  context(controller, entry, remember = true) {
    const record =
      controller.manager.records.find(
        (r) => r.id === (entry.record?.id || entry.id),
      ) || entry.record;
    const current = { ...entry, record };
    const root =
      record?.workspaceRoot ||
      this.saved(controller, entry.id)?.root ||
      (validRoot(record?.cwd) ? record.cwd : activeDirectory(entry));
    const resolved = validRoot(root) ? root : undefined;
    if (
      remember &&
      resolved &&
      !record?.workspaceRoot &&
      !this.saved(controller, entry.id)
    ) {
      this.save(controller, current, resolved).catch(() => {});
    }
    return { controller, entry: current, record, root: resolved };
  }
  find(controller, id) {
    if (!controller) return;
    const record = controller.manager.records.find((r) => r.id === id);
    const entry =
      controller.manager.entries.find((e) => e.id === id) ||
      (record && {
        id,
        record,
        title: record.title,
        tmuxSession: record.tmuxSession,
      });
    if (entry) return this.context(controller, entry);
    const saved = this.saved(controller, id);
    // Forgetting a managed recovery record must also revoke its file access.
    if (saved && !saved.managed)
      return this.context(
        controller,
        {
          id,
          title: saved.title,
          tmuxSession: saved.tmuxSession,
          record: null,
          status: "unavailable",
        },
        false,
      );
  }
  roots(controller) {
    const roots = new Set(
      controller.manager.records
        .map(
          (record) =>
            this.context(
              controller,
              { id: record.id, record, title: record.title },
              false,
            ).root,
        )
        .filter(Boolean),
    );
    for (const link of this.links.values())
      if (link.host === hostKey(controller.host) && !link.managed)
        roots.add(link.root);
    return roots;
  }
}
module.exports = { SessionFileRoots, validRoot };
