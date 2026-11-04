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

test('manager renames and deletes sessions with recovery records retained', async (t) => {
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
  assert.equal((await manager.store.load()).length,1);
  assert.equal(manager.entries[0].status,'recoverable');
  await manager.forget(record);
  assert.equal(live.length,0);

  live.push({name:'manual',id:'$2',created:'2026-01-02T00:00:00.000Z',owner:null});
  await manager.refresh();
  await manager.renameSession(manager.entries[0],'manual','manual-new');
  await manager.refresh();
  assert.equal(manager.entries[0].tmuxSession,'manual-new');
  await manager.deleteSession(manager.entries[0]);
  assert.equal(live.length,0);
});

test('background snapshot does not hold database lock or block a fast refresh, and preserves foreground edits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-snapshot-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  const record = createRecord({ id: 'record', tmuxSession: 'task', cwd: dir,
    windows: [{ name: 'agent', panes: [{ id: '%1', cwd: dir, command: 'old' }] }] });
  record.identityVersion = 1;
  await store.save([record]);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new SessionManager(store, {
    list: async () => [{ name: 'task', owner: 'record', id: '$1' }],
    listWindows: async () => { entered(); await gate; return [{ name: 'agent', panes: [{ id: '%1', cwd: dir }] }]; }
  }, { inspect: async () => ({ repoRoot: null, gitBranch: null }) });
  const background = manager.refresh();
  await started;
  try {
    await Promise.race([
      manager.setCommand(record, 0, 0, 'new'),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('snapshot blocked command')), 2000); timer.unref(); })
    ]);
    await manager.setNote(record, 'foreground note');
  } finally { release(); }
  await background;
  const saved = (await store.load())[0];
  assert.equal(saved.note, 'foreground note');
  assert.equal(saved.windows[0].panes[0].command, 'new');
  assert.equal(manager.entries[0].status, 'live');
});

test('notes, attach bookkeeping and forgetting are local and preserve the last observed live state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-local-edit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  const record = createRecord({ id: 'local', tmuxSession: 'task', cwd: dir });
  record.identityVersion = 1; await store.save([record]);
  let calls = 0, offline = false;
  const manager = new SessionManager(store, { list: async () => {
    calls++; if (offline) throw new Error('offline');
    return [{ name: 'task', owner: 'local', id: '$1' }];
  } });
  await manager.refresh(false); const before = calls;
  await manager.setNote(record, 'fast note'); await manager.markAttached(record);
  assert.equal(calls, before);
  assert.equal(manager.entries[0].status, 'live');
  assert.equal(manager.entries[0].record.note, 'fast note');
  offline = true; await assert.rejects(manager.refresh(false), /offline/);
  const failedCalls = calls; await manager.setNote(record, 'offline edit');
  assert.equal(calls, failedCalls);
  assert.equal(manager.entries[0].status, 'unavailable');
});

test('one inventory snapshot and one Git query serve multiple sessions in the same directory', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-bulk-snapshot-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  const records = [1, 2, 3].map(i => ({ ...createRecord({ id: 'r' + i, tmuxSession: 'task-' + i, cwd: dir }), identityVersion: 1 }));
  await store.save(records); let gitCalls = 0, inventoryCalls = 0;
  const manager = new SessionManager(store, {
    list: async () => { inventoryCalls++; return records.map((record, i) => ({ name: record.tmuxSession, owner: record.id,
      snapshotWindows: [{ id: '@' + i, name: 'agent', cwd: dir, panes: [{ id: '%' + i, cwd: dir }] }] })); },
    listWindows: async () => { throw new Error('must use the already captured window data'); }
  }, { inspect: async () => { gitCalls++; return { gitBranch: 'shared' }; } });
  await manager.refresh();
  assert.equal(inventoryCalls, 1); assert.equal(gitCalls, 1);
  assert.equal(manager.records.filter(record => record.windows.length === 1 && record.gitBranch === 'shared').length, 3);
});

async function deletionFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-delete-safe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  const record = createRecord({ tmuxSession: 'task', cwd: dir,
    windows: [{ id: '@1', name: 'agent', panes: [{ id: '%1', cwd: dir, command: null }] }] });
  record.identityVersion = 1; await store.save([record]);
  const live = [{ name: 'task', id: '$1', created: '2026-01-01T00:00:00.000Z', owner: record.id }];
  let kills = 0;
  const tmux = {
    list: async () => structuredClone(live),
    listWindows: async () => [{ id: '@1', name: 'agent', cwd: dir, panes: [{ id: '%1', cwd: dir, active: true }] }],
    kill: async () => { kills++; live.splice(0); }
  };
  const manager = new SessionManager(store, tmux, { inspect: async () => ({}) });
  return { dir, store, record, live, tmux, manager, kills: () => kills };
}

test('Delete never stops tmux if the final snapshot or durable checkpoint cannot be saved', async t => {
  const f = await deletionFixture(t);
  const before = await f.store.load();
  const listWindows = f.tmux.listWindows;
  f.tmux.listWindows = async () => { throw new Error('snapshot failed'); };
  await assert.rejects(f.manager.deleteSession(f.record), /snapshot failed/);
  assert.equal(f.kills(), 0); assert.deepEqual(await f.store.load(), before);
  f.tmux.listWindows = listWindows;
  f.store.write = async () => { throw new Error('disk full'); };
  await assert.rejects(f.manager.deleteSession(f.record), /disk full/);
  assert.equal(f.kills(), 0); assert.deepEqual(await f.store.load(), before);
});

test('failed remote stop retains a durable final checkpoint and can be retried', async t => {
  const f = await deletionFixture(t); const kill = f.tmux.kill;
  f.tmux.kill = async () => {
    const saved = (await f.store.load())[0];
    assert.equal(saved.stopCheckpoint.live.id, '$1');
    assert.equal(saved.stopCheckpoint.version, 1);
    throw new Error('SSH interrupted');
  };
  await assert.rejects(f.manager.deleteSession(f.record), /SSH interrupted/);
  assert.equal(f.live.length, 1); assert.ok((await f.store.load())[0].stopCheckpoint);
  f.tmux.kill = kill;
  await f.manager.deleteSession(f.record);
  assert.equal(f.live.length, 0); assert.equal(f.manager.entries[0].status, 'recoverable');
  await f.manager.deleteSession(f.record);
  assert.equal(f.kills(), 1); assert.equal((await f.store.load()).length, 1);
});

test('Delete preserves a same-name replacement that appears after the checkpoint', async t => {
  const f = await deletionFixture(t); let calls = 0;
  f.tmux.list = async () => {
    if (++calls === 2) f.live[0] = { ...f.live[0], id: '$2', created: '2026-01-02T00:00:00.000Z' };
    return structuredClone(f.live);
  };
  await assert.rejects(f.manager.deleteSession(f.record), /identity changed/);
  assert.equal(f.kills(), 0); assert.equal(f.live[0].id, '$2');
  assert.equal((await f.store.load())[0].stopCheckpoint.live.id, '$1');
});

test('Delete verifies saved Agent history before killing and preserves legacy unbound Agents', async t => {
  const f = await deletionFixture(t);
  const agent = { type: 'codex', sessionId: '550e8400-e29b-41d4-a716-446655440000', name: 'task', recoveryVersion: 1 };
  await f.store.transaction(records => { records[0].agent = agent; records[0].windows[0].panes[0].agent = agent; });
  f.manager.agents = { verify: async () => { throw new Error('original history missing'); } };
  await assert.rejects(f.manager.deleteSession(f.record), /original history missing/);
  assert.equal(f.kills(), 0);
  await f.store.transaction(records => { records[0].agent = { type: 'codex' }; delete records[0].windows[0].panes[0].agent; });
  await assert.rejects(f.manager.deleteSession(f.record), /Bind the original/);
  assert.equal(f.kills(), 0);
});
