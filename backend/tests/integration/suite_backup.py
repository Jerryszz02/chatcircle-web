# -*- coding: utf-8 -*-
"""suite_backup — 备份告警（AC-23、PRD §12.3、security-privacy §11）。

安全加固后契约（2026-08）：
- POST /api/cc/super/backup/run 已下线（410 backup_deprecated，不再写 backup.* 审计）：
  原 JSVM「库文件复制」并非一致性快照（假备份）；每日一致性快照由 deploy/backup.sh
  （PocketBase 备份 API，SQLite 在线备份）自动执行。
- GET /api/cc/super/backup-status 保留：聚合最近一条 backup.success/backup.failed 审计，
  驱动超管后台告警；无任何记录时 alert=true（引导运维核查备份链路接入）。
- 断言以超管直插 audit_logs 模拟备份结果上报（backup.sh 结果接入审计后的写入口径，
  见 deploy/backup.sh 头注释）；直插对超管放行（规则豁免），不影响 NDEL 套件结论。
"""
import time

import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_backup：备份告警（AC-23）')

    org = fx.create_org(base, st, '备份机构')
    _, AT = fx.create_admin(base, st, org, 'bkp_admin')
    _, PT, _ = fx.create_participant(base, 'bkp_user')

    def seed_backup_audit(action, result, file_name='', reason=''):
        """超管直插 backup.* 审计（模拟每日备份结果上报），返回断言用响应。"""
        s2, r2 = call(base, 'POST', '/api/collections/audit_logs/records',
                      {'actor_id': 'system', 'actor_role': 'system', 'organization_id': '',
                       'action': action, 'target_type': 'backup', 'target_id': 'daily',
                       'result': result, 'reason': reason,
                       'metadata': {'file': file_name} if file_name else None}, st)
        assert s2 == 200, '播种备份审计失败：%s' % r2
        # created 精度为毫秒；拉开时距保证 backup-status「最近一条」排序确定
        time.sleep(1.05)

    # ---------- 1. 访问控制 ----------
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=AT)
    rep.check('BKP-01 机构管理员读备份状态 → 403', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=PT)
    rep.check('BKP-02 参与者读备份状态 → 403', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/super/backup-status')
    rep.check('BKP-03 未认证读备份状态 → 401', s == 401, r)
    s, r = call(base, 'POST', '/api/cc/super/backup/run', {}, AT)
    rep.check('BKP-04 机构管理员触发备份 → 403', s in (401, 403), r)

    # ---------- 2. backup/run 已下线（410，不再写审计）----------
    s, r = call(base, 'POST', '/api/cc/super/backup/run', {}, st)
    rep.check('BKP-05 超管触发 backup/run → 410 backup_deprecated',
              s == 410 and biz_code(r) == 'backup_deprecated', r)
    s, r = call(base, 'GET',
                "/api/collections/audit_logs/records?filter=(action='backup.success'||action='backup.failed')",
                token=st)
    rep.check('BKP-06 backup/run 不再写 backup.* 审计', s == 200 and r.get('totalItems') == 0, r)

    # ---------- 3. 无备份记录 → 告警；播种成功记录 → 解除 ----------
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    rep.check('BKP-07 尚无备份记录 → last_backup=null 且 alert=true',
              s == 200 and r.get('last_backup') is None and r.get('alert') is True
              and bool(r.get('message')), r)
    seed_backup_audit('backup.success', 'success', file_name='cc_daily_20260809_030000.zip')
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    lb = r.get('last_backup') or {}
    rep.check('BKP-08 成功记录：result=success 且 alert=false（含文件名与时间）',
              s == 200 and lb.get('result') == 'success' and r.get('alert') is False
              and bool(lb.get('file')) and bool(lb.get('created')), r)

    # ---------- 4. 最近失败 → 告警；再次成功 → 解除 ----------
    seed_backup_audit('backup.failed', 'failure', reason='磁盘空间不足')
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    lb = r.get('last_backup') or {}
    rep.check('BKP-09 最近失败 → alert=true 且 result=failure',
              s == 200 and r.get('alert') is True and lb.get('result') == 'failure', r)
    seed_backup_audit('backup.success', 'success', file_name='cc_daily_20260810_030000.zip')
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    rep.check('BKP-10 再次成功后备警解除（alert=false）', s == 200 and r.get('alert') is False, r)
