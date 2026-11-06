"use strict";
// Reproducible product screenshots: disposable profile, synthetic files, real
// tmux and OpenSSH SFTP. Run on CI/Xvfb; never open the user's VS Code desktop.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), net = require("node:net");
const {execFile} = require("node:child_process");
const run = require("node:util").promisify(execFile);
const {downloadAndUnzipVSCode} = require("@vscode/test-electron");
(async () => {
  if (process.platform === "darwin" && !process.env.CI && process.env.RAS_ALLOW_LOCAL_UI !== "1")
    throw Error("Local GUI capture is disabled. Use the isolated CI showcase workflow.");
  const repo = path.resolve(__dirname,".."), temp = await fs.mkdtemp(path.join(os.tmpdir(),"tmuxdock-public-demo-"));
  const profile = path.join(temp,"profile"), driver = path.join(temp,"driver"), project = path.join(temp,"atlas-lab");
  const output = path.join(repo,"test-results","showcase"), socket = "tmuxdock-showcase-" + Date.now();
  for (const dir of [driver, project, output, path.join(profile,"User")]) await fs.mkdir(dir,{recursive:true});
  const server = process.platform === "darwin" ? "/usr/libexec/sftp-server" : "/usr/lib/openssh/sftp-server";
  await fs.access(server);
  const shim = path.join(temp,"ssh");
  await fs.writeFile(shim, `#!/bin/sh\nset -eu\nwhile [ "$#" -gt 0 ]; do\n case "$1" in\n -o|-F|-i|-p|-l|-J) shift 2;;\n -o?*|-F?*|-i?*|-p?*|-l?*|-J?*) shift;;\n -tt|-T|-s|-x|-a|-4|-6|-C|-q|-v|--) shift;;\n *) break;;\n esac\ndone\nshift\nif [ "\${1:-}" = "sftp" ]; then exec ${server}; fi\nif [ "$#" -eq 0 ]; then exec sh; fi\nexec sh -c "$1"\n`,{mode:0o700});
  for (const program of ["sftp","scp"]) await fs.symlink((await run("which",[program])).stdout.trim(), path.join(temp,program));
  await fs.writeFile(path.join(profile,"User","settings.json"),JSON.stringify({
    "remoteAgentSessions.sshPath":shim,"remoteAgentSessions.refreshInterval":3600,
    "workbench.colorTheme":"Default Dark Modern","workbench.iconTheme":"vs-seti",
    "window.title":"TmuxDock / Isolated public demo","window.zoomLevel":0,
    "workbench.startupEditor":"none","workbench.tips.enabled":false,
    "terminal.integrated.fontSize":14,"terminal.integrated.shellIntegration.enabled":false,
    "terminal.integrated.enablePersistentSessions":false,"security.workspace.trust.enabled":false,
    "editor.fontSize":14,"editor.minimap.enabled":false,"breadcrumbs.enabled":false,
    "telemetry.telemetryLevel":"off","update.mode":"none"
  }));
  const port = await new Promise(resolve => {const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const done = path.join(temp,"done.json");
  await fs.writeFile(path.join(driver,"package.json"),JSON.stringify({name:"workspace-showcase",publisher:"demo",version:"1.0.0",engines:{vscode:"^1.106.0"},main:"index.js",activationEvents:["onStartupFinished"]}));
  await fs.writeFile(path.join(driver,"index.js"),`const vscode=require('vscode');exports.activate=async()=>{let result;try{await require(${JSON.stringify(path.join(repo,"integration","vscode","workspaceShowcase.js"))}).run();result={ok:true};}catch(e){result={ok:false,error:e.stack};}await require('node:fs/promises').writeFile(${JSON.stringify(done)},JSON.stringify(result));await vscode.commands.executeCommand('workbench.action.quit');};`);
  try {
    const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : await downloadAndUnzipVSCode({version:"stable"}));
    const args=[project,"--user-data-dir",profile,"--extensions-dir",path.join(temp,"extensions"),"--disable-extensions","--disable-workspace-trust","--skip-welcome","--skip-release-notes","--remote-debugging-port="+port,"--remote-debugging-address=127.0.0.1","--extensionDevelopmentPath="+repo,"--extensionDevelopmentPath="+driver];
    if (process.platform === "linux") args.push("--no-sandbox","--disable-gpu-sandbox");
    await run(executable,args,{env:{...process.env,SHOWCASE_PORT:String(port),SHOWCASE_SOCKET:socket,SHOWCASE_OUTPUT:output,SHOWCASE_PROJECT:project,SHOWCASE_TEMP:temp},timeout:180000,maxBuffer:4e6});
    const result=JSON.parse(await fs.readFile(done,"utf8"));if(!result.ok) throw Error(result.error);
    console.log("Captured synthetic workspace screenshots: "+output);
  } finally {
    for (const s of [socket,socket+"-west"]) await run("tmux",["-L",s,"kill-server"]).catch(()=>{});
    await fs.rm(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
