'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const manifest = require(path.join(root, 'package.json'));
  const output = path.join(root, 'dist', `tmuxdock-${manifest.version}.vsix`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const child = spawn(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--readme-path', 'MARKETPLACE.md', '--out', output], {
    cwd: root,
    stdio: 'inherit'
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = code || 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
