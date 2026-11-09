"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { RemoteFiles, relative } = require("../src/remoteFiles");
const { PreviewServer, decodePath } = require("../src/previewService");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tmuxdock-files-"));
  let launches = 0;
  const transport = {
    openProcess: (file, args) => {
      launches++;
      return spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    },
  };
  const files = new RemoteFiles(transport, { interval: 80 });
  files.allow(dir);
  t.after(async () => {
    files.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, files, launches: () => launches };
}
async function eventual(fn) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await sleep(50);
  }
  throw Error("Timed out");
}
function request(server, file, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: file,
        method,
        headers: { Host: server.host + ":" + server.port, ...headers },
      },
      (res) => {
        const out = [];
        res.on("data", (b) => out.push(b));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(out),
          }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

test("remote files: one persistent channel handles unicode names, binary chunks and paginated directories", async (t) => {
  const f = await fixture(t);
  const name = "报告 ' #?%.txt";
  await fs.writeFile(path.join(f.dir, name), "中文内容");
  const data = Buffer.alloc(700000);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  await fs.writeFile(path.join(f.dir, "binary.dat"), data);
  await Promise.all(
    Array.from({ length: 205 }, (_, i) =>
      fs.writeFile(path.join(f.dir, "item-" + i), ""),
    ),
  );
  const first = await f.files.list(f.dir);
  assert.equal(first.entries.length, 200);
  assert.equal(first.total, 207);
  assert.equal(first.next, 200);
  assert.equal((await f.files.list(f.dir, 200)).entries.length, 7);
  assert.deepEqual(await f.files.read(path.join(f.dir, "binary.dat")), data);
  assert.equal(
    (await f.files.read(path.join(f.dir, name))).toString(),
    "中文内容",
  );
  assert.equal(f.launches(), 1);
});
test("remote files: roots are bounded and symlink replacement cannot read outside", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.dir, "outside");
  const root = path.join(f.dir, "root");
  await fs.mkdir(root);
  await fs.writeFile(outside, "secret");
  f.files.roots.clear();
  f.files.allow(root);
  await fs.symlink(outside, path.join(root, "escape"));
  await assert.rejects(f.files.read(outside), /outside|Link/);
  await assert.rejects(f.files.read(path.join(root, "escape")));
  await assert.rejects(
    f.files.channel.at(root, "read", { path: "../outside" }),
    /traversal/,
  );
  await assert.rejects(
    f.files.channel.at(root, "read", { path: "/absolute" }),
    /relative/,
  );
  assert.throws(() => relative(root, root + "-other/file"), /outside/);
  await f.files.stat(root);
  await fs.rename(root, root + "-old");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "new"), "wrong root");
  await assert.rejects(f.files.read(path.join(root, "new")), /root changed/);
});
test("remote files: atomic replacement, creation and removal are detected, with bounded subscribers", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "report.txt");
  await fs.writeFile(file, "first");
  const w = f.files.watch(file);
  const changes = [];
  f.files.on("change", (x) => changes.push(x));
  await eventual(() => changes.length > 0);
  changes.length = 0;
  await fs.writeFile(file + ".tmp", "replacement");
  await fs.rename(file + ".tmp", file);
  await eventual(() => changes.length > 0);
  assert.equal((await f.files.read(file)).toString(), "replacement");
  changes.length = 0;
  await fs.rm(file);
  await eventual(() => changes.length > 0);
  changes.length = 0;
  await fs.writeFile(file, "recreated");
  await eventual(() => changes.length > 0);
  w.dispose();
  assert.equal(f.files.watches.size, 0);
  assert.equal(f.files.timer, null);
});
test("remote files: a disconnected owned channel reconnects and rebinds; revoked roots are denied", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "a");
  await fs.writeFile(file, "a");
  await f.files.read(file);
  const closed = once(f.files.channel, "offline");
  f.files.channel.child.kill();
  await closed;
  assert.equal((await f.files.read(file)).toString(), "a");
  assert.equal(f.launches(), 2);
  f.files.roots.clear();
  await assert.rejects(f.files.stat(file), /Link/);
  await assert.rejects(f.files.stat(file, f.dir), /no longer linked/);
});
test("remote files: unsupported mutations are rejected and viewing size is capped", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "x"), "unchanged");
  await assert.rejects(
    f.files.channel.at(f.dir, "chmod", { path: "x" }),
    /Unsupported/,
  );
  assert.equal(await fs.readFile(path.join(f.dir, "x"), "utf8"), "unchanged");
  await assert.rejects(f.files.read(path.join(f.dir, "x"), 2), /viewing limit/);
});
test("remote files: cancelled chunked reads stop scheduling batches and keep the shared channel alive", async (t) => {
  const f = await fixture(t);
  const large = path.join(f.dir, "large.txt"), small = path.join(f.dir, "small.txt");
  await fs.writeFile(large, Buffer.alloc(3 * 1024 * 1024, 65));
  await fs.writeFile(small, "still available");
  const abort = new AbortController(), original = f.files.chunk;
  let chunks = 0;
  f.files.chunk = function (...args) { chunks++; return original.apply(this, args); };
  await assert.rejects(f.files.read(large, undefined, {
    signal: abort.signal,
    onProgress: ({ loaded, total }) => {
      assert.equal(loaded, 262144);
      assert.equal(total, 3 * 1024 * 1024);
      abort.abort();
    },
  }), { name: "AbortError" });
  assert.equal(chunks, 1);
  assert.equal((await f.files.read(small)).toString(), "still available");
  assert.equal(f.launches(), 1);
});
test("remote files: cancellation returns before an in-flight reply; unrelated reads and late failures remain safe", async (t) => {
  const f = await fixture(t), original = f.files.channel.at.bind(f.files.channel);
  const abort = new AbortController();
  let rejectLate, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.files.channel.at = (...args) => {
    if (args[1] === "read" && args[2].path === "slow") {
      started();
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    }
    return original(...args);
  };
  await fs.writeFile(path.join(f.dir, "other"), "other reader");
  const pending = f.files.read(path.join(f.dir, "slow"), undefined, { signal: abort.signal });
  await entered;
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await f.files.read(path.join(f.dir, "other"))).toString(), "other reader");
  rejectLate(Error("late network failure"));
  await eventual(() => f.files.active === 0);
  assert.equal(f.launches(), 1);
});
test("remote files: a failed root backs off without starving another root, and refresh retries explicitly", async (t) => {
  const files = new RemoteFiles({});
  t.after(() => files.dispose());
  files.setRoots(["/bad", "/good"]);
  for (const root of files.roots)
    files.watches.set(root, { root, file: root, count: 1 });
  const calls = [];
  const offline = [];
  files.on("offline", (_error, root) => offline.push(root));
  files.channel.at = async (root) => {
    calls.push(root);
    if (root === "/bad") throw new Error("Directory was replaced");
    return [{ signature: "stable" }];
  };
  await files.poll();
  await files.poll();
  assert.deepEqual(calls, ["/bad", "/good", "/good"]);
  assert.deepEqual(offline, ["/bad"]);
  assert.ok(files.retries.get("/bad").at > Date.now());
  files.channel.emit("offline", new Error("Connection lost"));
  await files.poll();
  assert.equal(calls.length, 3);
  await files.retryNow();
  assert.deepEqual(calls.slice(3), ["/bad", "/good"]);
  assert.equal(files.connectionFailures, 0);
  assert.equal(files.retryDelay(100), 30000);
  files.setRoots(["/good"]);
  assert.equal(files.retries.has("/bad"), false);
});
test("preview: real resources, range, root-relative URLs, independent origins and scope enforcement", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, "assets"));
  await fs.writeFile(
    path.join(f.dir, "index.html"),
    '<!doctype html><script src="/assets/main.js"></script>',
  );
  await fs.writeFile(path.join(f.dir, "assets", "main.js"), "window.demo=true");
  await fs.writeFile(path.join(f.dir, ".env"), "SECRET=demo");
  const server = await new PreviewServer(f.files, f.dir).start();
  const second = await new PreviewServer(f.files, f.dir).start();
  t.after(() => {
    server.dispose();
    second.dispose();
  });
  assert.notEqual(server.origin, second.origin);
  assert.equal((await request(server, "/")).status, 200);
  const js = await request(server, "/assets/main.js");
  assert.equal(js.body.toString(), "window.demo=true");
  assert.match(js.headers["content-type"], /javascript/);
  const range = await request(server, "/assets/main.js", {
    Range: "bytes=0-5",
  });
  assert.equal(range.status, 206);
  assert.equal(range.body.toString(), "window");
  assert.equal(
    (await request(server, "/assets/main.js", {}, "HEAD")).body.length,
    0,
  );
  assert.equal((await request(server, "/.env")).status, 403);
  assert.equal((await request(server, "/%2e%2e/secret")).status, 403);
  assert.equal(
    (await request(server, "/", { Host: "attacker.example" })).status,
    403,
  );
  assert.equal(
    (await request(server, "/", { Origin: second.origin })).status,
    403,
  );
  assert.equal((await request(server, "/", {}, "POST")).status, 405);
  assert.throws(() => decodePath("/%00bad"));
  assert.throws(() => decodePath("/%2e%2e/foo"));
});
test("preview: requested CSS changes notify only its preview and release all watch subscriptions", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "style.css"), "body{}");
  const server = await new PreviewServer(f.files, f.dir).start();
  t.after(() => server.dispose());
  let offline = 0,
    online = 0;
  server.on("offline", () => offline++);
  server.on("online", () => online++);
  f.files.emit("offline", new Error("Unrelated root"), "/other");
  assert.equal(offline, 0);
  f.files.emit("offline", new Error("Disconnected"));
  f.files.emit("online", f.dir);
  f.files.emit("online", f.dir);
  assert.equal(offline, 1);
  assert.equal(online, 1);
  await request(server, "/style.css");
  let changes = 0;
  server.on("change", () => changes++);
  await eventual(() =>
    [...f.files.watches.values()].some((w) => w.signature !== undefined),
  );
  changes = 0;
  await fs.writeFile(path.join(f.dir, "style.css"), "body{color:red}");
  await eventual(() => changes > 0);
  server.dispose();
  assert.equal(f.files.watches.size, 0);
  assert.equal(f.files.listenerCount("change"), 0);
  assert.equal(f.files.listenerCount("online"), 0);
});

test("preview: a missing referenced resource is watched and becomes available when created", async (t) => {
  const f = await fixture(t);
  const server = await new PreviewServer(f.files, f.dir).start();
  t.after(() => server.dispose());
  const file = path.join(f.dir, "later.css");
  assert.equal((await request(server, "/later.css")).status, 404);
  await eventual(() =>
    [...f.files.watches.values()].some(
      (w) => w.file === file && w.signature === null,
    ),
  );
  let changed = false;
  server.on("change", () => {
    changed = true;
  });
  await fs.writeFile(file, "body{}");
  await eventual(() => changed);
  assert.equal((await request(server, "/later.css")).status, 200);
});
