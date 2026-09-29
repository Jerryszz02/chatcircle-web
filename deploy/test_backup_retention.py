"""Exercise real worker retention with synthetic HTTP and real SQLite ZIPs."""
import json
import os
from pathlib import Path
import shutil
import io
import importlib.util
import sqlite3
from types import SimpleNamespace
from unittest.mock import patch
import subprocess
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('backup.sh').resolve()


class BackupRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cc_retention_')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dest = self.root / 'backups'
        self.dest.mkdir()
        self.env = {'BACKUP_DEST': str(self.dest)}
        db = self.root / 'fixture.db'
        with sqlite3.connect(db) as conn:
            conn.execute('CREATE TABLE fixture (id INTEGER PRIMARY KEY)')
        self.database = db.read_bytes()
        spec = importlib.util.spec_from_file_location('worker', SCRIPT.with_name('backup-worker.py'))
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)
        self.old = []
        for i in range(1, 5):
            p = self.dest / ('cc_daily_20260101_%06d.zip' % i)
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('data.db', self.database)
            self.old.append(p)

    def run_backup(self, **extra):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, 'w') as archive:
            archive.writestr('data.db', self.database)
        def request(path, body=None):
            return io.BytesIO((b'PKtruncated' if extra.get('CORRUPT_DOWNLOAD') else payload.getvalue()) if path == 'snapshot' else b'{}')
        with patch.dict(os.environ, {**self.env, **extra}, clear=True), patch.object(self.worker, 'request', side_effect=request):
            return SimpleNamespace(returncode=self.worker.main(), stderr='')

    def test_default_keeps_latest_two_and_preserves_unmanaged_files(self):
        manual = self.dest / 'cc_daily_manual.zip'
        manual.write_bytes(b'not managed')
        target = self.root / 'external.zip'
        target.write_bytes(b'untouched')
        link = self.dest / 'cc_daily_20270101_000000.zip'
        link.symlink_to(target)
        result = self.run_backup(BACKUP_RETENTION_DAYS='30')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([p.exists() for p in self.old], [False, False, False, True])
        marker = json.loads((self.dest / 'last_backup.json').read_text())
        self.assertEqual(marker['result'], 'success')
        self.assertTrue((self.dest / marker['file']).is_file())
        self.assertEqual(manual.read_bytes(), b'not managed')
        self.assertTrue(link.is_symlink())
        self.assertEqual(target.read_bytes(), b'untouched')

    def test_same_second_uses_subsecond_write_order_not_random_suffix(self):
        # The newer archive sorts before the older one lexically. Both writes
        # share the same whole-second mtime, as with fast serialized backups.
        for p in self.old:
            p.unlink()
        older = self.dest / 'cc_daily_20260101_000000_ffffffffffffffff.zip'
        newer = self.dest / 'cc_daily_20260101_000000_0000000000000000.zip'
        second_ns = 1767225600 * 1_000_000_000
        for p, offset in [(older, 100_000_000), (newer, 900_000_000)]:
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('data.db', self.database)
            os.utime(p, ns=(second_ns + offset, second_ns + offset))
        self.assertEqual(int(older.stat().st_mtime), int(newer.stat().st_mtime))
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(newer.exists(), 'immediately preceding backup must survive')
        self.assertFalse(older.exists(), 'older random-high suffix must be pruned')
        self.assertEqual(len(list(self.dest.glob('*.zip'))), 2)

    def test_new_corrupt_zip_never_prunes_history(self):
        result = self.run_backup(CORRUPT_DOWNLOAD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(set(self.dest.glob('*.zip')), set(self.old))
        self.assertEqual(json.loads((self.dest / 'last_backup.json').read_text())['result'], 'failure')

    def test_corrupt_previous_recovery_point_blocks_all_pruning(self):
        self.old[-1].write_bytes(b'PKtruncated')
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(all(p.exists() for p in self.old))
        self.assertEqual(len(list(self.dest.glob('*.zip'))), 5)

    def test_fewer_than_limit_keeps_all(self):
        result = self.run_backup(BACKUP_RETENTION_COUNT='10')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(p.exists() for p in self.old))

    def test_invalid_counts_do_not_prune(self):
        for value in ['0', '-2', 'two', '01', '999999999999999999999']:
            with self.subTest(value=value):
                result = self.run_backup(BACKUP_RETENTION_COUNT=value)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(all(p.exists() for p in self.old))


if __name__ == '__main__':
    unittest.main()
