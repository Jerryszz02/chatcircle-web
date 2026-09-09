#!/usr/bin/env python3
"""Opt-in OSS transfer of the latest successful PocketBase ZIP; no live database copy.
Requires docker compose, ossutil 2 and a private, encrypted mainland offsite bucket.
Credentials stay in the owner's 0600 ossutil config. Never runs during build/deploy.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


def validate_marker(marker, now):
    if marker.get('result') != 'success':
        raise ValueError('本机备份未成功')
    name = marker.get('file', '')
    if not isinstance(name, str) or not re.fullmatch(r'cc_daily_\d{8}_\d{6}(?:_[0-9a-f]{16})?\.zip', name):
        raise ValueError('备份文件名无效')
    finished = datetime.fromisoformat(str(marker.get('finished_at', '')).replace('Z', '+00:00'))
    age = (now - finished).total_seconds()
    if age < 0 or age > 26 * 3600:
        raise ValueError('本机备份过期或时间异常')
    if not isinstance(marker.get('bytes'), int) or marker['bytes'] <= 0:
        raise ValueError('备份大小无效')
    return name


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def command(args, cwd):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=3600)
    if result.returncode:
        # Provider errors may contain signing information. Do not echo raw output.
        raise RuntimeError('%s 执行失败（exit=%s）；在服务器受控环境排查' % (args[0], result.returncode))
    return result.stdout


def transfer(project, destination, config):
    if not re.fullmatch(r'oss://[a-z0-9][a-z0-9-]{1,61}[a-z0-9]/[A-Za-z0-9_/-]+/', destination):
        raise ValueError('目标须为 oss://bucket/专用前缀/，末尾保留斜杠')
    if config.stat().st_mode & 0o077:
        raise ValueError('ossutil 凭据文件权限须为 600 或更严格')
    compose = ['docker', 'compose']
    marker = json.loads(command(compose + ['exec', '-T', 'backup', 'cat', '/backups/last_backup.json'], project))
    name = validate_marker(marker, datetime.now(timezone.utc))
    with tempfile.TemporaryDirectory(prefix='cc-offsite-') as temp:
        local = Path(temp) / name
        restored = Path(temp) / 'verified.zip'
        command(compose + ['cp', 'backup:/backups/' + name, str(local)], project)
        if local.stat().st_size != marker['bytes']:
            raise ValueError('备份大小与成功标记不一致')
        with zipfile.ZipFile(local) as archive:
            if 'data.db' not in archive.namelist() or archive.testzip() is not None:
                raise ValueError('备份 ZIP 损坏或缺少 data.db')
        checksum = sha256(local)
        remote = destination + name
        command(['ossutil', 'cp', str(local), remote, '-f', '-c', str(config)], temp)
        # A successful upload alone isn't recovery evidence: verify an actual read-back.
        command(['ossutil', 'cp', remote, str(restored), '-f', '-c', str(config)], temp)
        if sha256(restored) != checksum:
            raise ValueError('异地备份下载校验不一致')
    return {'result': 'success', 'file': name, 'sha256': checksum, 'bytes': marker['bytes'],
            'source_finished_at': marker['finished_at']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--marker', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        result = transfer(args.project.resolve(), args.destination, args.config.resolve())
    except Exception as error:
        # Known errors are safe; subprocess timeout strings could reveal output.
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
        result = {'result': 'failure', 'reason': message}
    result['finished_at'] = datetime.now(timezone.utc).isoformat()
    args.marker.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=args.marker.parent, delete=False) as stream:
        json.dump(result, stream, ensure_ascii=False)
        temporary = Path(stream.name)
    temporary.replace(args.marker)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['result'] == 'success' else 1


if __name__ == '__main__':
    raise SystemExit(main())
