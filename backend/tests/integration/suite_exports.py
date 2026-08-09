# -*- coding: utf-8 -*-
"""suite_exports — 规范化导出与敏感导出（AC-16/AC-17、FR-EXP-001~005、PRD §10）。

断言：
- 普通导出 ZIP：13 个 CSV 清单齐全（含 manifest.csv / data_dictionary.csv）、
  全部 UTF-8 BOM、行数与 manifest 一致、无合并宽表；
- 敏感过滤按 is_sensitive 标记（不依赖字段名）：普通导出不含敏感报名字段答案、
  不含敏感题答案、不含用户名；data_dictionary 含敏感标记；
- 作废答卷不计入导出口径；
- 敏感导出：未二次确认拒绝；机构开关关闭拒绝；开启 + confirm 后生成且写审计；
  超级管理员不受机构开关限制。
"""
import csv
import io
import zipfile

import cc_fixture as fx
from cc_client import biz_code, call

EXPECTED_FILES = {
    'organizations.csv', 'activities.csv', 'participants.csv', 'registrations.csv',
    'registration_answers.csv', 'checkins.csv', 'survey_templates.csv', 'surveys.csv',
    'submissions.csv', 'answers.csv', 'custom_fields.csv', 'data_dictionary.csv',
    'manifest.csv',
}


def _unzip(blob):
    zf = zipfile.ZipFile(io.BytesIO(blob))
    out = {}
    for name in zf.namelist():
        raw = zf.read(name)
        out[name] = (raw, list(csv.reader(io.StringIO(raw.decode('utf-8-sig')))))
    return out


def _kv(rows):
    """manifest.csv 的 key/value 行转字典。"""
    return {r[0]: r[1] for r in rows[1:] if len(r) >= 2}


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields, ver_id = ctx['fields'], ctx['ver_id']
    rep.section('suite_exports：导出敏感过滤与开关（AC-16/17）')

    org_a = fx.create_org(base, st, '导出机构A', allow_sensitive=True)
    org_b = fx.create_org(base, st, '导出机构B', allow_sensitive=False)
    admin_a, AT_A = fx.create_admin(base, st, org_a, 'exp_admin_a')
    _, AT_B = fx.create_admin(base, st, org_b, 'exp_admin_b')

    act = fx.create_activity(base, AT_A, org_a, 'CC_IT_EXP_01', '导出校验场',
                             fields=[(fields['nickname'], True, True),
                                     (fields['phone'], True, False)])
    P1, PT1, _ = fx.create_participant(base, 'expuser01')
    _, PT2, _ = fx.create_participant(base, 'expuser02')
    reg1 = fx.register(base, PT1, act, 'speaker',
                       fx.field_answers(fields, '导出甲', phone='13800000000'))
    fx.register(base, PT2, act, 'listener', fx.field_answers(fields, '导出乙'))
    fx.transition(base, AT_A, reg1, 'approved')
    # 第二人报名已通过（通过 admin 查询得到 id）
    s, rr = call(base, 'GET',
                 f"/api/collections/registrations/records?perPage=10&filter=(activity_id='{act}'%26%26status='pending')",
                 token=AT_A)
    reg2 = (rr.get('items') or [{}])[0].get('id')
    fx.transition(base, AT_A, reg2, 'approved')

    sv, qr = fx.create_survey(base, AT_A, act, ver_id, '导出问卷')
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv, {}, AT_A)
    full1 = [{'question_code': 'MOOD', 'value': 4}, {'question_code': 'SAT', 'value': 'good'},
             {'question_code': 'NOTE', 'value': '普通答案文本'}]
    s, sub1 = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv, {'answers': full1}, PT1)
    full2 = [{'question_code': 'MOOD', 'value': 2}, {'question_code': 'SAT', 'value': 'ok'}]
    s, sub2 = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv, {'answers': full2}, PT2)
    sub2_id = (sub2.get('submission') or {}).get('id')
    # 作废 p2 答卷：导出口径应排除（database-design §5.2.16）
    call(base, 'POST', '/api/cc/submissions/%s/void' % sub2_id, {'reason': '导出排除验证'}, AT_A)
    # p1 签到一次
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, AT_A)
    fx.self_checkin(base, fx.checkin_token(base, AT_A, act), PT1)
    call(base, 'POST', '/api/cc/activities/%s/checkin/close' % act, {}, AT_A)

    # ---------- 1. 普通导出内容（AC-16）----------
    s, exp = call(base, 'POST', '/api/cc/exports',
                  {'scope': {'type': 'organization'}, 'include_pii': False}, AT_A)
    job = (exp.get('export_job') or {}).get('id')
    rep.check('EXP-01 普通导出任务创建成功（含校验信息）',
              s == 200 and bool(job) and bool((exp.get('export_job') or {}).get('file_checksum')),
              exp if s != 200 else '')
    s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % job, token=AT_A, raw=True)
    rep.check('EXP-02 ZIP 下载 200 且 PK 头', s == 200 and isinstance(blob, bytes) and blob[:2] == b'PK')
    if not (s == 200 and isinstance(blob, bytes)):
        return
    files = _unzip(blob)

    rep.check('EXP-03 ZIP 文件清单 = PRD §10.1 规定的 13 个 CSV',
              set(files.keys()) == EXPECTED_FILES, sorted(files.keys()))
    rep.check('EXP-04 全部 CSV 带 UTF-8 BOM',
              all(raw[:3] == b'\xef\xbb\xbf' for raw, _ in files.values()))

    manifest = _kv(files['manifest.csv'][1])
    rep.check('EXP-05 manifest：include_pii=false 且标注敏感过滤口径',
              manifest.get('include_pii') == 'false'
              and manifest.get('sensitive_filter') == 'is_sensitive excluded', manifest)
    rep.check('EXP-06 manifest 行数与实际一致（registrations=2 / submissions=1）',
              manifest.get('file_rows.registrations.csv') == '2'
              and manifest.get('file_rows.submissions.csv') == '1'
              and len(files['registrations.csv'][1]) - 1 == 2
              and len(files['submissions.csv'][1]) - 1 == 1,
              {k: v for k, v in manifest.items() if k.startswith('file_rows')})

    ra = files['registration_answers.csv'][1]
    ra_codes = sorted(r[1] for r in ra[1:] if len(r) > 1)
    rep.check('EXP-07 registration_answers 按 is_sensitive 排除 phone（仅 nickname 两行）',
              ra_codes == ['nickname', 'nickname'], ra)
    rep.check('EXP-08 registration_answers 普通导出敏感标记列恒为 no',
              all(len(r) > 4 and r[4] == 'no' for r in ra[1:]), ra)

    ans = files['answers.csv'][1]
    ans_codes = sorted(r[1] for r in ans[1:] if len(r) > 1)
    rep.check('EXP-09 answers 按 is_sensitive 排除 MOOD 题（仅 NOTE/SAT）',
              ans_codes == ['NOTE', 'SAT'], ans)

    parts = files['participants.csv'][1]
    parts_text = files['participants.csv'][0].decode('utf-8-sig')
    rep.check('EXP-10 participants.csv 无 username 列且全文不含用户名',
              parts[0] == ['participant_id', 'status', 'created']
              and 'expuser' not in parts_text, parts[0])

    subs = files['submissions.csv'][1]
    rep.check('EXP-11 作废答卷被导出排除（submissions 仅 p1 一行）',
              len(subs) - 1 == 1 and subs[1][0] == (sub1.get('submission') or {}).get('id'), subs)

    dd = files['data_dictionary.csv'][1]
    dd_rows = {(r[0], r[1]): r[3] for r in dd[1:] if len(r) > 3}
    rep.check('EXP-12 data_dictionary 含字段/题目敏感标记（field:phone=yes, question:MOOD=yes）',
              dd_rows.get(('registration_answers.csv', 'field:phone')) == 'yes'
              and dd_rows.get(('answers.csv', 'question:MOOD')) == 'yes'
              and dd_rows.get(('answers.csv', 'question:SAT')) == 'no', dd_rows)

    acts = files['activities.csv'][1]
    rep.check('EXP-13 导出范围仅本机构（activities 一行且属机构A）',
              len(acts) - 1 == 1 and acts[1][1] == org_a, acts)

    # ---------- 2. 敏感导出（AC-17）----------
    s, r = call(base, 'POST', '/api/cc/exports',
                {'scope': {'type': 'organization'}, 'include_pii': True}, AT_A)
    rep.check('EXP-14 敏感导出未二次确认 → 400 confirm_required',
              s == 400 and biz_code(r) == 'confirm_required', r)
    s, r = call(base, 'POST', '/api/cc/exports',
                {'scope': {'type': 'organization'}, 'include_pii': True, 'confirm': True}, AT_B)
    rep.check('EXP-15 机构开关关闭时敏感导出 → 403 sensitive_export_disabled',
              s == 403 and biz_code(r) == 'sensitive_export_disabled', r)

    s, exp2 = call(base, 'POST', '/api/cc/exports',
                   {'scope': {'type': 'organization'}, 'include_pii': True, 'confirm': True}, AT_A)
    job2 = (exp2.get('export_job') or {}).get('id')
    rep.check('EXP-16 开关开启 + 二次确认 → 敏感导出成功', s == 200 and bool(job2),
              exp2 if s != 200 else '')
    s, blob2 = call(base, 'GET', '/api/cc/exports/%s/download' % job2, token=AT_A, raw=True)
    if s == 200 and isinstance(blob2, bytes):
        files2 = _unzip(blob2)
        ans2_codes = sorted(r2[1] for r2 in files2['answers.csv'][1][1:] if len(r2) > 1)
        parts2 = files2['participants.csv'][1]
        ra2 = files2['registration_answers.csv'][1]
        ra2_codes = sorted(r2[1] for r2 in ra2[1:] if len(r2) > 1)
        rep.check('EXP-17 敏感导出含敏感题答案与敏感字段（answers 含 MOOD，报名答案含 phone）',
                  'MOOD' in ans2_codes and 'phone' in ra2_codes,
                  {'answers': ans2_codes, 'reg_answers': ra2_codes})
        rep.check('EXP-18 敏感导出 participants.csv 含 username 列',
                  parts2[0] == ['participant_id', 'status', 'created', 'username']
                  and 'expuser01' in files2['participants.csv'][0].decode('utf-8-sig'), parts2[0])
    else:
        rep.check('EXP-17 敏感导出含敏感题答案与敏感字段', False, 'status=%s' % s)
        rep.check('EXP-18 敏感导出 participants.csv 含 username 列', False, 'status=%s' % s)

    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='export.sensitive'%26%26actor_id='{admin_a}')",
                token=st)
    rep.check('EXP-19 敏感导出写审计（export.sensitive）',
              s == 200 and len(r.get('items') or []) == 1, r)
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='export.normal'%26%26actor_id='{admin_a}')",
                token=st)
    rep.check('EXP-20 普通导出写审计（export.normal）',
              s == 200 and len(r.get('items') or []) == 1, r)

    # ---------- 3. 超管不受机构开关限制 ----------
    s, r = call(base, 'POST', '/api/cc/exports',
                {'scope': {'type': 'organization', 'organization_id': org_b},
                 'include_pii': True, 'confirm': True}, st)
    rep.check('EXP-21 超管对开关关闭机构敏感导出不受限 → 200', s == 200, r)

    # ---------- 4. 参与者不可导出 ----------
    s, r = call(base, 'POST', '/api/cc/exports', {'scope': {'type': 'organization'}}, PT1)
    rep.check('EXP-22 参与者创建导出 → 401', s in (401, 403), r)
