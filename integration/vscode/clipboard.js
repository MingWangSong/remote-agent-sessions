"use strict";
const vscode = require("vscode"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { PreviewServer } = require("../../src/previewService");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Connect only to the loopback debugger of this isolated CI test application.
async function browser() {
  const info = await fetch(`http://127.0.0.1:${process.env.RAS_TEST_DEBUG_PORT}/json/version`).then(r => r.json());
  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(), contexts = new Map(), sessions = new Map();
  let sequence = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.executionContextCreated") contexts.set(message.sessionId + ":" + message.params.context.id, { ...message.params.context, session: message.sessionId });
    if (message.method === "Runtime.executionContextDestroyed") contexts.delete(message.sessionId + ":" + message.params.executionContextId);
    if (message.method === "Runtime.executionContextsCleared")
      for (const [key, context] of contexts) if (context.session === message.sessionId) contexts.delete(key);
    if (!pending.has(message.id)) return;
    const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Clipboard debugger timeout: " + method)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const evaluate = async (context, expression) => {
    const response = await send("Runtime.evaluate", { expression, contextId: context.id, returnByValue: true, awaitPromise: true, userGesture: true }, context.session);
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  };
  const find = async (origin, host = false) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { targetInfos } = await send("Target.getTargets");
      for (const target of targetInfos.filter(t => t.url.startsWith(origin) || t.url.startsWith("vscode-webview:") || t.url.includes("workbench"))) {
        try {
          let session = sessions.get(target.targetId);
          if (!session) {
            ({ sessionId: session } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
            sessions.set(target.targetId, session);
            await send("Runtime.enable", {}, session);
          }
          for (const context of contexts.values()) {
            if (context.session !== session || !context.auxData?.isDefault) continue;
            const matches = await evaluate(context, host
              ? `document.getElementById('page')?.src.startsWith(${JSON.stringify(origin)}) || false`
              : `location.origin === ${JSON.stringify(origin)} && !!document.getElementById('copy-target')`);
            if (matches) return context;
          }
        } catch { /* A hidden/reloading webview may replace its context. */ }
      }
      await pause(100);
    }
    throw Error("Clipboard document did not become ready: " + origin + (host ? " (host)" : ""));
  };
  const pressCopy = async modifiers => {
    const { targetInfos } = await send("Target.getTargets");
    const target = targetInfos.find(t => t.type === "page" && t.url.includes("workbench"));
    assert.ok(target, "The isolated workbench must receive the native shortcut");
    let session = sessions.get(target.targetId);
    if (!session) {
      ({ sessionId: session } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
      sessions.set(target.targetId, session);
      await send("Runtime.enable", {}, session);
    }
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers }, session);
  };
  return { send, evaluate, find, pressCopy, close: () => socket.close() };
}

exports.run = async (files, controller, root, originalPreview, check) => {
  const client = await browser(), clipboard = await vscode.env.clipboard.readText();
  const report = { legacy: null, checks: [] }, previews = [];
  const target = path.join(root, "clipboard-report.html");
  const text = "复制渲染文字 · Unicode\nconst answer = 42;\nsecond line";
  const html = strict => `<!doctype html><html><head>${strict ? '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'">' : ''}<style>body{background:#123;color:white}</style></head><body><pre id="copy-target">${text}</pre><input id="copy-input" value="field text 中文"><script>window.pageScriptRan=true;</script></body></html>`;
  const select = async preview => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const context = await client.find(preview.server.origin);
        const selected = await client.evaluate(context, `(()=>{const node=document.getElementById('copy-target');node.tabIndex=0;node.focus();const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();})()`);
        assert.equal(selected, text);
        await pause(400); // Native focus tracking polls at 250ms; initial watch events can also reload once.
        if (await client.evaluate(context, "window.getSelection().toString()") === text) return context;
      } catch (error) { if (attempt === 19) throw error; }
    }
    throw Error("HTML selection did not remain stable after loading");
  };
  const expectClipboard = async expected => {
    for (let i = 0; i < 50; i++) {
      if (await vscode.env.clipboard.readText() === expected) return;
      await pause(50);
    }
    assert.equal(await vscode.env.clipboard.readText(), expected);
  };
  try {
    await fs.writeFile(target, html(false));
    await check("HTML clipboard: rendered selection reaches the real clipboard through VS Code Copy and Ctrl/Cmd+C", async () => {
      const baselineServer = await new PreviewServer(files.service(controller), root).start();
      const baselinePanel = vscode.window.createWebviewPanel("tmuxdock.copy-baseline", "Clipboard baseline", vscode.ViewColumn.Active, { enableScripts: true });
      try {
        baselinePanel.webview.html = `<html><body><iframe id="page" style="width:100%;height:600px" sandbox="allow-scripts allow-same-origin allow-forms" src="${baselineServer.url(target)}"></iframe></body></html>`;
        const baseline = { server: baselineServer };
        await select(baseline);
        await vscode.env.clipboard.writeText("baseline sentinel");
        const host = await client.find(baselineServer.origin, true);
        // This is the native document.execCommand used by VS Code's webview Copy handler.
        await client.evaluate(host, "document.execCommand('copy')");
        await pause(100);
        report.legacy = { selected: text, actualClipboard: await vscode.env.clipboard.readText() };
      } finally { baselinePanel.dispose(); baselineServer.dispose(); }
      const preview = await files.preview({ uri: vscode.Uri.from({ scheme: "tmuxdock-remote", authority: controller.host.id, path: target }), context: files.current });
      previews.push(preview);
      await select(preview);
      await vscode.env.clipboard.writeText("command sentinel");
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
      await expectClipboard(text);
      report.checks.push("Native VS Code Copy copies the nested frame's Unicode/multiline selection");
      for (const modifiers of [2, 4]) {
        await select(preview);
        await vscode.env.clipboard.writeText("shortcut sentinel");
        await client.pressCopy(modifiers);
        await expectClipboard(text);
      }
      report.checks.push("Trusted Ctrl+C and Cmd+C copy without reading clipboard permissions");
    });
    await check("HTML clipboard: copy survives strict CSP while original page scripts remain blocked", async () => {
      const strictHtml = html(true);
      await fs.writeFile(target, strictHtml);
      const preview = await files.preview({ uri: vscode.Uri.from({ scheme: "tmuxdock-remote", authority: controller.host.id, path: target }), context: files.current });
      previews.push(preview);
      const context = await select(preview);
      assert.equal(await client.evaluate(context, "window.pageScriptRan === true"), false);
      await vscode.env.clipboard.writeText("CSP sentinel");
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
      await expectClipboard(text);
      assert.equal(await fs.readFile(target, "utf8"), strictHtml);
      report.checks.push("CSP script-src none still blocks page scripts; original HTML bytes are unchanged");
      await client.evaluate(context, "window.getSelection().removeAllRanges()");
      await pause(100);
      await vscode.env.clipboard.writeText("empty selection sentinel");
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
      await pause(100);
      assert.equal(await vscode.env.clipboard.readText(), "empty selection sentinel");
      report.checks.push("An empty selection does not copy stale text from another preview");
    });
  } finally {
    await fs.mkdir(path.dirname(process.env.RAS_TEST_REPORT), { recursive: true });
    await fs.writeFile(path.join(path.dirname(process.env.RAS_TEST_REPORT), "clipboard-results.json"), JSON.stringify(report, null, 2));
    for (const preview of previews) preview.panel.dispose();
    await fs.rm(target, { force: true });
    originalPreview.panel.reveal();
    await vscode.env.clipboard.writeText(clipboard);
    client.close();
  }
};
