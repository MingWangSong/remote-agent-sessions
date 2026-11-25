"use strict";
const http = require("node:http");
const path = require("node:path").posix;
const { randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};
function denied(parts) {
  return parts.some((p) =>
    /^(?:\.git|\.ssh|\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|key))$/i.test(
      p,
    ),
  );
}
function decodePath(raw) {
  const encoded = raw.split("?")[0];
  let file;
  try {
    file = decodeURIComponent(encoded);
  } catch {
    throw new Error("Invalid resource URL");
  }
  if (
    !file.startsWith("/") ||
    file.includes("\0") ||
    file.includes("\\") ||
    file.split("/").includes("..") ||
    denied(file.split("/"))
  )
    throw new Error("Resource is outside the preview scope");
  return file;
}
class PreviewServer extends EventEmitter {
  constructor(files, root, { clipboard = false, watch = true } = {}) {
    super();
    this.files = files;
    this.root = path.resolve(root);
    this.clipboard = clipboard;
    this.watch = watch;
    this.host = randomBytes(20).toString("hex") + ".localhost";
    this.subscriptions = new Map();
    this.rendered = new Map();
    this.sockets = new Set();
    this.closed = false;
    this.changed = (file, change) => {
      if (!this.subscriptions.has(file)) return;
      // The first watch snapshot can arrive after the page has loaded. Reload
      // only when it differs from the resource already delivered to the page.
      if (change?.signature && change.signature === this.rendered.get(file)) return;
      this.emit("change", file);
    };
    this.offline = (error, root) => {
      if (!root || root === this.root) {
        this.unavailable = true;
        this.emit("offline", error);
      }
    };
    this.online = (root) => {
      if (root === this.root && this.unavailable) {
        this.unavailable = false;
        this.emit("online");
      }
    };
    if (watch) files.on("change", this.changed);
    files.on("offline", this.offline);
    files.on("online", this.online);
  }
  async start(file, address) {
    if (address) {
      if (!validPreviewAddress(address)) throw new Error("Invalid saved preview address");
      this.host = address.host;
    }
    if (!file) await this.files.stat(this.root, this.root);
    else if (this.watch) this.watchFile(file);
    this.server = http.createServer((req, res) =>
      this.serve(req, res).catch((error) => {
        const interrupted = this.unavailable || this.files.isOffline?.(this.root) || error.code === "RemoteFileTimeout";
        if (interrupted) this.emit("interrupted");
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (interrupted && this.browser && req.method === "GET" && req.headers["sec-fetch-dest"] === "document") {
          res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'", "Retry-After": "3" });
          res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3">' +
            '<title>TmuxDock · Reconnecting</title><h1>Reconnecting to the remote host…</h1>' +
            '<p>This preview will retry automatically.</p>');
          return;
        }
        res.writeHead(error.code === "NotFound" ? 404 : 403, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          "Preview resource unavailable. Check the linked directory, permissions and connection.",
        );
      }),
    );
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 20000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(address?.port || 0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this.origin = `http://${this.host}:${this.port}`;
    return this;
  }
  url(file) {
    const rel = require("./remoteFiles").relative(this.root, file);
    return this.origin + "/" + rel.split("/").map(encodeURIComponent).join("/");
  }
  watchFile(file) {
    if (this.watch && !this.subscriptions.has(file))
      this.subscriptions.set(file, this.files.watch(file, this.root));
  }
  async serve(req, res) {
    if (
      this.closed ||
      req.headers.host?.toLowerCase() !== `${this.host}:${this.port}`
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.headers.origin && req.headers.origin !== this.origin) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    let rel = decodePath(req.url).replace(/^\/+/, "");
    let file = path.join(this.root, rel);
    this.watchFile(file);
    let prefetched;
    let info;
    if (req.method === "GET" && !req.headers.range && path.extname(file)) {
      prefetched = await this.files.chunk(file, 0, 262144, this.root);
      info = prefetched;
    } else info = await this.files.stat(file, this.root);
    if (info.type === "directory") {
      file = path.join(file, "index.html");
      info = await this.files.stat(file, this.root);
    }
    if (info.type !== "file" || info.size > 128 * 1024 * 1024)
      throw new Error("Unsupported preview resource");
    this.watchFile(file);
    const headers = {
      "Content-Type":
        MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Accept-Ranges": "bytes",
    };
    let first = 0,
      last = info.size - 1,
      status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
      if (!match[1]) first = Math.max(0, info.size - Number(match[2]));
      else {
        first = Number(match[1]);
        if (match[2]) last = Math.min(last, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        first > last ||
        first >= info.size
      ) {
        res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${first}-${last}/${info.size}`;
    }
    headers["Content-Length"] = Math.max(0, last - first + 1);
    let firstChunk;
    if (this.clipboard && /\.html?$/i.test(file) && !req.headers.range) {
      if (req.method === "HEAD") delete headers["Content-Length"];
      else {
        prefetched ||= await this.files.chunk(file, 0, 262144, this.root);
        if (prefetched.signature !== info.signature) throw new Error("Preview changed while loading");
        firstChunk = require("./previewClipboard").addPreviewSelectionHelper(prefetched.data);
        headers["Content-Length"] += firstChunk.length - prefetched.data.length;
      }
    }
    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (firstChunk && info.size === 0) {
      if (this.watch) this.rendered.set(file, info.signature);
      res.end(firstChunk);
      return;
    }
    for (
      let offset = first;
      offset <= last && !res.destroyed;
      offset += 262144
    ) {
      const result =
        offset === 0 && prefetched
          ? prefetched
          : await this.files.chunk(
              file,
              offset,
              Math.min(262144, last - offset + 1),
              this.root,
            );
      if (result.signature !== info.signature || !result.data.length) {
        res.destroy();
        return;
      }
      if (!res.write(offset === 0 && firstChunk ? firstChunk : result.data))
        await new Promise((resolve) => {
          res.once("drain", done);
          res.once("close", done);
          function done() {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          }
        });
    }
    if (this.watch && !res.destroyed) this.rendered.set(file, info.signature);
    res.end();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.files.off("change", this.changed);
    this.files.off("offline", this.offline);
    this.files.off("online", this.online);
    for (const s of this.subscriptions.values()) s.dispose();
    this.subscriptions.clear();
    this.rendered.clear();
    this.server?.close();
    for (const s of this.sockets) s.destroy();
    this.removeAllListeners();
  }
}
function validPreviewAddress(address) {
  return /^[a-f0-9]{40}\.localhost$/.test(address?.host || "") &&
    Number.isInteger(address.port) && address.port >= 1024 && address.port <= 65535;
}
module.exports = { PreviewServer, decodePath, denied, validPreviewAddress };
