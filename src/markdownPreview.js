"use strict";
const { randomBytes } = require("node:crypto");
const PREFIX = "tmuxdockPreview=";

function isMarkdownPreview(resource) {
  return resource?.scheme === "tmuxdock-remote" &&
    (resource.fragment.startsWith(PREFIX) || resource.query.startsWith(PREFIX));
}

function markdownPreviewUri(resource) {
  // Markdown's localResourceRoots inherits the document URI's query. Relative
  // images have no query, so a query-based tab identity fails containment.
  // Native resource containment ignores fragments; custom editors retain them.
  return resource.with({ query: "", fragment: PREFIX + randomBytes(8).toString("hex") });
}

module.exports = { isMarkdownPreview, markdownPreviewUri };
