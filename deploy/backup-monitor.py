#!/usr/bin/env python3
"""Host-side freshness + runtime watchdog with TLS mail, state dedup and recovery.
Python 3.6+ (ECS). Configure environment with a root-readable systemd EnvironmentFile.
"""
import argparse
from email.message import EmailMessage
import json
import os
from pathlib import Path
import smtplib
import ssl
import subprocess
import time


def probe(project):
    try:
        result = subprocess.run(['docker', 'compose', 'exec', '-T', 'backup', 'python3',
                                 '/usr/local/bin/check-backup.py'], cwd=str(project),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def notify(recovered, test=False):
    sender = os.environ.get('BACKUP_ALERT_FROM') or os.environ['CONTACT_FROM']
    receiver = os.environ.get('BACKUP_ALERT_TO') or os.environ['CONTACT_TO']
    msg = EmailMessage()
    msg['From'], msg['To'] = sender, receiver
    msg['Subject'] = '[ChatCircle] ' + ('[演练] ' if test else '') + ('备份恢复正常' if recovered else '备份故障告警')
    msg.set_content(('这是一封隔离演练测试通知，正式服务未发生故障。\n' if test else '') +
                    ('一致性备份检查已恢复正常。' if recovered else '备份失败、超过36小时未更新，或备份容器无法访问。请检查服务器上的 last_backup.json 和服务状态。') +
                    '\n本通知不包含账号、密钥、业务数据或备份附件。')
    context = ssl.create_default_context()
    port = int(os.environ.get('SMTP_PORT', '465'))
    secure = os.environ.get('SMTP_SECURE', 'true').lower() != 'false'
    cls = smtplib.SMTP_SSL if secure else smtplib.SMTP
    kwargs = dict(host=os.environ['SMTP_HOST'], port=port, timeout=30)
    if secure:
        kwargs['context'] = context
    with cls(**kwargs) as smtp:
        if not secure:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASS'])
        refused = smtp.send_message(msg)
        if refused:
            raise RuntimeError('SMTP recipient rejected')


def monitor(project, state_path, test=False):
    healthy = probe(project)
    previous = {}
    if state_path.exists():
        try:
            previous = json.loads(state_path.read_text())
        except (ValueError, OSError):
            previous = {}  # Corrupt state must not suppress a real failure alert.
    # First healthy check is silent. Failure repeats every 24h until resolved.
    changed = previous.get('healthy') is not healthy
    send = (not healthy and (changed or time.time() - previous.get('notified_at', 0) >= 86400)) or (healthy and previous.get('healthy') is False)
    if send:
        notify(healthy, test=test)
        previous['notified_at'] = time.time()
        print('SMTP_ACCEPTED: ' + ('recovery' if healthy else 'failure'))
    previous.update(healthy=healthy, checked_at=time.time())
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temp = state_path.with_suffix('.tmp')
    temp.write_text(json.dumps(previous))
    temp.replace(state_path)
    return 0 if healthy else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path('/opt/chatcircle'))
    parser.add_argument('--state', type=Path, default=Path('/var/lib/chatcircle-monitor/state.json'))
    parser.add_argument('--test', action='store_true', help='Label messages as rehearsal (still runs the real probe)')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        raise SystemExit(monitor(args.project, args.state, args.test))
    except Exception as error:
        # Never echo SMTP server responses or credentials into journal.
        print('MONITOR_ERROR: ' + type(error).__name__)
        raise SystemExit(2)
