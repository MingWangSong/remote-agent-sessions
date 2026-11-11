"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { Writable, PassThrough } = require("node:stream");
const { FileChannel } = require("../src/remoteFiles");

function fixture(t, { delay = 0, fragmentBytes = 65536, fragmentDelay = 0, stall = false } = {}) {
  let launches = 0;
  const transport = { openProcess() {
    launches++;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    // A real SSH child keeps the event loop alive even when it is silent.
    // Keep that property in this in-memory transport while its timer is unref'd.
    const alive = setInterval(() => {}, 1000);
    let input = Buffer.alloc(0), queue = [], busy = false, ended = false, timer;
    const next = () => {
      if (busy || ended || !queue.length) return;
      const request = queue.shift(); busy = true;
      if (request.op === "stall" && stall) return;
      const result = request.op === "hello"
        ? { version: 2, capabilities: { read: true, write: true } }
        : { index: request.params.index, content: request.params.content || "ok" };
      const body = Buffer.from(JSON.stringify({ id: request.id, result }));
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      const frame = Buffer.concat([header, body]);
      let offset = 0;
      const emit = () => {
        if (ended) return;
        const end = request.op === "hello" ? frame.length : Math.min(frame.length, offset + fragmentBytes);
        child.stdout.write(frame.subarray(offset, end)); offset = end;
        if (offset < frame.length) timer = setTimeout(emit, fragmentDelay);
        else { busy = false; next(); }
      };
      timer = setTimeout(emit, request.op === "hello" ? 0 : delay);
    };
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      input = Buffer.concat([input, bytes]);
      while (input.length >= 4 && input.length >= 4 + input.readUInt32BE()) {
        const length = input.readUInt32BE();
        queue.push(JSON.parse(input.subarray(4, 4 + length))); input = input.subarray(4 + length);
      }
      next(); done();
    } });
    child.kill = () => {
      if (ended) return;
      ended = true; clearTimeout(timer); clearInterval(alive); queue = [];
      setImmediate(() => child.emit("exit", null));
    };
    return child;
  } };
  const channel = new FileChannel(transport, 120);
  t.after(() => channel.dispose());
  return { channel, launches: () => launches };
}

test("file channel: queued replies get their timeout after preceding responses finish", async t => {
  const f = fixture(t, { delay: 65 });
  const replies = await Promise.all([0, 1, 2, 3].map(index => f.channel.request("stat", { index })));
  assert.deepEqual(replies.map(reply => reply.index), [0, 1, 2, 3]);
  assert.equal(f.channel.pending.size, 0);
  assert.equal(f.launches(), 1);
});

test("file channel: a response arriving in fragments stays alive while bytes make progress", async t => {
  const f = fixture(t, { fragmentBytes: 48, fragmentDelay: 20 });
  const content = "binary response".repeat(50);
  assert.equal((await f.channel.request("read", { content })).content, content);
  assert.equal(f.channel.pending.size, 0);
  assert.equal(f.launches(), 1);
});

test("file channel: a genuinely silent request times out, clears its queue and reconnects", async t => {
  const f = fixture(t, { stall: true });
  const offline = once(f.channel, "offline");
  const results = await Promise.allSettled([
    f.channel.request("stall", {}), f.channel.request("stat", { index: 1 }),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /timed out/);
  assert.equal(results[1].status, "rejected");
  await offline;
  assert.equal(f.channel.pending.size, 0);
  assert.equal((await f.channel.request("stat", { index: 2 })).index, 2);
  assert.equal(f.launches(), 2);
});
