import os
import signal
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
VENV_PYTHON = SCRIPT_DIR / "venv" / "bin" / "python"

# Re-exec into venv if not already running inside it
if VENV_PYTHON.exists() and Path(sys.executable).resolve() != VENV_PYTHON.resolve():
    print("[run_server] Restarting with venv Python...")
    os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), __file__] + sys.argv[1:])

sys.stdout.reconfigure(encoding="utf-8")


def kill_stale_processes():
    """Kill any existing uvicorn/run_server processes to free ports."""
    print("[run_server] Checking for stale processes...")
    current_pid = os.getpid()
    parent_pid = os.getppid()
    protected = {current_pid, parent_pid}
    killed = 0

    try:
        result = subprocess.run(
            ["pgrep", "-a", "-f", "uvicorn|run_server"],
            capture_output=True, text=True
        )
        for line in result.stdout.strip().splitlines():
            parts = line.split(None, 1)
            if not parts:
                continue
            try:
                pid = int(parts[0])
                if pid not in protected:
                    os.kill(pid, signal.SIGTERM)
                    killed += 1
                    print(f"[run_server] Killed stale process (PID {pid})")
            except (ValueError, OSError):
                pass
    except FileNotFoundError:
        pass  # pgrep not available

    if killed == 0:
        print("[run_server] No stale processes found")


kill_stale_processes()

import time
time.sleep(1)

env = os.environ.copy()
env["PYTHONIOENCODING"] = "utf-8"

log_path = SCRIPT_DIR / "server.log"
with open(log_path, "w", encoding="utf-8") as log_file:
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "uvicorn", "api.main:app", "--reload", "--host", "0.0.0.0", "--port", "8000"],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        bufsize=0,
        env=env,
    )
    print(f"[run_server] Server started with PID {proc.pid}. Logs in {log_path}")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
