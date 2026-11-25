"""Read the foreground Agent ID for a tmux pane on Linux. Output IDs only."""
import json
import os
import re
import sys
from pathlib import Path


PROC = Path("/proc")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def process(pid):
    path = PROC / str(pid)
    if path.stat().st_uid != os.getuid():
        raise ValueError("different process owner")
    return (path / "stat").read_text().rsplit(")", 1)[1].split()


def in_pane(pid, state, pane_pid, group):
    if int(state[2]) != group:
        return False
    while pid > 1 and pid != pane_pid:
        pid = int(state[1])
        if pid == pane_pid:
            return True
        state = process(pid)
    return pid == pane_pid


def claude_ids(pane_pid, group):
    root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    for path in (root / "sessions").glob("*.json"):
        try:
            pid = int(path.stem)
            state = process(pid)
            data = json.loads(path.read_text())
            session_id = data.get("sessionId", "")
            if (data.get("pid") == pid and data.get("kind") == "interactive"
                    and str(data.get("procStart")) == state[19]
                    and re.fullmatch(UUID, session_id, re.IGNORECASE)
                    and in_pane(pid, state, pane_pid, group)):
                yield session_id
        except (OSError, ValueError, TypeError, IndexError, AttributeError):
            continue


def codex_ids(pane_pid, group):
    for path in PROC.iterdir():
        try:
            if not path.name.isdecimal() or (path / "comm").read_text().strip() != "codex":
                continue
            pid = int(path.name)
            if not in_pane(pid, process(pid), pane_pid, group):
                continue
            for fd in (path / "fd").iterdir():
                try:
                    rollout = Path(os.readlink(fd))
                    match = re.fullmatch(r"rollout-.*-(" + UUID + r")(?:_" + UUID + r")?\.jsonl", rollout.name)
                    if not match or not rollout.is_file():
                        continue
                    flags = re.search(r"^flags:\s+([0-7]+)", (path / "fdinfo" / fd.name).read_text(), re.M)
                    if not flags or not int(flags[1], 8) & os.O_ACCMODE:
                        continue
                    with rollout.open("rb") as file:
                        meta = json.loads(file.readline(256 * 1024))
                    payload = meta.get("payload", {})
                    session_id = payload.get("id", "")
                    if (meta.get("type") == "session_meta" and payload.get("source") == "cli"
                            and session_id == match[1]):
                        yield session_id
                except (OSError, ValueError, TypeError, AttributeError):
                    continue
        except (OSError, ValueError, IndexError):
            continue


def main(agent_type, pane_pid):
    try:
        group = int(process(pane_pid)[5])
    except (OSError, ValueError, IndexError):
        return []
    if group <= 0:
        return []
    discover = claude_ids if agent_type == "claude" else codex_ids
    return sorted(set(discover(pane_pid, group)))


print(json.dumps(main(sys.argv[1], int(sys.argv[2]))))
