
import os
import signal
import subprocess
import sys
from pathlib import Path

# Auto-detect and use venv Python
SCRIPT_DIR = Path(__file__).parent
VENV_PYTHON = SCRIPT_DIR / "venv313" / "Scripts" / "python.exe"

# Check if we're already running in the venv
ALREADY_IN_VENV = Path(sys.executable).resolve() == VENV_PYTHON.resolve()

if VENV_PYTHON.exists() and not ALREADY_IN_VENV:
    print("[run_server] Restarting with venv Python...")
    os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), __file__] + sys.argv[1:])

# Unbuffered output
sys.stdout.reconfigure(encoding='utf-8')

def kill_all_python_processes(skip_pids=None):
    """Kill ALL existing Python processes to ensure clean code loading.
    
    This is aggressive but necessary because uvicorn --reload doesn't always
    detect file changes, leaving stale bytecode in memory.
    
    Args:
        skip_pids: Set of PIDs to skip (won't be killed)
    """
    print("[run_server] Killing all existing Python processes...")
    current_pid = os.getpid()
    parent_pid = os.getppid()  # Get parent PID to avoid killing our parent

    # Build set of PIDs to skip
    protected_pids = {current_pid, parent_pid}
    if skip_pids:
        protected_pids.update(skip_pids)

    killed = 0

    try:
        # Use PowerShell to check command lines and selectively kill our apps
        import csv
        import io
        ps_cmd = (
            "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
            "Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation"
        )
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps_cmd],
            capture_output=True, text=True
        )
        
        reader = csv.reader(io.StringIO(result.stdout.strip()))
        for row in reader:
            if len(row) >= 2 and row[0].strip() != "ProcessId":
                try:
                    pid = int(row[0])
                    cmdline = row[1].lower() if row[1] else ""
                    
                    # Target ONLY uvicorn or script instances that might lock ports/files
                    if pid not in protected_pids and ("uvicorn" in cmdline or "run_server" in cmdline):
                        print(f"[run_server] Killing application process (PID {pid})")
                        os.kill(pid, signal.SIGTERM)
                        killed += 1
                except (ValueError, OSError, IndexError):
                    pass
    except Exception as e:
        print(f"[run_server] Warning: Could not selectively kill processes: {e}")

    if killed > 0:
        print(f"[run_server] Killed {killed} application process(es)")
    else:
        print("[run_server] No stale application processes found")

# Kill all Python processes for clean slate
kill_all_python_processes()

# Small delay to let ports clear
import time

time.sleep(1)

# Ensure UTF-8 for subprocess stdout
env = os.environ.copy()
env["PYTHONIOENCODING"] = "utf-8"

with open("server.log", "w", encoding="utf-8") as log_file:
    # Run uvicorn as subprocess, redirecting output to file
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "uvicorn", "api.main:app", "--reload", "--host", "0.0.0.0", "--port", "8000"],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        bufsize=0,  # Unbuffered
        env=env
    )
    print(f"[run_server] Server started with PID {proc.pid}. Logs in server.log")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
