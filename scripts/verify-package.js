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
  const icon = await fs.readFile(path.join(root, manifest.icon));
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Product icon must be a PNG');
  assert.equal(icon.toString('ascii', 12, 16), 'IHDR', 'PNG icon must contain its dimensions');
  const width = icon.readUInt32BE(16), height = icon.readUInt32BE(20);
  assert.ok(width > 0 && height > 0 && width <= 1024 && height <= 1024,
    `Marketplace icon limit is 1024x1024; received ${width}x${height}`);
  for (const type of ['codex', 'claude']) {
    const definition = manifest.contributes.icons[`tmuxdock-${type}`]?.default;
    assert.ok(definition?.fontPath, `Missing registered ${type} icon`);
    const font = await fs.readFile(path.join(root, definition.fontPath));
    assert.equal(font.toString('ascii', 0, 4), 'wOFF', `Invalid ${type} icon font`);
    assert.equal(font.readUInt32BE(8), font.length, 'Icon font has an invalid length');
  }
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
  const readme = (await run('unzip', ['-p', vsix, 'extension/readme.md'])).stdout;
  assert.ok(readme.includes('Your remote work, docked.'), 'Dedicated Marketplace README is missing');
  assert.ok(!readme.includes('Develop with confidence'), 'GitHub copy leaked into Marketplace README');
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
  assert.equal(images.length, 4, 'Marketplace needs its hero and three real screenshots');
  assert.ok(images.every(url => url.startsWith('https://') && url.endsWith('.png')), 'Marketplace images must be HTTPS PNGs');
  for(const dependency of ['proper-lockfile','graceful-fs','retry','signal-exit']) {
    assert.ok(files.includes('extension/node_modules/'+dependency+'/package.json'),'Missing runtime dependency '+dependency);
  }
  const bytes=await fs.readFile(vsix);
  const checksum=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(vsix+'.sha256',checksum+'  '+path.basename(vsix)+'\n');
  console.log('VSIX integrity, runtime source equality and bundled dependencies: PASS');
  console.log('SHA256: '+checksum);
})().catch(error=>{console.error(error);process.exitCode=1;});
