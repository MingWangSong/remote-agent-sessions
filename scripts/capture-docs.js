'use strict';
// Real extension + real tmux, isolated profile and synthetic public demo data.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {execFile}=require('node:child_process');const run=require('node:util').promisify(execFile);
(async()=>{
 const root=path.resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'tmuxdock-docs-'));
 const socket='tmuxdock-docs-'+Date.now(),user=path.join(temp,'profile'),driver=path.join(temp,'driver');
 const output=path.join(root,'media','showcase');await fs.mkdir(output,{recursive:true});await fs.mkdir(driver);await fs.mkdir(path.join(user,'User'),{recursive:true});
 const fake=path.join(temp,'ssh');await fs.writeFile(fake,'#!/bin/sh\nwhile [ "${1:-}" = "-o" ]; do shift 2; done\nif [ "${1:-}" = "-tt" ]; then shift; fi\nshift\nexec sh -c "$1"\n',{mode:0o700});
 await fs.writeFile(path.join(user,'User','settings.json'),JSON.stringify({'remoteAgentSessions.sshPath':fake,'remoteAgentSessions.refreshInterval':3600,'workbench.colorTheme':'Default Dark Modern','window.title':'TmuxDock · Demo workspace','workbench.startupEditor':'none','window.zoomLevel':0,'terminal.integrated.fontSize':15,'terminal.integrated.shellIntegration.enabled':false,'terminal.integrated.enablePersistentSessions':false,'telemetry.telemetryLevel':'off','update.mode':'none','security.workspace.trust.enabled':false,'workbench.tips.enabled':false}));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
 const done=path.join(temp,'done.json');
 await fs.writeFile(path.join(driver,'package.json'),JSON.stringify({name:'showcase-driver',publisher:'demo',version:'1.0.0',engines:{vscode:'^1.90.0'},main:'index.js',activationEvents:['onStartupFinished']}));
 await fs.copyFile(path.join(root,'integration','vscode','showcase.js'),path.join(driver,'scenario.js'));
 await fs.writeFile(path.join(driver,'index.js'),`const vscode=require('vscode');exports.activate=async()=>{let result;try{await require('./scenario').run();result={ok:true};}catch(e){result={ok:false,error:e.stack};}await require('node:fs/promises').writeFile(${JSON.stringify(done)},JSON.stringify(result));await vscode.commands.executeCommand('workbench.action.quit');};`);
 try{
 await run('/Applications/Visual Studio Code.app/Contents/MacOS/Code',['--user-data-dir',user,'--extensions-dir',path.join(temp,'extensions'),'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1','--extensionDevelopmentPath='+root,'--extensionDevelopmentPath='+driver],{env:{...process.env,SHOWCASE_PORT:String(port),SHOWCASE_SOCKET:socket,SHOWCASE_OUTPUT:output},timeout:120000,maxBuffer:2e6});
 const result=JSON.parse(await fs.readFile(done,'utf8'));if(!result.ok)throw Error(result.error);console.log('Captured three real workbench states in '+output);
 }finally{for(const s of [socket,socket+'-west'])await run('tmux',['-L',s,'kill-server']).catch(()=>{});await fs.rm(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
