"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const { addPreviewSelectionHelper, installPreviewCopy } = require("../src/previewClipboard");

test("preview copy: insertion preserves doctype, head attributes, original CSP and every original byte", () => {
  for (const source of [
    '<!doctype html><!-- <head> fake --><html lang="zh"><head id="real"><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head><body>中文</body></html>',
    '<!DOCTYPE html><html><body>no head</body></html>',
    '<p>fragment without doctype</p>', '',
  ]) {
    const result = addPreviewSelectionHelper(Buffer.from(source)).toString();
    assert.equal(result.replace(/<script data-tmuxdock-copy>[\s\S]*?<\/script>/, '').replace(/<head><\/head>/, ''), source);
    if (source.includes('id="real"')) {
      assert.ok(result.indexOf('data-tmuxdock-copy') > result.indexOf('<head id="real">'));
      assert.ok(result.indexOf('data-tmuxdock-copy') < result.indexOf('http-equiv'));
    }
    if (source.startsWith('<!')) assert.ok(result.startsWith(source.slice(0, source.indexOf('>') + 1)));
  }
  const original = Buffer.from('<!doctype html><head></head><body>' + '中'.repeat(90000));
  const prefix = original.subarray(0, 262144);
  const transformed = addPreviewSelectionHelper(prefix);
  const start = transformed.indexOf('<script data-tmuxdock-copy>'), end = transformed.indexOf('</script>', start) + 9;
  assert.deepEqual(Buffer.concat([transformed.subarray(0, start), transformed.subarray(end)]), prefix);
});

test("preview copy: only the owned frame can supply text, and only a focused native Copy event consumes it", () => {
  const events = {}, documentEvents = {}, frameEvents = {}, messages = [], copied = [];
  const frame = { contentWindow: { postMessage: (...args) => messages.push(args) }, addEventListener: (type, fn) => { frameEvents[type] = fn; } };
  const document = { getElementById: () => frame, activeElement: frame, addEventListener: (type, fn) => { documentEvents[type] = fn; } };
  const window = { addEventListener: (type, fn) => { events[type] = fn; } };
  vm.runInNewContext(`(${installPreviewCopy.toString()})("http://owned.localhost:1234")`, { window, document });
  const copy = (trusted = true) => documentEvents.copy({ isTrusted: trusted, clipboardData: { setData: (...args) => copied.push(args) }, preventDefault() {} });
  const send = (origin, source, text) => events.message({ origin, source, data: { type: "tmuxdock-selection", text } });
  send('http://other.localhost:1234', frame.contentWindow, 'wrong origin'); copy();
  send('http://owned.localhost:1234', {}, 'wrong frame'); copy();
  assert.equal(copied.length, 0);
  send('http://owned.localhost:1234', frame.contentWindow, '选择的文字');
  assert.equal(copied.length, 0, 'Selection messages cannot write the clipboard');
  copy(false); assert.equal(copied.length, 0);
  document.activeElement = {}; copy(); assert.equal(copied.length, 0);
  document.activeElement = frame; copy(); assert.deepEqual(copied, [['text/plain', '选择的文字']]);
  frameEvents.load(); copy(); assert.equal(copied.length, 1, 'Navigation clears the old selection');
  assert.equal(messages.length, 1);
  send('http://owned.localhost:1234', frame.contentWindow, ''); copy(); assert.equal(copied.length, 1);
});
