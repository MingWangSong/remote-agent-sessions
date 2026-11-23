'use strict';

const { shellQuote } = require('./ssh');

// Keep VS Code's native terminal process alive while its SSH child is replaced.
// This retains the terminal editor, its group, and VS Code's process persistence.
function reconnectingTerminal(ssh, { remote, reconnect, platform = process.platform } = {}) {
  // Share the host's existing master: opening many tabs must not start a new
  // authenticated TCP connection per tab (or flood sshd after an outage).
  const args = ssh.baseArgs({ interactive: true });
  const target = ['-tt', ssh.host.sshHost];
  const initial = [ssh.sshPath, ...args, ...target, ...(remote ? [remote] : [])];
  const retry = [ssh.sshPath, ...args, '-o', 'BatchMode=yes', ...target, reconnect ||
    'printf "\\r\\n[TmuxDock] SSH reconnected. A new login shell is starting.\\r\\n"; exec "${SHELL:-/bin/sh}" -l'];
  const stopped = 'The remote connection ended. Close this tab and reopen it from TmuxDock to connect again.';
  if (platform === 'win32') {
    // ProcessStartInfo.Arguments uses Windows CRT quoting; PowerShell 5's
    // native argument binding can strip quotes from the guarded remote command.
    const invocation = command => {
      const quote = value => "'" + value.replace(/'/g, "''") + "'";
      const arg = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
      return quote(command.slice(1).map(arg).join(' '));
    };
    const executable = "'" + initial[0].replace(/'/g, "''") + "'";
    const script = `
function Invoke-Ssh([string] $arguments) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = ${executable}
  $info.Arguments = $arguments
  $info.UseShellExecute = $false
  $child = [System.Diagnostics.Process]::Start($info)
  try { $child.WaitForExit(); return $child.ExitCode }
  finally { $child.Dispose() }
}
function Clear-TerminalInput {
  try { while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) } } catch {}
}
$code = Invoke-Ssh ${invocation(initial)}
$delay = 2
$attempt = 0
while ($code -eq 255) {
  $wait = $delay + (($PID + $attempt) % 3)
  Write-Host ("[TmuxDock] Disconnected. Retrying in {0}s. Close this tab to stop." -f $wait) -ForegroundColor Yellow
  Start-Sleep -Seconds $wait
  Clear-TerminalInput
  Write-Host "[TmuxDock] Reconnecting..."
  $started = [DateTime]::UtcNow
  $code = Invoke-Ssh ${invocation(retry)}
  $attempt += 1
  $delay = [Math]::Min(15, $delay * 2)
  if (([DateTime]::UtcNow - $started).TotalSeconds -gt 30) { $delay = 2 }
}
if ($code -ne 0) {
  Write-Host "[TmuxDock] ${stopped}" -ForegroundColor Yellow
  while ($true) { Start-Sleep -Seconds 30; Clear-TerminalInput }
}
`;
    return { shellPath: 'powershell.exe', shellArgs: ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  const invocation = command => command.map(shellQuote).join(' ');
  return { shellPath: '/bin/sh', shellArgs: ['-c', `
tty_state=$(stty -g 2>/dev/null) || tty_state=
ssh_pid=
restore_tty() { if [ -n "$tty_state" ]; then stty "$tty_state" 2>/dev/null; fi; }
stop() {
  if [ -n "$ssh_pid" ]; then kill "$ssh_pid" 2>/dev/null; fi
  restore_tty
  exit 0
}
trap stop HUP TERM
trap ':' INT
run_ssh() {
  "$@" <&3 &
  ssh_pid=$!
  wait "$ssh_pid"
  code=$?
  ssh_pid=
}
exec 3<&0
clear_input() {
  if [ -n "$tty_state" ]; then
    stty -icanon -echo min 0 time 1 2>/dev/null || return
    while [ "$(dd bs=4096 count=1 2>/dev/null | wc -c)" -gt 0 ]; do :; done
    restore_tty
  fi
}
run_ssh ${invocation(initial)}
delay=2
attempt=0
while [ "$code" -eq 255 ]; do
  restore_tty
  wait_time=$((delay + ($$ + attempt) % 3))
  printf '\\033[?1049l\\r\\n\\033[33m[TmuxDock] Disconnected. Retrying in %ss. Close this tab to stop.\\033[0m\\r\\n' "$wait_time"
  sleep "$wait_time"
  clear_input
  printf '[TmuxDock] Reconnecting…\\r\\n'
  started=$(date +%s)
  run_ssh ${invocation(retry)}
  attempt=$((attempt + 1))
  delay=$((delay * 2))
  if [ "$delay" -gt 15 ]; then delay=15; fi
  if [ "$(($(date +%s) - started))" -gt 30 ]; then delay=2; fi
done
restore_tty
if [ "$code" -ne 0 ]; then
  printf '\\r\\n[TmuxDock] %s\\r\\n' ${shellQuote(stopped)}
  while :; do sleep 30; clear_input; done
fi
`] };
}

module.exports = { reconnectingTerminal };
