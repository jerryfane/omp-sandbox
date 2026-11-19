"""Runs a command for the stand-in gitmoot CLI and records how it really ended.

Usage: fake-gitmoot-run.py STATUS_FILE|- ARGV...

The command runs in its own session and process group (as gitmoot's
supervisor runs it). SIGTERM or SIGINT to this runner is forwarded to that
whole group, with SIGKILL 3 s later. The status file gets
{"exit_code", "signal", "timed_out", "error"} from the real wait status, so an
explicit `exit 143` is an exit code and death by SIGTERM is a signal. The
runner exits like gitmoot: the command's status, or 128+n for signal n.
"""
import json
import os
import signal
import sys
import time

status_file, argv = sys.argv[1], sys.argv[2:]
pid = os.fork()
if pid == 0:
    os.setsid()
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    os.execvp(argv[0], argv)


# When a signal was forwarded: the moment the group gets SIGKILL if anything in it is still alive.
escalate_at = None


def forward(signum, _frame):
    global escalate_at
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        return
    if escalate_at is None:
        escalate_at = time.monotonic() + 3.0


def group_alive():
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
while True:
    try:
        _, wait_status = os.waitpid(pid, 0)
        break
    except InterruptedError:
        continue
if os.WIFSIGNALED(wait_status):
    exit_code, sig = None, os.WTERMSIG(wait_status)
else:
    exit_code, sig = os.WEXITSTATUS(wait_status), None
# The leader is reaped, but a member that ignored the forwarded signal may remain: the
# promised SIGKILL still reaches it, before the runner reports and exits.
if escalate_at is not None:
    while group_alive() and time.monotonic() < escalate_at:
        time.sleep(0.05)
    if group_alive():
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
if status_file != "-":
    with open(status_file + ".tmp", "w") as f:
        json.dump({"exit_code": exit_code, "signal": sig, "timed_out": False, "error": None}, f)
    os.replace(status_file + ".tmp", status_file)
os._exit(128 + sig if sig is not None else exit_code)
