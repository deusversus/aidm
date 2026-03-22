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


def ensure_postgres():
    """Ensure postgres is available, starting via Docker if needed."""
    import socket
    import time

    def port_open(host="127.0.0.1", port=5432):
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            return False

    # If postgres is already accepting connections, nothing to do
    if port_open():
        print("[run_server] Postgres already running on :5432.")
        return

    # Check if Docker daemon is running
    result = subprocess.run(["docker", "info"], capture_output=True)
    if result.returncode != 0:
        print("[run_server] Docker is not running. Attempting to start Docker...")
        subprocess.run(["sudo", "systemctl", "start", "docker"], check=True)
        time.sleep(3)

    print("[run_server] Starting postgres (docker compose db)...")
    subprocess.run(["docker", "compose", "up", "-d", "db"], cwd=SCRIPT_DIR, check=True)

    # Wait for healthy
    print("[run_server] Waiting for postgres to be ready...", end="", flush=True)
    for _ in range(30):
        if port_open():
            print(" ready.")
            return
        print(".", end="", flush=True)
        time.sleep(1)
    print()
    print("[run_server] WARNING: postgres did not become ready in time, proceeding anyway.")


ensure_postgres()
kill_stale_processes()

import time
time.sleep(1)

env = os.environ.copy()
env["PYTHONIOENCODING"] = "utf-8"

log_path = SCRIPT_DIR / "server.log"
with open(log_path, "w", encoding="utf-8") as log_file:
    # Bind to AIDM_BIND_HOST (default 127.0.0.1 — localhost only).
    # Set AIDM_BIND_HOST=0.0.0.0 in .env to expose to the network.
    bind_host = os.getenv("AIDM_BIND_HOST", "127.0.0.1")
    print(f"[run_server] Binding to {bind_host}:8000")

    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "uvicorn", "api.main:app", "--reload", "--host", bind_host, "--port", "8000"],
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
