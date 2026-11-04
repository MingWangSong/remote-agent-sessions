'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { AgentSessions } = require('../src/agentSessions');
const { SessionManager } = require('../src/sessionManager');
const { SessionStore } = require('../src/store');
const { TmuxClient } = require('../src/tmux');
const { createRecord } = require('../src/model');
const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const fakeCli = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const type=path.basename(process.argv[1]),args=process.argv.slice(2),root=process.env.TMUXDOCK_FIXTURE;
const file=path.join(root,'threads.json');
const load=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
const save=d=>fs.writeFileSync(file,JSON.stringify(d));
if(args.includes('--help')){console.log('--session-id --name');process.exit(0);}
if(type==='codex'&&args[0]==='app-server'){
 readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={},d=load();
 if(m.method==='thread/start'){const id=crypto.randomUUID();d[id]={id,cwd:m.params.cwd};save(d);result={thread:{id}};}
 if(m.method==='thread/name/set'){if(!d[m.params.threadId])throw Error('missing thread');d[m.params.threadId].name=m.params.name;save(d);}
 if(m.method==='thread/read'){if(!d[m.params.threadId]){console.log(JSON.stringify({id:m.id,error:{message:'Original conversation missing'}}));return;}result={thread:d[m.params.threadId]};}
 if(m.method==='thread/list'){result={data:Object.values(d).filter(t=>!!t.archived===!!m.params.archived&&(!m.params.cwd||t.cwd===m.params.cwd)),nextCursor:null};}
 if(m.method==='thread/unarchive'){if(!d[m.params.threadId])throw Error('missing original');d[m.params.threadId].archived=false;save(d);result={thread:d[m.params.threadId]};}
 console.log(JSON.stringify({id:m.id,result}));});
}else{
 let id,name,mode;
 if(type==='claude'){const fresh=args.includes('--session-id');id=args[args.indexOf(fresh?'--session-id':'--resume')+1];if(id.endsWith('.jsonl'))id=path.basename(id,'.jsonl');name=args[args.indexOf('--name')+1];mode=fresh?'new':'resume';
 const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(dir,{recursive:true});const transcript=path.join(dir,id+'.jsonl');
 if(!fresh&&!fs.existsSync(transcript))throw Error('missing original history');fs.writeFileSync(transcript,JSON.stringify({sessionId:id,name}));
 }else{id=args[1];const d=load();if(!d[id]||d[id].archived)throw Error('missing original thread');name=d[id].name;mode='resume';if(!args.includes('--cd'))process.chdir(d[id].cwd);}
 fs.appendFileSync(path.join(root,'launches.jsonl'),JSON.stringify({type,id,name,mode,cwd:args.includes('--cd')?args[args.indexOf('--cd')+1]:process.cwd()})+'\\n');console.log('FIXTURE_AGENT_READY');setInterval(()=>{const p=path.join(root,'next-cwd');if(fs.existsSync(p)){process.chdir(fs.readFileSync(p,'utf8'));fs.writeFileSync(path.join(root,'cwd-ready'),process.cwd());}},50);
}
`;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxdock-agent-'));
  await fs.mkdir(path.join(dir, 'bin'));
  for (const name of ['claude', 'codex']) await fs.writeFile(path.join(dir, 'bin', name), fakeCli, { mode: 0o700 });
  const env = { ...process.env, PATH: path.join(dir, 'bin') + ':' + process.env.PATH,
    TMUXDOCK_FIXTURE: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), SHELL: '/bin/sh' };
  const transport = {
    run: (file, args) => run(file, args, { env, encoding: 'utf8' }),
    openProcess: (file, args) => spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  };
  const tmux = new TmuxClient('tmux', (file, args, options) => run(file, args, { ...options, env }),
    ['-L', 'tmuxdock-agent-' + randomUUID(), '-f', '/dev/null']);
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  const agents = new AgentSessions(transport);
  const manager = () => new SessionManager(store, tmux, { inspect: async () => ({}) }, async () => {}, agents);
  const launches = async () => (await fs.readFile(path.join(dir, 'launches.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const waitLaunches = async count => {
    for (let i = 0; i < 100; i++) { if ((await launches()).length >= count) return launches(); await pause(50); }
    throw new Error('Agent fixture did not launch');
  };
  t.after(async () => { await tmux.run(['kill-server'], { allowNoServer: true }).catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, tmux, store, agents, manager, launches, waitLaunches };
}

for (const type of ['claude', 'codex']) test(`real tmux + fixture ${type}: same name and conversation ID survive stop, reload and repeated restore`, async t => {
  const f = await fixture(t); const first = f.manager();
  const record = await first.create({ title: "任务 ' same name", cwd: f.dir, agent: { type }, command: type });
  let launches = await f.waitLaunches(1);
  assert.equal(launches[0].name, record.tmuxSession);
  assert.equal(launches[0].id, record.agent.sessionId);
  await first.terminate(record);
  const persisted = (await f.store.load())[0];
  assert.equal(persisted.windows[0].panes[0].agent.sessionId, record.agent.sessionId);
  const reloaded = f.manager(); await reloaded.initialize();
  assert.equal(reloaded.entries[0].status, 'recoverable');
  await reloaded.restore(persisted, true);
  launches = await f.waitLaunches(2);
  assert.equal(launches[1].mode, 'resume');
  assert.equal(launches[1].id, launches[0].id);
  assert.equal(launches[1].name, launches[0].name);
  await reloaded.restore(persisted, true); await pause(100);
  assert.equal((await f.launches()).length, 2);
  await reloaded.terminate(persisted);
  if (type === 'claude') {
    const transcript = path.join(f.dir, 'claude', 'projects', 'fixture', record.agent.sessionId + '.jsonl');
    await fs.rm(transcript);
  } else await fs.writeFile(path.join(f.dir, 'threads.json'), '{}');
  await assert.rejects(reloaded.restore(persisted, true), /history|conversation|missing/i);
  assert.equal(await f.tmux.exists(record.tmuxSession), false);
  assert.equal((await f.launches()).length, 2);
});

test('legacy records require binding; shell-only rebuild never launches a new Agent', async t => {
  const f = await fixture(t);
  const record = createRecord({ title: 'Old task', tmuxSession: 'Old task', cwd: f.dir, agent: { type: 'claude' },
    windows: [{ name: 'agent', cwd: f.dir, panes: [{ cwd: f.dir, command: 'claude' }] }] });
  await f.store.save([record]); const manager = f.manager();
  await assert.rejects(manager.restore(record, true), /Bind the original/);
  assert.equal(await f.tmux.exists(record.tmuxSession), false);
  await manager.restore(record, false);
  assert.equal((await f.launches()).length, 0);
});

test('a legacy record can bind an existing original conversation and resume it without creating another ID', async t => {
  const f = await fixture(t); const manager = f.manager();
  const original = await manager.create({ title: 'Original', cwd: f.dir, agent: { type: 'claude' }, command: 'claude' });
  await f.waitLaunches(1); await manager.terminate(original);
  await f.store.transaction(records => {
    records[0].agent = { type: 'claude' };
    delete records[0].windows[0].panes[0].agent;
    records[0].windows[0].panes[0].command = 'claude';
  });
  await manager.bindAgentSession(original, 'claude', original.agent.sessionId);
  await manager.restore(original, true);
  const launches = await f.waitLaunches(2);
  assert.equal(launches[1].id, launches[0].id);
  assert.equal(launches[1].mode, 'resume');
});

for (const archived of [false, true]) test(`legacy Codex history discovery and exact-ID recovery (archived=${archived})`, async t => {
  const f = await fixture(t); const manager = f.manager();
  const original = await manager.create({ title: 'Original Codex work', cwd: f.dir, agent: { type: 'codex' }, command: 'codex' });
  await f.waitLaunches(1); await manager.terminate(original);
  const history = JSON.parse(await fs.readFile(path.join(f.dir, 'threads.json'), 'utf8'));
  history[original.agent.sessionId].archived = archived;
  await fs.writeFile(path.join(f.dir, 'threads.json'), JSON.stringify(history));
  await f.store.transaction(records => {
    records[0].agent = { type: 'codex' }; delete records[0].windows[0].panes[0].agent;
    records[0].windows[0].panes[0].command = 'codex'; records[0].windows[0].command = 'codex';
  });
  const page = await f.agents.listCodexConversations({ cwd: f.dir, archived });
  assert.equal(page.conversations.length, 1);
  assert.equal(page.conversations[0].id, original.agent.sessionId);
  assert.equal((await f.launches()).length, 1, 'discovery must not launch an agent');
  await manager.bindAgentSession(original, 'codex', page.conversations[0].id, { archived });
  const saved = (await f.store.load())[0];
  assert.equal(saved.agent.sessionId, original.agent.sessionId);
  await manager.restore(saved, true);
  const launches = await f.waitLaunches(2);
  assert.equal(launches[1].id, launches[0].id);
  assert.equal(launches[1].mode, 'resume');
  const after = JSON.parse(await fs.readFile(path.join(f.dir, 'threads.json'), 'utf8'));
  assert.equal(Object.keys(after).length, 1, 'no replacement conversation created');
  assert.equal(after[original.agent.sessionId].archived, false);
});

for (const type of ['claude', 'codex']) test(`Delete → reload → Restore: ${type} keeps tmux name, last directory and exact original conversation`, async t => {
  const f = await fixture(t); const manager = f.manager();
  const initialDirectory = path.join(f.dir, "initial-project"); await fs.mkdir(initialDirectory);
  const record = await manager.create({ title: "恢复 ' 中文", cwd: initialDirectory, agent: { type }, command: type });
  const initial = (await f.waitLaunches(1))[0];
  const keeper = await f.tmux.create('keeper', f.dir); // Keep the socket alive to distinguish new tmux IDs.
  const firstLive = (await f.tmux.list()).find(s => s.name === record.tmuxSession);
  const lastPath = path.join(f.dir, "last directory ' 中文"); await fs.mkdir(lastPath);
  const last = await fs.realpath(lastPath);
  await fs.writeFile(path.join(f.dir, 'next-cwd'), last);
  for (let i = 0; i < 100; i++) {
    if ((await fs.readFile(path.join(f.dir, 'cwd-ready'), 'utf8').catch(() => '')) === last) break;
    await pause(50);
  }
  assert.equal(await fs.readFile(path.join(f.dir, 'cwd-ready'), 'utf8'), last);
  const beforeDelete = (await f.tmux.list()).find(s => s.name === record.tmuxSession);
  assert.equal(beforeDelete.snapshotWindows[0].panes[0].cwd, await fs.realpath(last));
  // No background refresh: Delete itself must capture the final directory.
  await manager.deleteSession(record);
  assert.equal(await f.tmux.exists(record.tmuxSession), false);
  let saved = (await f.store.load())[0];
  assert.equal(saved.cwd, await fs.realpath(last));
  assert.equal(saved.agent.sessionId, initial.id);
  assert.equal(saved.stopCheckpoint.version, 1);
  await fs.rm(path.join(f.dir, 'next-cwd'));
  await fs.rm(initialDirectory, { recursive: true }); // The original directory is no longer needed.
  const reloaded = f.manager(); await reloaded.initialize();
  assert.equal(reloaded.entries.find(e => e.record?.id === record.id).status, 'recoverable');
  await reloaded.restore(saved, true);
  const restored = (await f.waitLaunches(2))[1];
  const newLive = (await f.tmux.list()).find(s => s.name === record.tmuxSession);
  assert.equal(newLive.name, firstLive.name); assert.notEqual(newLive.id, firstLive.id);
  assert.equal(restored.id, initial.id); assert.equal(restored.name, initial.name);
  assert.equal(restored.mode, 'resume'); assert.equal(restored.cwd, await fs.realpath(last));
  saved = (await f.store.load())[0]; assert.equal(saved.stopCheckpoint, undefined);
  await reloaded.deleteSession(saved); await reloaded.restore(saved, true);
  assert.equal((await f.waitLaunches(3))[2].id, initial.id);
  if (type === 'codex') assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(f.dir, 'threads.json')))).length, 1);
  assert.ok(keeper);
});
