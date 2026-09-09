"""Synthetic old-data preservation, upgraded backup restore, and old rollback proof."""
import contextlib
import io
import pathlib
import socket
import subprocess
import sys
import time
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).parent / 'integration'))
from cc_client import call

new_binary, old_binary, work, hooks, migrations = sys.argv[1:]
work = pathlib.Path(work)


@contextlib.contextmanager
def serve(binary, data, hook_dir, migration_dir):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = 'http://127.0.0.1:%d' % port
    with (work / ('serve-%d.log' % port)).open('w') as log:
        process = subprocess.Popen([binary, 'serve', '--dir', str(data), '--hooksDir', str(hook_dir),
                                    '--migrationsDir', str(migration_dir), '--http', '127.0.0.1:%d' % port],
                                   stdout=log, stderr=log)
        try:
            for _ in range(50):
                if process.poll() is not None:
                    raise AssertionError('PocketBase exited: ' + str(process.returncode))
                try:
                    if call(base, 'GET', '/api/health')[0] == 200:
                        break
                except Exception:
                    time.sleep(0.1)
            else:
                raise AssertionError('PocketBase did not become healthy')
            yield base
        finally:
            process.terminate()
            process.wait(timeout=10)


def preserved_record(base):
    status, auth = call(base, 'POST', '/api/collections/_superusers/auth-with-password', {
        'identity': 'upgrade@example.test', 'password': 'synthetic-upgrade-password'})
    assert status == 200, auth
    token = auth['token']
    status, org = call(base, 'GET', '/api/collections/organizations/records/upgradeorg00001', token=token)
    assert status == 200 and org['name'] == 'Old fixture retained' and org['status'] == 'active', org
    return token


with serve(new_binary, work / 'pb_data', hooks, migrations) as base:
    token = preserved_record(base)
    print('PASS: upgraded server authenticates and preserves old application record')
    status, response = call(base, 'POST', '/api/backups', {'name': 'synthetic-upgrade.zip'}, token)
    assert status in (200, 204), response
    status, file_auth = call(base, 'POST', '/api/files/token', {}, token)
    assert status == 200, file_auth
    status, blob = call(base, 'GET', '/api/backups/synthetic-upgrade.zip?token=' + file_auth['token'], raw=True)
    assert status == 200, status
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            assert not name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
        archive.extractall(work / 'new_restore')
    print('PASS: upgraded PocketBase creates and downloads a valid consistent backup')

with serve(new_binary, work / 'new_restore', hooks, migrations) as base:
    preserved_record(base)
    print('PASS: restored upgraded backup boots, authenticates and retains application data')

with serve(old_binary, work / 'old_restore', work / 'old_hooks', work / 'old_migrations') as base:
    preserved_record(base)
    print('PASS: stopped pre-upgrade snapshot restores with old binary')
