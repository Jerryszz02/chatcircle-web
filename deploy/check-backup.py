#!/usr/bin/env python3
"""Independent backup freshness probe; exits nonzero for failure, missing or stale data.
Run on the host via docker compose exec -T backup python3 /usr/local/bin/check-backup.py.
A host timer must also treat a stopped/unreachable container as failure.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path


def check(dest, now):
    marker = json.loads((dest / 'last_backup.json').read_text())
    if marker.get('result') != 'success':
        raise ValueError('last backup failed')
    finished = datetime.strptime(marker['finished_at'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    if not 0 <= (now - finished).total_seconds() <= 36 * 3600:
        raise ValueError('last backup stale or clock invalid')
    import re
    name = marker.get('file', '')
    if not re.fullmatch(r'cc_daily_\d{8}_\d{6}_[0-9a-f]{16}\.zip', name):
        raise ValueError('invalid archive name')
    path = dest / name
    if path.is_symlink() or not path.is_file() or path.stat().st_size != marker.get('bytes'):
        raise ValueError('archive missing or size mismatch')
    return marker


if __name__ == '__main__':
    try:
        check(Path(os.environ.get('BACKUP_DEST', '/backups')), datetime.now(timezone.utc))
    except Exception as error:
        print('BACKUP_ALERT: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__))
        raise SystemExit(1)
    print('BACKUP_OK')
