import importlib.util
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('offsite', Path(__file__).with_name('offsite-backup.py'))
offsite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(offsite)


class OffsiteTests(unittest.TestCase):
    def test_reject_failed_stale_and_path_traversal(self):
        now = datetime.now(timezone.utc)
        marker = {'result': 'success', 'file': 'cc_daily_20260905_020000.zip', 'bytes': 100, 'finished_at': now.isoformat()}
        self.assertEqual(offsite.validate_marker(marker, now), marker['file'])
        unique = {**marker, 'file': 'cc_daily_20260905_020000_0123456789abcdef.zip'}
        self.assertEqual(offsite.validate_marker(unique, now), unique['file'])
        for change in [{'file': 'cc_daily_20260905_020000_../data.db.zip'}, {'result': 'failure'}, {'file': '../data.db'}, {'bytes': 0}, {'finished_at': (now - timedelta(hours=27)).isoformat()}]:
            with self.assertRaises(ValueError):
                offsite.validate_marker({**marker, **change}, now)

    def test_roundtrip_required_before_success(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            config = project / 'config'
            config.touch(mode=0o600)
            archive = project / 'source.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('data.db', 'synthetic-test-data')
            blob = archive.read_bytes()
            marker = {'result': 'success', 'file': 'cc_daily_20260905_020000.zip', 'bytes': len(blob), 'finished_at': datetime.now(timezone.utc).isoformat()}
            calls = []
            corrupt = False

            def fake(args, cwd):
                calls.append(args)
                if 'cat' in args:
                    return json.dumps(marker)
                if args[:3] == ['docker', 'compose', 'cp']:
                    Path(args[-1]).write_bytes(blob)
                if args[:2] == ['ossutil', 'cp'] and args[2].startswith('oss://'):
                    Path(args[3]).write_bytes(b'corrupt' if corrupt else blob)
                return ''

            with patch.object(offsite, 'command', side_effect=fake):
                result = offsite.transfer(project, 'oss://test-bucket/chatcircle/', config)
                self.assertEqual(result['result'], 'success')
                self.assertEqual(len([c for c in calls if c[0] == 'ossutil']), 2)
                corrupt = True
                with self.assertRaisesRegex(ValueError, '下载校验'):
                    offsite.transfer(project, 'oss://test-bucket/chatcircle/', config)


if __name__ == '__main__':
    unittest.main()
