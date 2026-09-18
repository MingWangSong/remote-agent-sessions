'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionManager, preserveCommands } = require('../src/sessionManager');
const { SessionStore } = require('../src/store');
const { createRecord } = require('../src/model');

test('manager: failed creation retains durable recovery intent', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ras-intent-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const s=new SessionStore(path.join(dir,'sessions.json'));
  const m=new SessionManager(s,{list:async()=>[],create:async()=>{throw new Error('tmux unavailable');}});
  await assert.rejects(m.create({title:'Task',cwd:dir}),/tmux unavailable/);
  assert.equal((await s.load()).length,1);
  await m.refresh(); assert.equal(m.entries[0].status,'recoverable');
});
test('manager: tmux failure preserves visible history but never marks it recoverable', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ras-offline-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const s=new SessionStore(path.join(dir,'sessions.json'));
  await s.save([createRecord({tmuxSession:'task',cwd:dir})]);
  const m=new SessionManager(s,{list:async()=>{throw new Error('permission denied');}});
  await assert.rejects(m.refresh(),/permission denied/);
  assert.equal(m.entries[0].status,'unavailable');
  assert.equal(m.records.length,1);
});
test('manager: snapshots bind saved commands to pane IDs despite window rename/reorder', () => {
  const old=[{id:'@1',name:'old',panes:[{id:'%1',command:'agent resume id'},{id:'%2',command:'npm test'}]}];
  const fresh=[{id:'@1',name:'renamed',panes:[{id:'%2'},{id:'%1'},{id:'%3'}]}];
  assert.deepEqual(preserveCommands(fresh,old)[0].panes.map(p=>p.command),['npm test','agent resume id',null]);
});

test('manager delegates working-directory validation for SSH-backed paths', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ras-remote-check-'));
  const checks=[];
  const live=[];
  const tmux={
    list:async()=>live,
    create:async(name,cwd)=>{live.push({name,owner:null});return '%1';},
    setOwner:async(name,id)=>{live.find(s=>s.name===name).owner=id;},
    listWindows:async()=>[{id:'@1',name:'agent',cwd:'/remote/only/path',panes:[{id:'%1',cwd:'/remote/only/path',active:true}]}],
    select:async()=>{}, sendCommand:async()=>{}
  };
  const manager=new SessionManager(new SessionStore(path.join(dir,'sessions.json')),tmux,
    {inspect:async()=>({repoRoot:null,gitBranch:null})},async cwd=>checks.push(cwd));
  await manager.create({title:'Remote path',cwd:'/remote/only/path'});
  assert.ok(checks.includes('/remote/only/path'));
  await fs.rm(dir,{recursive:true,force:true});
});

test('manager renames and permanently deletes saved and pre-existing sessions safely', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ras-lifecycle-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const live=[];
  const tmux={
    list:async()=>structuredClone(live),
    create:async(name)=>{live.push({name,id:'$1',created:'2026-01-01T00:00:00.000Z',owner:null});return '%1';},
    setOwner:async(name,id)=>{live.find(s=>s.name===name).owner=id;},
    rename:async(oldName,newName)=>{live.find(s=>s.name===oldName).name=newName;},
    kill:async(name)=>live.splice(live.findIndex(s=>s.name===name),1),
    listWindows:async()=>[{id:'@1',name:'agent',cwd:dir,panes:[{id:'%1',cwd:dir,active:true}]}],
    select:async()=>{}, sendCommand:async()=>{}
  };
  const manager=new SessionManager(new SessionStore(path.join(dir,'sessions.json')),tmux,
    {inspect:async()=>({repoRoot:null,gitBranch:null})});
  const record=await manager.create({title:'Managed',cwd:dir});
  assert.equal(record.title,record.tmuxSession);
  await manager.renameSession(manager.entries[0],'Renamed managed','managed-new');
  assert.equal((await manager.store.load())[0].title,'Renamed managed');
  assert.equal(live[0].name,'managed-new');
  await manager.deleteSession(manager.entries[0]);
  assert.equal((await manager.store.load()).length,0);
  assert.equal(live.length,0);

  live.push({name:'manual',id:'$2',created:'2026-01-02T00:00:00.000Z',owner:null});
  await manager.refresh();
  await manager.renameSession(manager.entries[0],'manual','manual-new');
  await manager.refresh();
  assert.equal(manager.entries[0].tmuxSession,'manual-new');
  await manager.deleteSession(manager.entries[0]);
  assert.equal(live.length,0);
});
