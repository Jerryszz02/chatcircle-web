#!/usr/bin/env python3
"""ECS isolation rehearsal (Python 3.6+): existing backup → new directories/networks.
No production write/restore, external networking, notifications, or production ports.
Images must already be built and named with --tag. Retains protected evidence on exit.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import time


def run(args, cwd=None, data=None):
    result = subprocess.run(args, cwd=str(cwd) if cwd else None, input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Docker errors can print interpolated environment values: never echo them.
        raise RuntimeError('command failed: ' + args[0])
    return result.stdout


def main(args):
    os.umask(0o077)
    root = args.destination.resolve()
    if root.exists():
        raise ValueError('destination must not already exist')
    root.mkdir(parents=True)
    project = 'cc-restore-' + secrets.token_hex(4)
    report = dict(project=project, production_unchanged=True, checks={})
    compose = ['docker', 'compose', '-p', project, '-f', str(root / 'docker-compose.yml')]
    old = ['docker', 'compose']
    def production_id(service):
        return run(old + ['ps', '-q', service], args.production).decode().strip()
    app_id, backup_id = production_id('app'), production_id('backup')
    before = run(['docker', 'inspect', '-f', '{{.Image}}', app_id]).decode().strip()
    app = json.loads(run(['docker', 'inspect', app_id]))[0]
    report['source_app_revision'] = app['Config']['Labels'].get('org.opencontainers.image.revision', 'unknown')
    env = dict(value.split('=', 1) for value in app['Config']['Env'] if '=' in value)
    source_env = dict(value.split('=', 1) for value in json.loads(run(['docker', 'inspect', backup_id]))[0]['Config']['Env'] if '=' in value)
    # The new backup runtime intentionally has no superuser credentials. Read
    # the operator's existing protected file only for isolated login acceptance.
    env_file = args.production / '.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if '=' not in line or line.lstrip().startswith('#'): continue
            key, value = line.split('=', 1)
            if key in ('PB_SUPERUSER_EMAIL', 'PB_SUPERUSER_PASSWORD'):
                parsed = shlex.split(value, comments=True)
                source_env[key] = parsed[0] if parsed else ''
    marker = json.loads(run(['docker', 'exec', backup_id, 'cat', '/backups/last_backup.json']))
    name = marker.get('file', '')
    if marker.get('result') != 'success' or not re.fullmatch(r'cc_daily_\d{8}_\d{6}_[0-9a-f]{16}\.zip', name):
        raise ValueError('no valid successful production backup marker')
    archive = root / name
    run(['docker', 'cp', backup_id + ':/backups/' + name, str(archive)])
    if archive.stat().st_size != marker['bytes']:
        raise ValueError('archive size mismatch')
    digest = hashlib.sha256()
    with archive.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''): digest.update(block)
    checksum = digest.hexdigest()
    if marker.get('sha256') and marker['sha256'] != checksum:
        raise ValueError('archive SHA-256 mismatch')
    report.update(archive=name, archive_sha256=checksum, backup_release_sha=marker.get('release_sha', 'legacy-unrecorded'),
                  candidate_tag=args.tag, source_finished_at=marker.get('finished_at'))
    scripts = Path(__file__).resolve().parent
    # Only this new rehearsal tree is writable. Never mount the production volume.
    utility = ['docker', 'run', '--rm', '--network', 'none', '--user', '0', '--cap-drop', 'ALL',
               '--read-only', '--security-opt', 'no-new-privileges',
               '-v', str(root) + ':/rehearsal', '-v', str(scripts) + ':/scripts:ro',
               '--entrypoint', 'python3', 'chatcircle-backup:' + args.tag, '/scripts/restore-files.py']
    baseline = json.loads(run(utility + ['restore', '/rehearsal/' + name, '/rehearsal/data']))
    report['checks']['zip_sqlite'] = True
    (root / 'baseline.json').write_text(json.dumps(baseline))
    for folder in ('data', 'backups', 'caddy-data', 'caddy-config'):
        path = root / folder
        path.mkdir(exist_ok=True)
        for parent, dirs, files in os.walk(str(path)):
            os.chown(parent, 10001, 10001)
            for file in files: os.chown(os.path.join(parent, file), 10001, 10001)
    # Read the candidate topology, replacing every production binding/config/secret.
    config_env = dict(os.environ, CC_PHONE_HASH_KEY='rehearsal-config-placeholder-32-characters',
                      CC_BACKUP_KEY='rehearsal-config-placeholder-32-characters', CC_RELEASE_SHA=args.tag)
    result = subprocess.run(['docker', 'compose', 'config', '--format', 'json'], cwd=str(scripts.parent), env=config_env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode: raise RuntimeError('candidate compose invalid')
    config = json.loads(result.stdout)
    config['name'] = project
    config['volumes'] = {}
    config['networks'] = {name: {'internal': True} for name in config['networks']}
    for name, service in config['services'].items():
        service.pop('build', None)
        service['restart'] = 'no'
        service.pop('ports', None)
        service['volumes'] = []
    backup_key = secrets.token_hex(32)
    config['services']['app']['environment'] = dict(CC_ENVIRONMENT='test', CC_SMS_PROVIDER='mock',
        CC_PHONE_HASH_KEY=env['CC_PHONE_HASH_KEY'], CC_BACKUP_KEY=backup_key)
    config['services']['app']['volumes'] = [str(root / 'data') + ':/pb/pb_data']
    config['services']['backup']['environment'] = dict(PB_URL='http://app:8090', CC_BACKUP_KEY=backup_key, TZ='Asia/Shanghai')
    config['services']['backup']['volumes'] = [str(root / 'backups') + ':/backups']
    gateway = (scripts / 'Caddyfile').read_text().replace('import /config/sites/*.caddy', '').replace('chatcircle.empact.cn {', ':8080 {')
    (root / 'Caddyfile').write_text(gateway)
    os.chmod(str(root / 'Caddyfile'), 0o644)
    config['services']['caddy']['volumes'] = [str(root / 'Caddyfile') + ':/etc/caddy/Caddyfile:ro',
        str(root / 'caddy-data') + ':/data', str(root / 'caddy-config') + ':/config']
    (root / 'docker-compose.yml').write_text(json.dumps(config))
    try:
        run(compose + ['up', '-d', '--no-build', '--pull', 'never'])
        for service in ('app', 'backup', 'public-web'):
            cid = run(compose + ['ps', '-q', service]).decode().strip()
            for _ in range(60):
                status = run(['docker', 'inspect', '-f', '{{.State.Health.Status}}', cid]).decode().strip()
                if status == 'healthy': break
                time.sleep(1)
            else: raise RuntimeError('rehearsal service unhealthy: ' + service)
        report['checks']['all_services_healthy'] = True
        # Caddy runs without host bindings or ACME. Probe within its own container.
        for path in ('/', '/about', '/activities', '/login', '/super/login', '/api/cc/health'):
            for attempt in range(10):
                try:
                    run(compose + ['exec', '-T', 'caddy', 'wget', '-qO', '/dev/null', 'http://127.0.0.1:8080' + path])
                    break
                except RuntimeError:
                    if attempt == 9: raise RuntimeError('gateway probe failed: ' + path)
                    time.sleep(1)
        report['checks']['gateway_public_spa_api'] = True
        run(compose + ['exec', '-T', 'backup', 'sh', '/etc/periodic/daily/backup'])
        run(compose + ['exec', '-T', 'backup', 'python3', '/usr/local/bin/check-backup.py'])
        report['checks']['backup_after_restore'] = True
        # Exercise real super login from inside the isolated network. Credentials use stdin.
        test = r'''
import json,sys,urllib.request,urllib.error
config=json.load(sys.stdin)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path,body=None,headers=None):
 req=urllib.request.Request('http://app:8090'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers or {})
 req.add_header('Content-Type','application/json')
 return opener.open(req,timeout=20)
with call('/api/collections/_superusers/auth-with-password',{'identity':config['email'],'password':config['password']}) as response: token=json.load(response)['token']
with call('/api/cc/super/backup-status',headers={'Authorization':token}) as response: assert json.load(response)['alert'] is False
try: call('/api/cc/super/backup-status')
except urllib.error.HTTPError as error: assert error.code==401
else: raise AssertionError('anonymous super access')
print('AUTH_AND_BACKUP_STATUS_OK')
'''
        credentials = dict(email=source_env.get('PB_SUPERUSER_EMAIL', ''), password=source_env.get('PB_SUPERUSER_PASSWORD', ''))
        if not all(credentials.values()):
            raise ValueError('rehearsal needs existing controlled superuser credentials for auth acceptance')
        run(compose + ['exec', '-T', 'backup', 'python3', '-c', test], data=json.dumps(credentials).encode())
        report['checks']['super_login_anonymous_denial_and_backup_status'] = True
        # Pause ONLY the rehearsal app to compare the durable state without WAL races.
        run(compose + ['stop', 'app'])
        after = json.loads(run(utility + ['inspect', '/rehearsal/data']))
        unchanged = all(after['tables'].get(t) == count for t, count in baseline['tables'].items() if t not in ('audit_logs', 'cc_rate_counters'))
        if not unchanged or after['files'] != baseline['files']:
            raise ValueError('restored business counts or uploads differ')
        report['checks']['business_counts_and_upload_hashes'] = True
        report['business_tables'] = len(baseline['tables'])
        report['uploaded_files'] = len(baseline['files'])
        run(compose + ['start', 'app'])
        report['result'] = 'success'
    finally:
        report['production_unchanged'] = run(['docker', 'inspect', '-f', '{{.Image}}', app_id]).decode().strip() == before
        (root / 'report.json').write_text(json.dumps(report, indent=2))
        # Leave isolated services for the explicit notification failure/recovery drill.
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--production', type=Path, default=Path('/opt/chatcircle'))
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    try: main(parser.parse_args())
    except Exception as error:
        print('REHEARSAL_ERROR: ' + type(error).__name__ + ': ' + str(error))
        raise SystemExit(1)
