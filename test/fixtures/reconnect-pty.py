"""Exercise the shipped native shell supervisor in a real PTY, without a GUI."""
import errno
import json
import os
import pathlib
import pty
import select
import signal
import sys
import time

plan = json.loads(pathlib.Path(sys.argv[1]).read_text())
root = pathlib.Path(plan['directory'])
offline = root / 'offline'
finish = root / 'finish'
calls = root / 'calls'
received = root / 'received'
fake = root / "fake ssh 'quoted'"
fake.write_text('''#!/usr/bin/env python3
import json,os,pathlib,select,sys,time,tty
root=pathlib.Path(os.environ['RECONNECT_TEST_ROOT'])
with (root/'calls').open('a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
if (root/'offline').exists():sys.exit(255)
if (root/'reject').exists():sys.exit(1)
tty.setraw(0)
print('FAKE_CONNECTED',flush=True)
while True:
 if (root/'offline').exists():sys.exit(255)
 if (root/'finish').exists():sys.exit(0)
 if select.select([0],[],[],0.05)[0]:
  data=os.read(0,4096)
  if not data:sys.exit(0)
  with (root/'received').open('ab') as f:f.write(data)
''')
fake.chmod(0o700)

pid, fd = pty.fork()
if pid == 0:
    os.environ['RECONNECT_TEST_ROOT'] = str(root)
    os.execv(plan['shellPath'], [plan['shellPath'], *plan['shellArgs']])

output = bytearray()
exited = None

def pump():
    global exited
    if select.select([fd], [], [], 0.05)[0]:
        try:
            output.extend(os.read(fd, 65536))
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    if exited is None:
        result, status = os.waitpid(pid, os.WNOHANG)
        if result:
            exited = status

def wait_for(condition, label, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        pump()
        if condition():
            return
        if exited is not None:
            raise AssertionError('Supervisor exited during ' + label + ': ' + output.decode(errors='replace'))
    raise AssertionError('Timed out during ' + label + ': ' + output.decode(errors='replace'))

def history():
    return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

try:
    wait_for(lambda: output.count(b'FAKE_CONNECTED') == 1, 'initial connection')
    os.write(fd, b'LIVE_BEFORE')
    wait_for(lambda: received.exists() and received.read_bytes() == b'LIVE_BEFORE', 'live input')
    offline.touch()
    wait_for(lambda: b'Disconnected.' in output, 'disconnect notice')
    os.write(fd, b'OFFLINE_INPUT_MUST_NOT_REPLAY\n')
    os.kill(pid, signal.SIGINT)
    wait_for(lambda: len(history()) >= 2, 'retry while offline')
    assert exited is None, 'network loss must not end the native terminal process'
    assert 'BatchMode=yes' not in history()[0]
    assert 'BatchMode=yes' in history()[1]
    assert history()[0][-1] == plan['initialRemote']
    assert history()[1][-1] == plan['retryRemote']

    if plan.get('reject'):
        (root / 'reject').touch()
        offline.unlink()
        wait_for(lambda: b'Close this tab and reopen' in output, 'changed identity notice')
        attempts = len(history())
        until = time.monotonic() + 1
        while time.monotonic() < until:
            pump()
        assert exited is None
        assert len(history()) == attempts, 'an identity rejection must not trigger new sessions or endless retries'
    else:
        offline.unlink()
        wait_for(lambda: output.count(b'FAKE_CONNECTED') == 2, 'automatic recovery')
        os.write(fd, b'LIVE_AFTER')
        wait_for(lambda: received.read_bytes().endswith(b'LIVE_AFTER'), 'recovered input')
        assert received.read_bytes() == b'LIVE_BEFORELIVE_AFTER', received.read_bytes()
        assert exited is None
        finish.touch()
        wait_for(lambda: exited is not None, 'intentional remote detach')
        assert os.waitstatus_to_exitcode(exited) == 0
    print(json.dumps({'retainedPid': pid, 'attempts': len(history()), 'offlineInputDiscarded': True, 'identityRejected': bool(plan.get('reject'))}))
finally:
    if exited is None:
        os.killpg(pid, signal.SIGHUP)
        deadline = time.monotonic() + 3
        while exited is None and time.monotonic() < deadline:
            pump()
        if exited is None:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    os.close(fd)
