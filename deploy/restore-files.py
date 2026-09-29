#!/usr/bin/env python3
"""Validate/extract a PocketBase ZIP into a NEW isolated directory, report no rows."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import sys
import zipfile


def inspect(folder):
    tables = {}
    for name in ('data.db', 'auxiliary.db'):
        path = folder / name
        if not path.exists():
            continue
        with sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as db:
            if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise ValueError('database integrity failed')
            if name == 'data.db':
                for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                    if not table.startswith('_') and not table.startswith('sqlite_'):
                        tables[table] = db.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0]
    files = {}
    storage = folder / 'storage'
    if storage.exists():
        for path in storage.rglob('*'):
            if path.is_file():
                files[str(path.relative_to(folder))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(tables=tables, files=files)


def restore(archive, dest):
    if dest.exists() and any(dest.iterdir()):
        raise ValueError('restore destination must be empty')
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        if source.testzip() is not None or 'data.db' not in source.namelist():
            raise ValueError('invalid ZIP')
        seen = set()
        for item in source.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in item.filename or item.filename in seen or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError('unsafe ZIP entry')
            seen.add(item.filename)
        total = sum(item.file_size for item in source.infolist())
        if shutil.disk_usage(dest).free < total * 3 + 512 * 1024 * 1024:
            raise ValueError('insufficient disk reserve for rehearsal')
        source.extractall(dest)
    return inspect(dest)


if __name__ == '__main__':
    if sys.argv[1] == 'restore':
        result = restore(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        result = inspect(Path(sys.argv[2]))
    print(json.dumps(result, sort_keys=True))
