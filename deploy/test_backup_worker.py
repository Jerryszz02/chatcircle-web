import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class WorkerTests(unittest.TestCase):
    def test_corrupt_download_retains_old_archive_and_reports_failure(self):
        worker = load('backup-worker.py')
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder)
            old = dest / 'cc_daily_20260101_020000_1234567890abcdef.zip'
            old.write_bytes(b'previous verified snapshot')
            with patch.dict(os.environ, {'BACKUP_DEST': folder, 'BACKUP_RETENTION_COUNT': '2'}), patch.object(worker, 'request', side_effect=[io.BytesIO(b'PKtruncated'), io.BytesIO(b'{}')]) as api:
                self.assertEqual(worker.main(), 1)
            self.assertTrue(old.exists())
            self.assertFalse(list(dest.glob('*.partial')))
            self.assertEqual(json.loads((dest / 'last_backup.json').read_text())['result'], 'failure')
            self.assertEqual(api.call_args.args[0], 'result')


    def test_rehearsal_releases_networks_without_deleting_recovery_data(self):
        rehearsal = load('rehearse-restore.py')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); data = root / 'data'; data.mkdir(); (data / 'preserve').touch()
            compose = ['docker', 'compose', '-p', 'cc-restore-fixture', '-f', str(root / 'docker-compose.yml')]
            with patch.object(rehearsal, 'run') as command:
                rehearsal.finish_rehearsal(compose, root, {}, False)
                command.assert_called_once_with(compose + ['down'])
            self.assertTrue((data / 'preserve').exists())
            self.assertTrue(json.loads((root / 'report.json').read_text())['resources_cleaned'])
            with patch.object(rehearsal, 'run') as command:
                rehearsal.finish_rehearsal(compose, root, {}, True)
                command.assert_not_called()
            self.assertTrue(json.loads((root / 'report.json').read_text())['resources_retained'])
            with patch.object(rehearsal, 'run', side_effect=RuntimeError):
                with self.assertRaises(RuntimeError): rehearsal.finish_rehearsal(compose, root, {}, False)
            self.assertFalse(json.loads((root / 'report.json').read_text())['resources_cleaned'])

    def test_restore_rejects_zip_traversal_and_existing_destination(self):
        restore = load('restore-files.py')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('data.db', b'')
                z.writestr('../escaped', b'bad')
            with self.assertRaisesRegex(ValueError, 'unsafe ZIP'): restore.restore(archive, root / 'new')
            self.assertFalse((root / 'escaped').exists())
            existing = root / 'existing'; existing.mkdir(); (existing / 'preserve').touch()
            with self.assertRaisesRegex(ValueError, 'empty'): restore.restore(archive, existing)

if __name__ == '__main__': unittest.main()
