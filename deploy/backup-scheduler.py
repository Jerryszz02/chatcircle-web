#!/usr/bin/env python3
"""Non-root daily scheduler; heartbeat is separate from backup outcome monitoring."""
from datetime import datetime
import os
from pathlib import Path
import subprocess
import sys
import time

SCRIPT = Path('/etc/periodic/daily/backup')
HEARTBEAT = Path('/tmp/backup-scheduler.heartbeat')

if '--health' in sys.argv:
    healthy = (SCRIPT.is_file() and os.access(SCRIPT, os.X_OK) and
               HEARTBEAT.exists() and 0 <= time.time() - HEARTBEAT.stat().st_mtime < 90)
    raise SystemExit(0 if healthy else 1)

last_day = None
while True:
    HEARTBEAT.touch()
    now = datetime.now()
    if now.hour == 2 and last_day != now.date():
        last_day = now.date()
        # Keep heartbeats live while a bounded worker runs.
        process = subprocess.Popen(['sh', str(SCRIPT)], start_new_session=True)
        deadline = time.monotonic() + 1800
        while process.poll() is None:
            HEARTBEAT.touch()
            if time.monotonic() > deadline:
                import signal
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                break
            time.sleep(5)
    time.sleep(30)
