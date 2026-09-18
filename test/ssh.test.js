'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SshClient, remoteCommand, shellQuote, validateHost } = require('../src/ssh');

const host = { id: 'host-1', label: 'Test Host', sshHost: 'test-alias', tmuxPath: 'tmux', socketName: '' };

test('SSH command quoting preserves spaces and single quotes without a local shell', () => {
  assert.equal(shellQuote("/tmp/a b'c"), "'/tmp/a b'\"'\"'c'");
  assert.equal(remoteCommand('tmux', ['display-message', "a b'c"]), "'env' 'LC_MESSAGES=C' 'tmux' 'display-message' 'a b'\"'\"'c'");
  assert.throws(() => shellQuote('bad\nline'), /line breaks/);
});

test('SSH client passes the host and one quoted remote command as argv', async () => {
  let captured;
  const runner = async (executable, args, options) => {
    captured = { executable, args, options };
    return { stdout: '/home/test\n', stderr: '' };
  };
  const ssh = new SshClient(host, { sshPath: '/usr/bin/ssh', runner, connectTimeout: 7 });
  assert.equal(await ssh.homeDirectory(), '/home/test');
  assert.equal(captured.executable, '/usr/bin/ssh');
  assert.equal(captured.args.at(-2), 'test-alias');
  assert.equal(captured.args.at(-1), "'env' 'LC_MESSAGES=C' 'pwd'");
  assert.ok(captured.args.includes('BatchMode=yes'));
  assert.ok(captured.args.includes('ConnectTimeout=7'));
});

test('SSH client lists immediate remote child directories without shell interpolation', async () => {
  const calls=[];
  const runner=async (executable,args)=>{
    calls.push({executable,args});
    return {stdout:args.at(-1).includes("'find'") ? '/work/a\0/work/项目\0' : '',stderr:''};
  };
  const ssh=new SshClient(host,{sshPath:'/usr/bin/ssh',runner,multiplex:false});
  assert.deepEqual(await ssh.listDirectories('/work'),['/work/a','/work/项目']);
  assert.match(calls.at(-1).args.at(-1),/^'env' 'LC_MESSAGES=C' 'find' '\/work' '-mindepth' '1' '-maxdepth' '1' '-type' 'd' '-print0'$/);
});

test('interactive terminal SSH args do not disable password prompts', () => {
  const ssh = new SshClient(host);
  const args = ssh.terminalArgs('tmux', ['attach-session', '-t', '=one']);
  assert.ok(args.includes('-tt'));
  assert.ok(!args.includes('BatchMode=yes'));
  assert.equal(args.at(-2), 'test-alias');
  assert.match(args.at(-1), /'tmux' 'attach-session' '-t' '=one'/);
});

test('host and path validation rejects option injection and multiline data', async () => {
  assert.throws(() => validateHost({ ...host, sshHost: '-oProxyCommand=bad' }), /cannot start/);
  assert.throws(() => validateHost({ ...host, socketName: 'bad name' }), /socket name/);
  assert.throws(() => remoteCommand('-S', ['bad']), /Invalid remote executable/);
  const ssh = new SshClient(host, { runner: async () => ({ stdout: '' }) });
  await assert.rejects(() => ssh.checkDirectory('relative'), /absolute path/);
  await assert.rejects(() => ssh.readText('/tmp/a\nfile'), /absolute/);
});
