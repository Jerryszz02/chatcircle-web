"""Run the real shell retention path with synthetic HTTP and real ZIP validation."""
import json
import os
from pathlib import Path
import shutil
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
        commands = self.root / 'bin'
        commands.mkdir()
        if not shutil.which('flock'):
            shim = commands / 'flock'
            shim.write_text('#!/usr/bin/env python3\nimport fcntl,sys\nfcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)\n')
            shim.chmod(0o755)
        wget = commands / 'wget'
        wget.write_text('''#!/usr/bin/env python3
import os,sys,zipfile
from pathlib import Path
args=sys.argv[1:]
if '-qO' in args:
    path=Path(args[args.index('-qO')+1])
    if os.environ.get('CORRUPT_DOWNLOAD'):
        path.write_bytes(b'PKtruncated')
    else:
        with zipfile.ZipFile(path,'w') as z: z.writestr('data.db',b'fixture')
elif args[-1].endswith('/auth-with-password') or args[-1].endswith('/api/files/token'):
    print('{"token":"synthetic"}')
else:
    print('{}')
''')
        wget.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(commands) + os.pathsep + os.environ['PATH'],
                    'BACKUP_DEST': str(self.dest), 'BACKUP_PBDATA': str(self.root / 'pbdata'),
                    'PB_SUPERUSER_EMAIL': 'test@example.test', 'PB_SUPERUSER_PASSWORD': 'synthetic'}
        self.env.pop('BACKUP_RETENTION_COUNT', None)
        self.old = []
        for i in range(1, 5):
            p = self.dest / ('cc_daily_20260101_%06d.zip' % i)
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('data.db', b'fixture')
            self.old.append(p)

    def run_backup(self, **extra):
        return subprocess.run(['sh', str(SCRIPT)], env={**self.env, **extra}, capture_output=True, text=True)

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
