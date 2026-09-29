"""Execute the backup shell script with local fake HTTP commands and real OS locks."""
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(os.environ.get('CC_BACKUP_SCRIPT', Path(__file__).with_name('backup.sh'))).resolve()


class BackupLockTests(unittest.TestCase):
    def run_overlap(self, fail_first):
        with tempfile.TemporaryDirectory(prefix='cc_backup_lock_') as folder:
            root = Path(folder)
            commands = root / 'bin'
            commands.mkdir()
            # macOS has no flock command. Use the same kernel flock primitive on
            # the shell's inherited descriptor; Linux CI executes util-linux flock.
            if not shutil.which('flock'):
                shim = commands / 'flock'
                shim.write_text('#!/usr/bin/env python3\nimport fcntl,sys\nfcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)\n')
                shim.chmod(0o755)
            # Execute the real worker against a bounded local HTTP fixture.
            import io, sqlite3, zipfile, threading
            from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
            db = root / 'fixture.db'
            sqlite3.connect(db).close()
            payload = io.BytesIO()
            with zipfile.ZipFile(payload, 'w') as archive:
                archive.write(db, 'data.db')
            request_count = [0]
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args): pass
                def do_POST(self):
                    if self.path.endswith('/snapshot'):
                        request_count[0] += 1
                        run_id = 'first' if request_count[0] == 1 else 'second'
                        with (root / 'events').open('a') as log: log.write(run_id + '\n')
                        if run_id == 'first':
                            while not (root / 'release').exists(): time.sleep(.01)
                        if fail_first and run_id == 'first':
                            self.send_error(503); return
                        self.send_response(200); self.end_headers(); self.wfile.write(payload.getvalue())
                    else:
                        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            dest = root / 'backups'
            dest.mkdir()
            marker = dest / 'last_backup.json'
            marker.write_text('{"result":"previous"}')
            env = {**os.environ, 'PATH': str(commands) + os.pathsep + os.environ['PATH'],
                   'TEST_ROOT': str(root), 'BACKUP_DEST': str(dest), 'BACKUP_PBDATA': str(root / 'pbdata'),
                   'PB_URL': 'http://127.0.0.1:%s' % server.server_port,
                   'CC_BACKUP_KEY': 'synthetic-backup-test-key-32-characters'}
            first = subprocess.Popen(['sh', str(SCRIPT)], env={**env, 'RUN_ID': 'first', 'HOLD_HEALTH': '1',
                                     'FAIL_AUTH': '1' if fail_first else '0'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            second = None
            try:
                deadline = time.monotonic() + 5
                while not (root / 'events').exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue((root / 'events').exists(), 'first backup must reach HTTP phase')
                second = subprocess.Popen(['sh', str(SCRIPT)], env={**env, 'RUN_ID': 'second'},
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                time.sleep(.3)
                self.assertIsNone(second.poll(), 'second backup must wait for the lock')
                self.assertEqual((root / 'events').read_text().splitlines(), ['first'])
                self.assertEqual(json.loads(marker.read_text()), {'result': 'previous'})
                (root / 'release').touch()
                out1, err1 = first.communicate(timeout=10)
                out2, err2 = second.communicate(timeout=10)
                self.assertEqual(first.returncode, 1 if fail_first else 0, (out1, err1))
                self.assertEqual(second.returncode, 0, (out2, err2))
                self.assertEqual((root / 'events').read_text().splitlines(), ['first', 'second'])
                self.assertEqual(json.loads(marker.read_text())['result'], 'success')
                self.assertEqual(len(list(dest.glob('cc_daily_*.zip'))), 1 if fail_first else 2)
                self.assertTrue((dest / '.backup.lock').exists(), 'lock inode must not be removed')
            finally:
                (root / 'release').touch()
                for process in (first, second):
                    if process:
                        process.communicate(timeout=10)
                server.shutdown()
                server.server_close()

    def test_deploy_rejects_legacy_script_before_invocation(self):
        workflow = Path(__file__).parents[1].joinpath('.github/workflows/deploy.yml').read_text()
        gate = workflow.split('            command -v flock >/dev/null', 1)[1].split("          '\n", 1)[0]
        gate = 'command -v flock >/dev/null' + gate
        with tempfile.TemporaryDirectory(prefix='cc_backup_gate_') as folder:
            root = Path(folder)
            installed = root / 'backup'
            invoked = root / 'invoked'
            flock = root / 'flock'
            flock.write_text('#!/bin/sh\nexit 0\n')
            flock.chmod(0o755)
            body = 'touch ' + shlex.quote(str(invoked)) + '\n'
            script = gate.replace('/etc/periodic/daily/backup', shlex.quote(str(installed)))
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            installed.write_text(body)
            rejected = subprocess.run(['sh', '-eu', '-c', script], env=env, capture_output=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(invoked.exists())
            installed.write_text('# cc-backup-lock-v1\n' + body)
            accepted = subprocess.run(['sh', '-eu', '-c', script], env=env, capture_output=True)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertTrue(invoked.exists())

    def test_cron_and_deploy_wait_then_keep_separate_archives(self):
        self.run_overlap(False)

    def test_failed_holder_releases_lock_for_waiting_backup(self):
        self.run_overlap(True)


if __name__ == '__main__':
    unittest.main()
