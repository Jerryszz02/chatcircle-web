#!/usr/bin/env python3
"""Scoped snapshot client. Secrets never enter argv, URLs or error output."""
from datetime import datetime, timezone
import json
import hashlib
import os
import re
from pathlib import Path
import secrets
import sqlite3
import tempfile
import time
import urllib.request
import zipfile


def request(path, body=None):
    key = os.environ.get('CC_BACKUP_KEY', '')
    if len(key) < 32:
        raise ValueError('CC_BACKUP_KEY missing or too short')
    url = os.environ.get('PB_URL', 'http://app:8090').rstrip('/') + '/api/cc/internal/backup/' + path
    req = urllib.request.Request(url, data=json.dumps(body or {}).encode(), method='POST',
                                 headers={'X-Backup-Key': key, 'Content-Type': 'application/json'})
    # Do not follow redirects that could disclose the capability to another host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(req, timeout=300)


def verify(path):
    with zipfile.ZipFile(path) as archive:
        if 'data.db' not in archive.namelist() or archive.testzip() is not None:
            raise ValueError('invalid ZIP or missing data.db')
        # Extract only the known database members to private scratch for integrity.
        with tempfile.TemporaryDirectory(dir=path.parent, prefix='.verify-') as folder:
            for name in ('data.db', 'auxiliary.db'):
                if name not in archive.namelist():
                    continue
                target = Path(folder) / name
                with archive.open(name) as source, target.open('wb') as out:
                    import shutil
                    shutil.copyfileobj(source, out)
                with sqlite3.connect(target.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as db:
                    if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                        raise ValueError('SQLite integrity failed')


def atomic_json(path, data):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.marker-', delete=False) as out:
        json.dump(data, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(out.name, path)


def main():
    os.umask(0o077)
    dest = Path(os.environ.get('BACKUP_DEST', '/backups'))
    started = time.monotonic()
    name = 'cc_daily_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + secrets.token_hex(8) + '.zip'
    partial = dest / ('.' + name + '.partial')
    result = dict(result='failure', file='', bytes=0, reason='')
    try:
        raw_count = os.environ.get('BACKUP_RETENTION_COUNT', '2')
        if not re.fullmatch(r'[1-9][0-9]{0,5}', raw_count):
            raise ValueError('invalid retention count')
        count = int(raw_count)
        with request('snapshot') as response, partial.open('wb') as out:
            import shutil
            shutil.copyfileobj(response, out)
            out.flush()
            os.fsync(out.fileno())
        verify(partial)
        final = dest / name
        os.replace(partial, final)
        digest = hashlib.sha256()
        with final.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        archive_meta = dict(file=name, bytes=final.stat().st_size,
                            release_sha=os.environ.get('CC_RELEASE_SHA', 'unknown'), sha256=digest.hexdigest())
        atomic_json(dest / (name + '.json'), archive_meta)
        # Preserve PR #79: newest N by nanosecond mtime, always including this
        # verified archive. Validate every retained recovery point before deletion.
        managed = [path for path in dest.glob('cc_daily_*.zip')
                   if path != final and path.is_file() and not path.is_symlink()
                   and re.fullmatch(r'cc_daily_\d{8}_\d{6}(?:_[0-9a-f]{16})?\.zip', path.name)]
        managed.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
        for previous in managed[:count - 1]:
            verify(previous)
        for old in managed[count - 1:]:
            old.unlink()
            (dest / (old.name + '.json')).unlink(missing_ok=True)
        result.update(archive_meta)
        result['result'] = 'success'
    except Exception as error:
        # HTTP exceptions can contain URLs/headers; log only safe error classes.
        result.update(result='failure', file='', bytes=0, reason='backup failed: ' + type(error).__name__)
    finally:
        partial.unlink(missing_ok=True)
    result['duration_ms'] = int((time.monotonic() - started) * 1000)
    result['finished_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    atomic_json(dest / 'last_backup.json', result)
    try:
        with request('result', result):
            pass
    except Exception:
        print('[backup] warning: audit delivery failed; check last_backup.json', flush=True)
    print('[backup] ' + result['result'] + ': ' + result['file'], flush=True)
    return 0 if result['result'] == 'success' else 1


if __name__ == '__main__':
    raise SystemExit(main())
