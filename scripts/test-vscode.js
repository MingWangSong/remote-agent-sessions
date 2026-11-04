'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const net = require('node:net');
const run = promisify(execFile);

(async () => {
  const root = path.resolve(__dirname, '..');
  const manifest = require(path.join(root, 'package.json'));
  const extensionId = process.env.RAS_TEST_EXTENSION_ID || `${manifest.publisher}.${manifest.name}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ras-vscode-'));
  const socket = 'ras-vscode-' + randomUUID();
  const tmux = process.env.RAS_TMUX || (await run('which', ['tmux'])).stdout.trim();
  let executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === 'darwin'
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
    'terminal.integrated.enablePersistentSessions': true,
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
    const testsEnv = { RAS_TEST_DIRECTORY: temp, RAS_TEST_SOCKET: socket,
      RAS_TEST_EXTENSION_ID: extensionId,
      RAS_TEST_REPORT: path.resolve(root,'test-results',process.env.RAS_TEST_FULL_RESTART ? 'restart-icon-results.json' : process.env.RAS_TEST_ICONS ? 'icon-results.json' : process.env.RAS_TEST_RELOAD ? 'reload-results.json' : process.env.RAS_TEST_VSIX ? 'vsix-results.json' : 'vscode-results.json') };
    const launchArgs = [path.join(temp,'project'),'--user-data-dir',userData,'--extensions-dir',path.join(temp,'extensions'),
      '--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes'];
    if (process.env.RAS_TEST_RELOAD || process.env.RAS_TEST_ICONS) {
      executable ||= await downloadAndUnzipVSCode({ version: 'stable' });
      // --extensionTestsPath ends the whole test application on reload. A normal
      // development driver activates again in the new extension host instead.
      const driver = path.join(temp, 'reload-driver');
      const done = path.join(temp, 'reload-done.json');
      if (process.env.RAS_TEST_ICONS) {
        const port = await new Promise(resolve => {
          const server = net.createServer();
          server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
        });
        testsEnv.RAS_TEST_DEBUG_PORT = String(port);
        launchArgs.push('--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1');
      }
      await fs.mkdir(driver);
      await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'tmuxdock-reload-driver', publisher: 'local',
        version: '1.0.0', engines: { vscode: '^1.90.0' }, main: './driver.js', activationEvents: ['onStartupFinished'] }));
      await fs.writeFile(path.join(driver, 'driver.js'), `const vscode = require('vscode');
exports.activate = async () => {
  let result;
  try { const restart = await require(${JSON.stringify(path.join(root, 'integration', 'vscode', process.env.RAS_TEST_ICONS ? 'icons.js' : 'reload.js'))}).run(); result = { passed: true, restart }; }
  catch (error) { result = { passed: false, error: error.stack || String(error) }; }
  await require('node:fs/promises').writeFile(${JSON.stringify(done)}, JSON.stringify(result));
  await vscode.commands.executeCommand('workbench.action.quit');
};`);
      for (let launches = 0; ; launches++) {
        await fs.rm(done, { force: true });
        await run(executable, [...launchArgs, '--extensionDevelopmentPath=' + developmentPath, '--extensionDevelopmentPath=' + driver], {
          env: { ...process.env, ...testsEnv }, timeout: 120000, maxBuffer: 4 * 1024 * 1024
        });
        const result = JSON.parse(await fs.readFile(done, 'utf8'));
        if (!result.passed) throw new Error(result.error);
        if (!result.restart) break;
        if (launches >= 2) throw new Error('Too many full restart test phases');
      }
      console.log(await fs.readFile(testsEnv.RAS_TEST_REPORT, 'utf8'));
    } else await runTests({
      vscodeExecutablePath: executable, extensionDevelopmentPath: developmentPath,
      extensionTestsPath: path.join(root,'integration','vscode','index.js'),
      extensionTestsEnv: testsEnv,
      launchArgs,
      timeout: 120000
    });
  } finally {
    await run(tmux,['-L',socket,'kill-server']).catch(()=>{});
    if (process.env.RAS_TEST_RELOAD) await run(tmux,['-L',socket + '-second','kill-server']).catch(()=>{});
    if (process.env.RAS_TEST_KEEP_DIRECTORY) console.log('Preserved isolated test directory: ' + temp);
    else await fs.rm(temp,{recursive:true,force:true});
  }
})().catch((error)=>{ console.error(error); process.exitCode=1; });
