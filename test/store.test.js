'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SessionStore } = require('../src/store');
const { createRecord } = require('../src/model');
const run = promisify(execFile);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-store-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  return new SessionStore(path.join(dir,'sessions.json'));
}
const record = (id) => createRecord({ id, title: id, tmuxSession: id, cwd: os.tmpdir() });

test('store: private atomic database, backup and legacy schema round-trip', async (t) => {
  const s = await fixture(t); const r = record('one');
  await s.save([r]); await s.transaction((rs) => { rs[0].note = 'changed'; });
  assert.equal((await s.load())[0].note, 'changed');
  assert.equal(JSON.parse(await fs.readFile(s.filePath+'.bak','utf8')).sessions[0].note, '');
  for (const name of [s.filePath,s.filePath+'.bak']) assert.equal((await fs.stat(name)).mode & 0o077, 0);
});
test('store: 6 separate writer processes preserve all 60 updates', async (t) => {
  const s = await fixture(t);
  const code = "const {SessionStore}=require(process.argv[1]);const {createRecord}=require(process.argv[2]);(async()=>{const s=new SessionStore(process.argv[3]);for(let i=0;i<10;i++)await s.transaction(rs=>rs.push(createRecord({id:process.argv[4]+'-'+i,tmuxSession:process.argv[4]+'-'+i,cwd:process.argv[5]})));})().catch(e=>{console.error(e);process.exit(1)});";
  await Promise.all(Array.from({length:6},(_,i)=>run(process.execPath,['-e',code,require.resolve('../src/store'),require.resolve('../src/model'),s.filePath,'writer'+i,os.tmpdir()])));
  assert.equal((await s.load()).length,60);
});
test('store: corrupt database is never silently overwritten', async (t) => {
  const s = await fixture(t);
  await fs.writeFile(s.filePath,'{broken');
  await assert.rejects(s.save([record('one')]), /Unable to read/);
  assert.equal(await fs.readFile(s.filePath,'utf8'),'{broken');
});
test('store: invalid record and multiline command rejected without altering prior data', async (t) => {
  const s = await fixture(t); await s.save([record('one')]);
  await assert.rejects(s.transaction(rs=>{rs[0].windows=[{name:'x',command:'echo a\necho b'}];}),/single-line/);
  assert.equal((await s.load())[0].windows.length,0);
  await assert.rejects(s.save([{id:'bad'}]),/Invalid session/);
});
test('store: failed mutation releases lock and rolls back record changes', async (t) => {
  const s = await fixture(t); await s.save([record('one')]);
  await assert.rejects(s.transaction(rs=>{rs[0].note='bad';throw new Error('injected');}),/injected/);
  await s.transaction(rs=>{rs[0].title='good';});
  assert.equal((await s.load())[0].note,'');
  assert.equal((await s.load())[0].title,'good');
});
test('store: interrupted writer stale lock is recovered', async (t) => {
  const s = await fixture(t); await s.save([record('one')]);
  await fs.mkdir(s.filePath+'.lock');
  const old = new Date(Date.now()-60000); await fs.utimes(s.filePath+'.lock',old,old);
  await s.transaction(rs=>{rs[0].note='recovered';});
  assert.equal((await s.load())[0].note,'recovered');
});

test('store: failed disk commit preserves last good data and later writes can succeed', async (t) => {
  const s = await fixture(t); await s.save([record('one')]);
  const write = s.write.bind(s);
  s.write = async () => { throw new Error('ENOSPC injected'); };
  await assert.rejects(s.transaction(rs=>{rs[0].note='not committed';}), /ENOSPC/);
  assert.equal((await s.load())[0].note, '');
  s.write = write;
  await s.transaction(rs=>{rs[0].note='committed';});
  assert.equal((await s.load())[0].note,'committed');
});
