"use strict";

// This trusted preview helper runs before the document's CSP meta elements.
// The original policy and every original script are left untouched. In
// particular, script-src 'none' still blocks original scripts following it.
function trackPreviewSelection() {
  if (window.parent === window) return;
  const selectedText = () => {
    const element = document.activeElement;
    if (element?.tagName === "INPUT" || element?.tagName === "TEXTAREA") {
      if (element.type === "password") return "";
      if (typeof element.selectionStart === "number")
        return element.value.slice(element.selectionStart, element.selectionEnd);
    }
    return window.getSelection()?.toString() || "";
  };
  const report = () => window.parent.postMessage({ type: "tmuxdock-selection", text: selectedText() }, "*");
  for (const event of ["selectionchange", "focusin", "pointerup", "keyup"])
    document.addEventListener(event, report);
  window.addEventListener("message", event => {
    if (event.source === window.parent && event.data?.type === "tmuxdock-selection-request") report();
  });
  window.addEventListener("pagehide", () => window.parent.postMessage({ type: "tmuxdock-selection", text: "" }, "*"));
  document.addEventListener("keydown", event => {
    if (event.isTrusted && (event.ctrlKey || event.metaKey) && !event.altKey &&
        event.key.toLowerCase() === "c" && selectedText()) {
      report();
      // Use the browser's actual Copy operation in the frame with the selection,
      // not navigator.clipboard or an unrestricted extension clipboard command.
      if (document.execCommand("copy")) event.preventDefault();
    }
  }, true);
}

function installPreviewCopy(origin) {
  const frame = document.getElementById("page");
  let selection = "";
  window.addEventListener("message", event => {
    if (event.source === frame.contentWindow && event.origin === origin &&
        event.data?.type === "tmuxdock-selection" && typeof event.data.text === "string")
      selection = event.data.text;
  });
  frame.addEventListener("load", () => {
    selection = "";
    frame.contentWindow.postMessage({ type: "tmuxdock-selection-request" }, origin);
  });
  // VS Code's Copy action targets the containing webview on macOS. Supply only
  // the focused preview's selection to that native copy event. Page messages by
  // themselves cannot write or read the OS clipboard.
  document.addEventListener("copy", event => {
    if (event.isTrusted && document.activeElement === frame && selection && event.clipboardData) {
      event.clipboardData.setData("text/plain", selection);
      event.preventDefault();
    }
  });
}

function addPreviewSelectionHelper(prefix) {
  const source = prefix.toString("utf8");
  // Only parse the already fetched first chunk, never buffer a large report or
  // reserialize its HTML. Source locations avoid matching tags inside comments.
  const document = require("parse5").parse(source, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find(node => node.tagName === "html");
  const head = html?.childNodes.find(node => node.tagName === "head");
  const explicitHead = head?.sourceCodeLocation?.startTag?.endOffset;
  const offset = explicitHead ?? html?.sourceCodeLocation?.startTag?.endOffset ??
    document.childNodes.find(node => node.nodeName === "#documentType")?.sourceCodeLocation?.endOffset ?? 0;
  const script = `<script data-tmuxdock-copy>(${trackPreviewSelection.toString()})();</script>`;
  const insertion = explicitHead === undefined ? `<head>${script}</head>` : script;
  const byteOffset = Buffer.byteLength(source.slice(0, offset));
  return Buffer.concat([prefix.subarray(0, byteOffset), Buffer.from(insertion), prefix.subarray(byteOffset)]);
}

module.exports = { addPreviewSelectionHelper, installPreviewCopy };
