'use strict';
const vscode=require('vscode'),fs=require('node:fs/promises'),path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
exports.run=async()=>{
 const targets=await fetch('http://127.0.0.1:'+process.env.SHOWCASE_PORT+'/json/list').then(r=>r.json());
 const target=targets.find(t=>t.type==='page'&&t.url.includes('workbench'));
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const calls=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(calls.has(m.id)){const [resolve,reject]=calls.get(m.id);calls.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}});
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;calls.set(id,[resolve,reject]);ws.send(JSON.stringify({id,method,params}));});
 const capture=async name=>{await vscode.commands.executeCommand('notifications.clearAll');await vscode.commands.executeCommand('notifications.hideToasts');await pause(1400);await cdp('Runtime.evaluate',{expression:'document.fonts.ready',awaitPromise:true});const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(process.env.SHOWCASE_OUTPUT,name+'.png'),Buffer.from(shot.data,'base64'));};
 try{
 await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:760,deviceScaleFactor:1,mobile:false});
 const api=await vscode.extensions.getExtension('mingwangsong.remote-agent-sessions').activate();
 await vscode.commands.executeCommand('workbench.view.extension.remoteAgentSessions');
 const hosts=[];
 for(const [label,alias,suffix]of [['DEMO · East','demo-east',''],['DEMO · West','demo-west','-west']])hosts.push(await api.registry.add({label,sshHost:alias,defaultCwd:'/tmp',socketName:process.env.SHOWCASE_SOCKET+suffix}));
 await api.provider.reloadHosts();
 const east=api.controllers.find(c=>c.host.id===hosts[0].id),west=api.controllers.find(c=>c.host.id===hosts[1].id);
 await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
 await vscode.commands.executeCommand('notifications.clearAll');
 for(const c of [east,west]){await c.tmux.create('bootstrap','/tmp');for(const [key,value]of [['status-right','DEMO / ISOLATED'],['status-left','#S '],['default-shell','/bin/sh'],['default-command',"env PS1='$ ' /bin/sh"]])await c.tmux.run(['set-option','-g',key,value]);}
 const tasks=[];
 for(const [title,type]of [['atlas-codex','codex'],['review-claude','claude'],['build-shell','shell']]){
 const record=await east.manager.create({title,cwd:'/tmp'});
 // Display identity only. No synthetic AI answer or paid model request.
 if(type!=='shell')await east.manager.edit(record,r=>{r.agent={type,manualRestore:true};});
 const entry=east.manager.entries.find(e=>e.id===record.id);await api.attachEntry(east,entry);tasks.push(record);
 }
 await west.manager.create({title:'release-check',cwd:'/tmp'});
 for(const c of [east,west])await c.tmux.kill('bootstrap');
 const idle=await east.manager.create({title:'docs-preview',cwd:'/tmp'});await east.manager.deleteSession(idle);
 await api.provider.refresh(undefined,false);
 const expand=async()=>{for(const h of api.provider.getChildren()){await api.view.reveal(h,{expand:true,focus:false});for(const g of api.provider.getChildren(h))await api.view.reveal(g,{expand:true,focus:false});}};
 await expand();
 const shell=tasks[2];const pane=(await east.tmux.listWindows(shell.tmuxSession))[0].panes[0].id;
 const say=async lines=>{await east.tmux.sendCommand(shell.tmuxSession,pane,"export PS1='$ '; clear; printf '%s\\n' "+lines.map(s=>"'"+s.replace(/'/g,"'\"'\"'")+"'").join(' '));};
 await say(['TMUXDOCK / DEMO WORKSPACE','','  Real tmux sessions. One VS Code workspace.','','  atlas-codex     Agent identity: Codex','  review-claude   Agent identity: Claude','  build-shell     Active shell task','','  SSH aliases and task data are synthetic.','  No private host, credential or conversation is shown.']);
 await capture('01-workspace');
 await east.tmux.sendCommand(shell.tmuxSession,pane,'cd /tmp; clear');await pause(300);
 await east.manager.deleteSession(shell);await api.provider.refresh(east,false);await expand();
 await east.tmux.sendCommand(tasks[1].tmuxSession,(await east.tmux.listWindows(tasks[1].tmuxSession))[0].panes[0].id,"clear; printf '%s\\n' 'WORKSPACE SAVED' '' 'build-shell is now Stopped / Recoverable.' 'Select it in the sidebar to rebuild the workspace.'");
 await capture('02-recoverable');
 await east.manager.restore(shell,false);await api.provider.refresh(east,false);
 await api.attachEntry(east,east.manager.entries.find(e=>e.id===shell.id));await expand();
 const p=(await east.tmux.listWindows(shell.tmuxSession))[0].panes[0].id;
 await east.tmux.sendCommand(shell.tmuxSession,p,"export PS1='$ '; clear; printf '\\n  RESTORE COMPLETE\\n\\n  Session  : build-shell\\n  Directory: '; pwd; printf '\\n  Same tmux name. Saved working directory.\\n  Shell workspace rebuilt from its saved record.\\n\\n'");
 await capture('03-restored');
 }finally{ws.close();}
};
