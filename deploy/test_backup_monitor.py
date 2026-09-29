import importlib.util
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def module(filename):
    spec = importlib.util.spec_from_file_location(filename, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class MonitorTests(unittest.TestCase):
    def test_failure_dedup_recovery_and_delivery_retry(self):
        monitor = module('backup-monitor.py')
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder) / 'state.json'
            with patch.object(monitor, 'probe', return_value=False), patch.object(monitor, 'notify', side_effect=RuntimeError):
                with self.assertRaises(RuntimeError): monitor.monitor(Path(folder), state)
                self.assertFalse(state.exists(), 'failed delivery must retry on next check')
            with patch.object(monitor, 'probe', return_value=False), patch.object(monitor, 'notify') as send:
                self.assertEqual(monitor.monitor(Path(folder), state), 1)
                self.assertEqual(monitor.monitor(Path(folder), state), 1)
                send.assert_called_once_with(False, test=False)
            with patch.object(monitor, 'probe', return_value=True), patch.object(monitor, 'notify') as send:
                self.assertEqual(monitor.monitor(Path(folder), state), 0)
                send.assert_called_once_with(True, test=False)

    def test_missing_failed_stale_and_archive_loss(self):
        checker = module('check-backup.py')
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder); now = datetime.now(timezone.utc)
            with self.assertRaises(FileNotFoundError): checker.check(dest, now)
            marker = dest / 'last_backup.json'
            data = {'result': 'failure'}
            marker.write_text(json.dumps(data))
            with self.assertRaises(ValueError): checker.check(dest, now)
            name = 'cc_daily_20260929_020000_1234567890abcdef.zip'
            data = dict(result='success', file=name, bytes=2, finished_at=now.strftime('%Y-%m-%dT%H:%M:%SZ'))
            marker.write_text(json.dumps(data))
            with self.assertRaises(ValueError): checker.check(dest, now)
            (dest / name).write_bytes(b'PK')
            self.assertEqual(checker.check(dest, now), data)
            with self.assertRaises(ValueError): checker.check(dest, now + timedelta(hours=37))

if __name__ == '__main__': unittest.main()
