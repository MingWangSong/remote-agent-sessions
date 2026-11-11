"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { markdownPreviewUri, isMarkdownPreview } = require("../src/markdownPreview");

function resource(values = {}) {
  return { scheme: "tmuxdock-remote", authority: "host", path: "/work/article/article.md", query: "", fragment: "",
    ...values, with(changes) { return resource({ ...this, ...changes }); } };
}

test("Markdown previews keep distinct native identities without adding image-root queries", () => {
  const source = resource(), first = markdownPreviewUri(source), second = markdownPreviewUri(source);
  assert.equal(first.query, "");
  assert.notEqual(first.fragment, second.fragment);
  assert.equal(first.scheme, source.scheme);
  assert.equal(first.authority, source.authority);
  assert.equal(first.path, source.path);
  assert.equal(source.fragment, "");
  assert.ok(isMarkdownPreview(first));
  assert.ok(isMarkdownPreview(resource({ query: "tmuxdockPreview=old-tab" })));
  assert.equal(isMarkdownPreview(source), false);
  assert.equal(isMarkdownPreview(resource({ scheme: "file", fragment: first.fragment })), false);
  assert.equal(markdownPreviewUri(first).query, "");
});
