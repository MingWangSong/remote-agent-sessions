"use strict";
const fs = require("node:fs");
const path = require("node:path").posix;
const { EventEmitter } = require("node:events");
const source = Buffer.from(
  fs.readFileSync(require("node:path").join(__dirname, "remoteFileHelper.py")),
).toString("base64");
const script = `import base64;exec(base64.b64decode('${source}'))`;
const MAX_FRAME = 24 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;

class FileChannel extends EventEmitter {
  constructor(transport, timeout = 15000) {
    super();
    this.transport = transport;
    this.timeout = timeout;
    this.pending = new Map();
    this.bindings = new Map();
    this.sequence = 0;
    this.disposed = false;
  }
  async ready() {
    if (this.disposed) throw new Error("File channel is closed");
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      const child = this.transport.openProcess("python3", ["-u", "-c", script]);
      this.child = child;
      let buffer = Buffer.alloc(0);
      let stderr = "";
      const fail = (error) => {
        if (this.child !== child) return;
        this.child = null;
        this.bindings.clear();
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        this.pending.clear();
        child.stdin.destroy();
        child.kill();
        this.emit("offline", error);
      };
      child.stderr.on("data", (b) => {
        stderr = (stderr + b.toString()).slice(-1000);
      });
      child.stdin.on("error", (error) => fail(error));
      child.on("error", (error) => fail(error));
      child.on("exit", () =>
        fail(
          new Error(
            "Remote files disconnected. Python 3 is required on this host. " +
              stderr.trim(),
          ),
        ),
      );
      child.stdout.on("data", (chunk) => {
        if (this.child !== child) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE();
          if (size > MAX_FRAME) {
            fail(new Error("Invalid file protocol frame"));
            return;
          }
          if (buffer.length < size + 4) return;
          let message;
          try {
            message = JSON.parse(buffer.subarray(4, size + 4));
          } catch {
            fail(new Error("Invalid file protocol response"));
            return;
          }
          buffer = buffer.subarray(size + 4);
          const request = this.pending.get(message.id);
          if (!request) continue;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error)
            request.reject(
              Object.assign(new Error(message.error.message), {
                code: message.error.code,
              }),
            );
          else request.resolve(message.result);
        }
      });
      const hello = await this.send("hello", {});
      if (
        hello.version !== 2 ||
        !hello.capabilities?.read ||
        !hello.capabilities?.write
      ) {
        fail(new Error("Unsupported remote file protocol"));
        throw new Error("Unsupported remote file protocol");
      }
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  send(op, params) {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child) {
        reject(new Error("File channel is not connected"));
        return;
      }
      const id = ++this.sequence;
      const body = Buffer.from(JSON.stringify({ id, op, params }));
      if (body.length > MAX_FRAME) {
        reject(new Error("File request is too large"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Remote file request timed out"));
        // Drop this owned channel so queued data cannot grow without a bound.
        if (this.child === child) child.kill();
      }, this.timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      child.stdin.write(Buffer.concat([header, body]));
    });
  }
  async request(op, params) {
    await this.ready();
    return this.send(op, params);
  }
  async at(root, op, params = {}) {
    await this.ready();
    if (!this.bindings.has(root)) {
      const pending = this.send("bind", { path: root });
      this.bindings.set(root, pending);
      pending.catch(() => {
        if (this.bindings.get(root) === pending) this.bindings.delete(root);
      });
    }
    const binding = await this.bindings.get(root);
    return this.send(op, { ...params, root: binding.root });
  }
  release() {
    if (this.pending.size) return;
    const child = this.child;
    this.child = null;
    this.bindings.clear();
    child?.stdin.end();
    child?.kill();
  }
  dispose() {
    this.disposed = true;
    this.child?.kill();
    this.bindings.clear();
  }
}
function relative(root, file) {
  if (
    typeof root !== "string" ||
    typeof file !== "string" ||
    !root.startsWith("/") ||
    !file.startsWith("/") ||
    root.includes("\0") ||
    file.includes("\0")
  )
    throw new Error("Remote paths must be absolute");
  const rel = path.relative(root, file);
  if (rel === ".." || rel.startsWith("../"))
    throw Object.assign(new Error("File is outside the linked workspace"), {
      code: "NoPermissions",
    });
  return rel;
}
function entryNameError(name) {
  if (typeof name !== "string" || !name.trim())
    return "Enter a file or folder name";
  if (name === "." || name === ".." || /[\x00-\x1f\x7f/\\]/.test(name))
    return "Enter a name without path separators or control characters";
  if (Buffer.byteLength(name, "utf8") > 255) return "The name is too long";
}
class RemoteFiles extends EventEmitter {
  constructor(transport, { interval = 1200, timeout = 15000 } = {}) {
    super();
    this.channel = new FileChannel(transport, timeout);
    this.roots = new Set();
    this.watches = new Map();
    this.retries = new Map();
    this.connectionFailures = 0;
    this.connectionRetryAt = 0;
    this.interval = interval;
    this.active = 0;
    this.queue = [];
    this.disposed = false;
    this.channel.on("offline", (error) => {
      this.connectionRetryAt =
        Date.now() + this.retryDelay(++this.connectionFailures);
      this.emit("offline", error);
    });
  }
  retryDelay(failures) {
    return Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4));
  }
  retryNow() {
    this.retries.clear();
    this.connectionRetryAt = 0;
    return this.poll();
  }
  allow(root) {
    if (!root?.startsWith("/") || root.includes("\0"))
      throw new Error("Workspace root must be absolute");
    this.roots.add(path.resolve(root));
  }
  setRoots(roots) {
    this.roots = new Set([...roots].map((root) => path.resolve(root)));
    for (const root of this.retries.keys())
      if (!this.roots.has(root)) this.retries.delete(root);
    for (const [key, w] of this.watches)
      if (!this.roots.has(w.root)) this.watches.delete(key);
    if (!this.watches.size) {
      clearInterval(this.timer);
      this.timer = null;
      this.scheduleIdle();
    }
  }
  rootFor(file) {
    const root = [...this.roots]
      .sort((a, b) => b.length - a.length)
      .find((root) => {
        try {
          relative(root, file);
          return true;
        } catch {
          return false;
        }
      });
    if (!root)
      throw Object.assign(
        new Error("Link this session working directory before opening files"),
        { code: "NoPermissions" },
      );
    return root;
  }
  async limited(callback) {
    if (this.disposed) throw new Error("Remote files are closed");
    clearTimeout(this.idleTimer);
    if (this.active >= 4) {
      if (this.queue.length >= 128)
        throw new Error(
          "Too many remote file requests; try again after pending reads finish",
        );
      await new Promise((resolve, reject) =>
        this.queue.push({ resolve, reject }),
      );
    } else this.active++;
    try {
      if (this.disposed) throw new Error("Remote files are closed");
      return await callback();
    } finally {
      const next = this.queue.shift();
      if (next) next.resolve();
      else this.active--;
      if (!this.active && !this.watches.size) this.scheduleIdle();
    }
  }
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.active && !this.watches.size) this.channel.release();
    }, 30000);
    this.idleTimer.unref?.();
  }
  async call(file, op, params = {}, root = this.rootFor(file)) {
    root = path.resolve(root);
    if (!this.roots.has(root))
      throw Object.assign(
        new Error("This workspace root is no longer linked"),
        { code: "NoPermissions" },
      );
    return this.limited(() =>
      this.channel.at(root, op, { path: relative(root, file), ...params }),
    );
  }
  stat(file, root) {
    return this.call(file, "stat", {}, root);
  }
  list(file, offset = 0) {
    return this.call(file, "list", { offset, limit: 200 });
  }
  async create(file, kind, root) {
    const error = entryNameError(path.basename(file));
    if (error) throw new Error(error);
    if (!["file", "directory"].includes(kind))
      throw new Error("Unknown entry type");
    const result = await this.call(file, "create", { kind }, root);
    this.emit("change", file, { type: "created" });
    return result;
  }
  async write(file, data, options, root) {
    if (data.byteLength > MAX_FILE)
      throw new Error("Files larger than 16 MiB cannot be saved");
    const result = await this.call(
      file,
      "write",
      {
        data: Buffer.from(data).toString("base64"),
        create: Boolean(options.create),
        overwrite: Boolean(options.overwrite),
      },
      root,
    );
    this.emit("change", file, { type: result.created ? "created" : "changed" });
    return result;
  }
  async mkdir(file, root) {
    root ||= this.rootFor(file);
    const result = await this.call(file, "mkdir", {}, root);
    for (const rel of result.createdPaths)
      this.emit("change", path.join(root, rel), { type: "created" });
    return result;
  }
  async move(source, destination, options = {}, root) {
    root ||= [...this.roots]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => {
        try {
          relative(candidate, source);
          relative(candidate, destination);
          return true;
        } catch {
          return false;
        }
      });
    if (!root)
      throw Object.assign(new Error("Move files within one linked directory"), {
        code: "NoPermissions",
      });
    this.checkMutable(source);
    const result = await this.call(
      source,
      "rename",
      {
        destination: relative(root, destination),
        overwrite: Boolean(options.overwrite),
        expectedDestination: options.expectedDestination,
      },
      root,
    );
    this.emit("change", source, { type: "deleted" });
    this.emit("change", destination, {
      type: result.replaced ? "changed" : "created",
    });
    return result;
  }
  checkMutable(file) {
    file = path.resolve(file);
    for (const linked of this.roots)
      if (linked === file || linked.startsWith(file === "/" ? "/" : file + "/"))
        throw Object.assign(
          new Error(
            "A linked working directory cannot be renamed, moved or deleted",
          ),
          { code: "NoPermissions" },
        );
  }
  async remove(file, options = {}, root) {
    this.checkMutable(file);
    const result = await this.call(
      file,
      "delete",
      { recursive: Boolean(options.recursive) },
      root,
    );
    this.emit("change", file, { type: "deleted" });
    return result;
  }
  discardUpload(file, signature, root) {
    return this.call(file, "discardUpload", { signature }, root);
  }
  async chunk(file, offset, length, root) {
    const r = await this.call(file, "read", { offset, length }, root);
    return { ...r, data: Buffer.from(r.data, "base64") };
  }
  async read(file, limit = 16 * 1024 * 1024) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.chunk(file, 0, 262144);
      if (before.size > limit)
        throw new Error(
          `File exceeds the ${Math.round(limit / 1024 / 1024)} MiB viewing limit`,
        );
      const chunks = [before.data];
      let consistent = true;
      for (let start = 262144; start < before.size; start += 4 * 262144) {
        const offsets = [];
        for (
          let offset = start;
          offset < Math.min(before.size, start + 4 * 262144);
          offset += 262144
        )
          offsets.push(offset);
        const batch = await Promise.all(
          offsets.map((offset) =>
            this.chunk(file, offset, Math.min(262144, before.size - offset)),
          ),
        );
        for (const chunk of batch) {
          chunks.push(chunk.data);
          if (chunk.signature !== before.signature) consistent = false;
        }
      }
      const after = await this.stat(file);
      const data = Buffer.concat(chunks);
      if (
        consistent &&
        before.signature === after.signature &&
        data.length === after.size
      )
        return data;
    }
    throw new Error(
      "File is being replaced; retry after the Agent finishes saving",
    );
  }
  watch(file, root = this.rootFor(file)) {
    if (!this.roots.has(root))
      throw new Error("This workspace root is no longer linked");
    const key = JSON.stringify([root, file]);
    let watch = this.watches.get(key);
    if (!watch) {
      if (this.watches.size >= 512)
        throw new Error(
          "File watch limit reached; close unused files or previews",
        );
      watch = { root, file, count: 0, signature: undefined };
      this.watches.set(key, watch);
    }
    watch.count++;
    let released = false;
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.interval);
      this.timer.unref?.();
      this.poll();
    }
    return {
      dispose: () => {
        if (released) return;
        released = true;
        if (--watch.count === 0 && this.watches.get(key) === watch)
          this.watches.delete(key);
        if (!this.watches.size) {
          clearInterval(this.timer);
          this.timer = null;
          this.scheduleIdle();
        }
      },
    };
  }
  async poll() {
    if (this.polling || this.disposed || Date.now() < this.connectionRetryAt)
      return;
    this.polling = true;
    try {
      for (const root of new Set(
        [...this.watches.values()].map((w) => w.root),
      )) {
        if (!this.roots.has(root)) continue;
        if (Date.now() < (this.retries.get(root)?.at || 0)) continue;
        try {
          const watches = [...this.watches.values()].filter(
            (w) => w.root === root,
          );
          const data = await this.limited(() =>
            this.channel.at(root, "snapshot", {
              paths: watches.map((w) => relative(root, w.file)),
            }),
          );
          for (const [i, item] of data.entries()) {
            const w = watches[i];
            if (![...this.watches.values()].includes(w)) continue;
            if (w.signature !== item.signature) {
              const previous = w.signature;
              w.signature = item.signature;
              this.emit("change", w.file, {
                type:
                  item.signature === null
                    ? "deleted"
                    : previous === null
                      ? "created"
                      : "changed",
              });
            }
          }
          this.retries.delete(root);
          this.connectionFailures = 0;
          this.connectionRetryAt = 0;
          this.emit("online", root);
        } catch (error) {
          const failures = (this.retries.get(root)?.failures || 0) + 1;
          this.retries.set(root, {
            failures,
            at: Date.now() + this.retryDelay(failures),
          });
          this.emit("offline", error, root);
          if (Date.now() < this.connectionRetryAt) break;
        }
      }
    } finally {
      this.polling = false;
    }
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.idleTimer);
    this.watches.clear();
    this.retries.clear();
    for (const q of this.queue.splice(0))
      q.reject(new Error("Remote files are closed"));
    this.channel.dispose();
    this.removeAllListeners();
  }
}
module.exports = { FileChannel, RemoteFiles, relative, entryNameError };
