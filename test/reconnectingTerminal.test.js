'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SshClient } = require('../src/ssh');
const { reconnectingTerminal } = require('../src/reconnectingTerminal');
const run = promisify(execFile);

for (const reject of [false, true]) {
  test(`native PTY retains its process through SSH loss: ${reject ? 'reject replacement identity' : 'recover without replaying offline input'}`, {
    skip: process.platform === 'win32', timeout: 45000,
  }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxdock-reconnect-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const ssh = new SshClient({ id: 'fixture', label: 'Fixture', sshHost: 'fake-host' }, {
      sshPath: path.join(directory, "fake ssh 'quoted'"),
    });
    const initialRemote = `printf '%s' "initial command 'with quotes'"`;
    const retryRemote = `printf '%s' "guarded retry 'original identity'"`;
    const launch = reconnectingTerminal(ssh, { remote: initialRemote, reconnect: retryRemote });
    const file = path.join(directory, 'plan.json');
    await fs.writeFile(file, JSON.stringify({ ...launch, directory, reject, initialRemote, retryRemote }));
    const { stdout } = await run('python3', [path.join(__dirname, 'fixtures/reconnect-pty.py'), file], { timeout: 40000 });
    const result = JSON.parse(stdout);
    assert.ok(result.retainedPid > 0);
    assert.ok(result.attempts >= 3);
    assert.equal(result.identityRejected, reject);
  });
}

test('reconnecting terminals retain host multiplexing and guard unattended retries on each platform', () => {
  const ssh = new SshClient({ id: 'fixture', label: 'Fixture', sshHost: 'fake-host' });
  const unix = reconnectingTerminal(ssh, { remote: 'original', reconnect: 'guarded retry' });
  assert.match(unix.shellArgs[1], /ControlMaster=auto/);
  assert.doesNotMatch(unix.shellArgs[1], /ControlPath=none/);
  const windows = reconnectingTerminal(ssh, { remote: 'original', reconnect: 'guarded retry', platform: 'win32' });
  const script = Buffer.from(windows.shellArgs.at(-1), 'base64').toString('utf16le');
  assert.match(script, /BatchMode=yes/);
  assert.match(script, /guarded retry/);
  assert.match(script, /\$PID \+ \$attempt/);
});
