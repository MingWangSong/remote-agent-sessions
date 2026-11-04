'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
(async () => {
  const root = path.resolve(__dirname,'..');
  const manifest = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const vsix = path.resolve(root,`dist/tmuxdock-${manifest.version}.vsix`);
  await run('unzip',['-tq',vsix]);
  const files = (await run('unzip',['-Z1',vsix])).stdout.split('\n');
  async function tree(directory) {
    const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? tree(directory + '/' + entry.name) : directory + '/' + entry.name))).flat();
  }
  for (const file of ['package.json', ...(await tree('media')), ...(await tree('src'))]) {
    const packed = (await run('unzip',['-p',vsix,'extension/'+file],{encoding:'buffer'})).stdout;
    assert.deepEqual(packed,await fs.readFile(path.join(root,file)),file+' differs from verified source');
  }
  for(const dependency of ['proper-lockfile','graceful-fs','retry','signal-exit']) {
    assert.ok(files.includes('extension/node_modules/'+dependency+'/package.json'),'Missing runtime dependency '+dependency);
  }
  const bytes=await fs.readFile(vsix);
  const checksum=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(vsix+'.sha256',checksum+'  '+path.basename(vsix)+'\n');
  console.log('VSIX integrity, runtime source equality and bundled dependencies: PASS');
  console.log('SHA256: '+checksum);
})().catch(error=>{console.error(error);process.exitCode=1;});
