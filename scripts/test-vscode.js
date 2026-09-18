'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runTests } = require('@vscode/test-electron');
const run = promisify(execFile);

(async () => {
  const root = path.resolve(__dirname, '..');
  const manifest = require(path.join(root, 'package.json'));
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-vscode-'));
  const socket = 'ras-vscode-' + randomUUID();
  const tmux = process.env.RAS_TMUX || (await run('which', ['tmux'])).stdout.trim();
  const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === 'darwin'
    ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : undefined);
  const userData = path.join(temp, 'user-data');
  const fakeSsh = path.join(temp, 'fake-ssh');
  let developmentPath = root;
  await fs.mkdir(path.join(userData, 'User'), {recursive:true});
  await fs.mkdir(path.join(temp,'project'));
  await fs.writeFile(fakeSsh, `#!/bin/sh
set -eu
while [ "\${1:-}" = "-o" ]; do shift 2; done
if [ "\${1:-}" = "-tt" ]; then shift; fi
test "$#" -ge 1
shift
if [ "$#" -eq 0 ]; then exec sh; fi
exec sh -c "$1"
`);
  await fs.chmod(fakeSsh, 0o700);
  await fs.writeFile(path.join(userData,'User','settings.json'), JSON.stringify({
    'remoteAgentSessions.sshPath': fakeSsh, 'remoteAgentSessions.refreshInterval': 10,
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'update.mode': 'none', 'telemetry.telemetryLevel': 'off'
  }));
  try {
    if (process.env.RAS_TEST_VSIX) {
      const cli = process.env.VSCODE_CLI_PATH || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
      const installed = await run(cli, ['--user-data-dir', userData, '--extensions-dir', path.join(temp,'extensions'),
        '--install-extension', path.resolve(process.env.RAS_TEST_VSIX), '--force'], { timeout: 60000 });
      console.log(installed.stdout);
      const folders = await fs.readdir(path.join(temp,'extensions'));
      const installedFolder = folders.find((name) => name.startsWith(`${extensionId}-`));
      if (!installedFolder) throw new Error(`Installed extension folder for ${extensionId} was not found`);
      developmentPath = path.join(temp,'extensions',installedFolder);
    }
    await runTests({
      vscodeExecutablePath: executable, extensionDevelopmentPath: developmentPath,
      extensionTestsPath: path.join(root,'integration','vscode','index.js'),
      extensionTestsEnv: { RAS_TEST_DIRECTORY: temp, RAS_TEST_SOCKET: socket,
        RAS_TEST_REPORT: path.resolve(root,'test-results',process.env.RAS_TEST_VSIX ? 'vsix-results.json' : 'vscode-results.json') },
      launchArgs: [path.join(temp,'project'),'--user-data-dir',userData,'--extensions-dir',path.join(temp,'extensions'),
        '--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes'],
      timeout: 120000
    });
  } finally {
    await run(tmux,['-L',socket,'kill-server']).catch(()=>{});
    await fs.rm(temp,{recursive:true,force:true});
  }
})().catch((error)=>{ console.error(error); process.exitCode=1; });
