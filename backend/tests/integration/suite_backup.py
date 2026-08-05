# -*- coding: utf-8 -*-
"""suite_backup — 备份告警（AC-23、PRD §12.3、security-privacy §11）。

断言：手动备份成功 → 状态接口 alert=false 且记录文件名；
故障注入失败 → 超级管理后台可读 alert=true 且审计留有 backup.failed/backup.success；
备份状态接口仅超级管理员可读（管理员/参与者/未认证拒绝）。
"""
import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_backup：备份告警（AC-23）')

    org = fx.create_org(base, st, '备份机构')
    _, AT = fx.create_admin(base, st, org, 'bkp_admin')
    _, PT, _ = fx.create_participant(base, 'bkp_user')

    # ---------- 1. 访问控制 ----------
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=AT)
    rep.check('BKP-01 机构管理员读备份状态 → 403', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=PT)
    rep.check('BKP-02 参与者读备份状态 → 403', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/super/backup-status')
    rep.check('BKP-03 未认证读备份状态 → 401', s == 401, r)
    s, r = call(base, 'POST', '/api/cc/super/backup/run', {}, AT)
    rep.check('BKP-04 机构管理员触发备份 → 403', s in (401, 403), r)

    # ---------- 2. 成功备份 → 无告警 ----------
    s, r = call(base, 'POST', '/api/cc/super/backup/run', {}, st)
    rep.check('BKP-05 手动备份成功（ok=true，返回文件名）',
              s == 200 and r.get('ok') is True and bool(r.get('backup')), r)
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    lb = r.get('last_backup') or {}
    rep.check('BKP-06 backup-status：result=success 且 alert=false',
              s == 200 and lb.get('result') == 'success' and r.get('alert') is False
              and bool(lb.get('file')) and bool(lb.get('created')), r)

    # ---------- 3. 故障注入 → 告警可见 + 审计 ----------
    s, r = call(base, 'POST', '/api/cc/super/backup/run', {'force_fail': True}, st)
    rep.check('BKP-07 故障注入备份失败 → 500 backup_failed',
              s == 500 and biz_code(r) == 'backup_failed', r)
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    lb = r.get('last_backup') or {}
    rep.check('BKP-08 失败后超级管理后台告警 alert=true 且 result=failure',
              s == 200 and r.get('alert') is True and lb.get('result') == 'failure', r)
    s, r = call(base, 'GET',
                "/api/collections/audit_logs/records?filter=(action='backup.failed')&perPage=1", token=st)
    rep.check('BKP-09 失败写审计（backup.failed 有记录）',
              s == 200 and len(r.get('items') or []) >= 1, r)
    s, r = call(base, 'GET',
                "/api/collections/audit_logs/records?filter=(action='backup.success')&perPage=1", token=st)
    rep.check('BKP-10 成功写审计（backup.success 有记录）',
              s == 200 and len(r.get('items') or []) >= 1, r)

    # ---------- 4. 恢复成功后备警解除 ----------
    call(base, 'POST', '/api/cc/super/backup/run', {}, st)
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    rep.check('BKP-11 再次成功后备警解除（alert=false）',
              s == 200 and r.get('alert') is False, r)
