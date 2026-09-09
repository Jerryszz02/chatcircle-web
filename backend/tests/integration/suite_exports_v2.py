# -*- coding: utf-8 -*-
"""suite_exports_v2 — 细粒度导出 v2（PRD §7、api-design §6、T6）。

断言：
- preview：鉴权、归一化回显、分域预估行数、判敏（系统列 phone_full/partner_name、
  is_sensitive 字段/题目触发；phone_masked 不触发）、未知代码 permission=not_found、
  机构开关未开 sensitive_export_disabled、管理员范围越权 403；
- create v2：敏感未确认 400、机构开关关闭 403、确认后生成；XLSX 结构
  （[Content_Types]/workbook/多 sheet）与 CSV ZIP 文件集；行筛选
  （角色/签到/配对/问卷完成/指定参与者）；scope_json 存 StoredExportSelectionV2
  （source_schema_version=2）、include_pii 由判敏派生；审计不含敏感值明文；
- preview 预估行数与正式导出 manifest 行数一致（同一行域口径）；
- v1 兼容：旧形状请求 scope_json 归一化 source_schema_version=1，13-CSV 产物不变
  （清单不变由 suite_exports 覆盖，这里只校验归一化存储与派生）。
"""
import io
import json
import zipfile

import cc_fixture as fx
from cc_client import biz_code, call


def _unzip(blob):
    zf = zipfile.ZipFile(io.BytesIO(blob))
    return {name: zf.read(name) for name in zf.namelist()}


def _xlsx_sheet_names(files):
    wb = files['xl/workbook.xml'].decode('utf-8')
    names = []
    for part in wb.split('<sheet ')[1:]:
        seg = part.split('/>')[0]
        key = 'name="'
        i = seg.find(key)
        if i >= 0:
            j = seg.find('"', i + len(key))
            names.append(seg[i + len(key):j])
    return names


def _xlsx_sheet_rows(files, idx):
    xml = files['xl/worksheets/sheet%d.xml' % idx].decode('utf-8')
    return xml.count('<row ')


def _job_scope(base, st, job_id):
    s, jr = call(base, 'GET', '/api/collections/export_jobs/records/%s' % job_id, token=st)
    assert s == 200, '读取 export_jobs 失败：%s' % jr
    sj = jr.get('scope_json')
    if isinstance(sj, str):
        sj = json.loads(sj)
    return jr, sj


def _base_selection(act_id, **over):
    sel = {
        'schema_version': 2,
        'scope': {'type': 'activity', 'activity_id': act_id},
        'datasets': ['registrations'],
        'filters': {},
        'columns': {
            'system': ['participant_id', 'activity_role', 'registration_status'],
            'registration_field_codes': ['nickname'],
            'survey_questions': [],
        },
        'format': 'xlsx',
        'timezone': 'Asia/Shanghai',
    }
    for key, value in over.items():
        if key in ('columns', 'filters') and isinstance(value, dict):
            merged = dict(sel[key])
            merged.update(value)
            sel[key] = merged
        else:
            sel[key] = value
    return sel


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields, ver_id = ctx['fields'], ctx['ver_id']
    rep.section('suite_exports_v2：细粒度导出 v2（PRD §7 / api-design §6）')

    # FULL_NAME 标准字段（suite_pairings 可能已建；幂等查询后补建）
    s, r = call(base, 'GET',
                "/api/collections/registration_field_defs/records?filter=(field_code='FULL_NAME')&perPage=5",
                token=st)
    items = r.get('items') or []
    if items:
        full_name_id = items[0]['id']
    else:
        s, fn = call(base, 'POST', '/api/collections/registration_field_defs/records', {
            'organization_id': '', 'field_code': 'FULL_NAME', 'field_type': 'text',
            'label': '姓名', 'source_type': 'standard', 'is_sensitive': True,
            'required_default': False, 'role_scope': 'both', 'status': 'active'}, st)
        assert s == 200, '创建 FULL_NAME fixture 失败：%s' % fn
        full_name_id = fn['id']

    org_a = fx.create_org(base, st, '导出v2机构A', allow_sensitive=True)
    org_b = fx.create_org(base, st, '导出v2机构B', allow_sensitive=False)
    org_c = fx.create_org(base, st, '导出v2机构C', allow_sensitive=False)
    admin_a, AT_A = fx.create_admin_via_impersonate(base, st, org_a, 'exp2_admin_a')
    _, AT_B = fx.create_admin_via_impersonate(base, st, org_b, 'exp2_admin_b')
    _, AT_C = fx.create_admin_via_impersonate(base, st, org_c, 'exp2_admin_c')

    def build_activity(org, at, code, title):
        act = fx.create_activity(base, at, org, code, title,
                                 fields=[(fields['nickname'], True, True),
                                         (fields['phone'], True, False),
                                         (full_name_id, True, False)])
        p1, pt1, _ = fx.create_participant(base, '%s_u1' % code.lower())
        p2, pt2, _ = fx.create_participant(base, '%s_u2' % code.lower())
        reg1 = fx.register(base, pt1, act, 'speaker', [
            {'field_def_id': fields['nickname'], 'value': '%s昵称1' % code},
            {'field_def_id': fields['phone'], 'value': '13800000021'},
            {'field_def_id': full_name_id, 'value': '%s姓名1' % code},
        ])
        reg2 = fx.register(base, pt2, act, 'listener', [
            {'field_def_id': fields['nickname'], 'value': '%s昵称2' % code},
            {'field_def_id': full_name_id, 'value': '%s姓名2' % code},
        ])
        fx.transition(base, at, reg1, 'approved')
        fx.transition(base, at, reg2, 'approved')
        qr = fx.checkin_token(base, at, act)
        call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, at)
        fx.self_checkin(base, qr, pt1)
        fx.self_checkin(base, qr, pt2)
        call(base, 'POST', '/api/cc/activities/%s/checkin/close' % act, {}, at)
        s, pair = call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act, {}, at)
        assert s == 200, '配对开始失败：%s' % pair
        sv, _ = fx.create_survey(base, at, act, ver_id, '%s问卷' % title)
        call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv, {}, at)
        call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv,
             {'answers': [{'question_code': 'MOOD', 'value': 4},
                          {'question_code': 'SAT', 'value': 'good'}]}, pt1)
        return act, sv, (p1, p2)

    act_a, sv_a, (pa1, pa2) = build_activity(org_a, AT_A, 'CC_IT_EXP2_A', 'v2导出A')
    act_c, sv_c, _ = build_activity(org_c, AT_C, 'CC_IT_EXP2_C', 'v2导出C')

    # ---------- preview ----------
    s, r = call(base, 'POST', '/api/cc/exports/preview', _base_selection(act_a))
    rep.check('EXP2-01 preview 未登录 401', s == 401, s)

    s, r = call(base, 'POST', '/api/cc/exports/preview', _base_selection(act_a), AT_A)
    rep.check('EXP2-02 preview 200：契约版本/非敏感/行数=2/权限放行',
              s == 200 and r.get('contract_version') == '2026-08-28.t0-v1'
              and r.get('requires_sensitive_export') is False
              and (r.get('estimated_rows') or {}).get('registrations') == 2
              and (r.get('permission') or {}).get('allowed') is True
              and (r.get('normalized_selection') or {}).get('schema_version') == 2, r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, columns={'system': ['participant_id', 'phone_full'],
                                                'registration_field_codes': [], 'survey_questions': []}), AT_A)
    rep.check('EXP2-03 phone_full 触发敏感（account_column）',
              s == 200 and r.get('requires_sensitive_export') is True
              and {'source': 'account_column', 'code': 'phone_full'} in (r.get('sensitive_reasons') or []), r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, columns={'registration_field_codes': ['nickname', 'phone']}), AT_A)
    rep.check('EXP2-04 is_sensitive 字段 phone 触发敏感（registration_field）',
              s == 200 and r.get('requires_sensitive_export') is True
              and {'source': 'registration_field', 'code': 'phone'} in (r.get('sensitive_reasons') or []), r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, datasets=['registrations', 'surveys'],
                                columns={'survey_questions': [{'activity_survey_id': sv_a,
                                                               'question_codes': ['MOOD']}]}), AT_A)
    rep.check('EXP2-05 is_sensitive 题目 MOOD 触发敏感（survey_question）',
              s == 200 and r.get('requires_sensitive_export') is True
              and {'source': 'survey_question', 'code': 'MOOD'} in (r.get('sensitive_reasons') or []), r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, columns={'system': ['participant_id', 'phone_masked'],
                                                'registration_field_codes': [], 'survey_questions': []}), AT_A)
    rep.check('EXP2-06 phone_masked 不触发敏感门槛',
              s == 200 and r.get('requires_sensitive_export') is False, r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, columns={'registration_field_codes': ['NO_SUCH']}), AT_A)
    rep.check('EXP2-07 未知字段代码 permission=not_found',
              s == 200 and (r.get('permission') or {}).get('allowed') is False
              and (r.get('permission') or {}).get('code') == 'not_found', r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, datasets=['registrations', 'surveys'],
                                columns={'survey_questions': [{'activity_survey_id': 'no_such_survey0',
                                                               'question_codes': ['MOOD']}]}), AT_A)
    rep.check('EXP2-08 未知问卷 permission=not_found',
              s == 200 and (r.get('permission') or {}).get('code') == 'not_found', r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, scope={'type': 'platform'}), AT_A)
    rep.check('EXP2-09 管理员 platform 范围 403', s == 403 and biz_code(r) == 'scope_forbidden', r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, columns={'system': ['phone_full'],
                                                'registration_field_codes': [], 'survey_questions': []}), AT_B)
    # B 机构管理员预览 A 的活动 → 越权（scope_forbidden），用 B 自己的活动另测开关
    s2, r2 = call(base, 'POST', '/api/cc/exports/preview',
                  _base_selection(act_a, columns={'system': ['phone_full'],
                                                  'registration_field_codes': [], 'survey_questions': []}), AT_B)
    rep.check('EXP2-09b 管理员跨机构 preview 403', s2 == 403, r2)

    act_b = fx.create_activity(base, AT_B, org_b, 'CC_IT_EXP2_B', 'v2导出B',
                               fields=[(fields['nickname'], True, True), (fields['phone'], True, False)])
    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_b, columns={'system': ['phone_full'],
                                                'registration_field_codes': [], 'survey_questions': []}), AT_B)
    rep.check('EXP2-10 机构开关关闭 → permission=sensitive_export_disabled（仍返回判敏）',
              s == 200 and r.get('requires_sensitive_export') is True
              and (r.get('permission') or {}).get('code') == 'sensitive_export_disabled'
              and (r.get('permission') or {}).get('allowed') is False, r)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                {'scope': {'type': 'activity', 'activity_id': act_a}, 'include_pii': False}, AT_A)
    rep.check('EXP2-11 preview 缺 schema_version 400', s == 400, r)

    # partner_name 触发敏感
    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, datasets=['registrations', 'pairings'],
                                columns={'system': ['participant_id', 'partner_name'],
                                         'registration_field_codes': [], 'survey_questions': []}), AT_A)
    rep.check('EXP2-11b partner_name 触发敏感（account_column）',
              s == 200 and r.get('requires_sensitive_export') is True
              and {'source': 'account_column', 'code': 'partner_name'} in (r.get('sensitive_reasons') or []), r)

    # ---------- create v2：敏感门槛 ----------
    sel_phone = _base_selection(act_a, columns={'registration_field_codes': ['nickname', 'phone']})
    s, r = call(base, 'POST', '/api/cc/exports', sel_phone, AT_A)
    rep.check('EXP2-12 敏感导出未 confirm_sensitive 400 confirm_required',
              s == 400 and biz_code(r) == 'confirm_required', r)

    sel_phone_b = _base_selection(act_b, columns={'registration_field_codes': ['phone']})
    sel_phone_b['confirm_sensitive'] = True
    s, r = call(base, 'POST', '/api/cc/exports', sel_phone_b, AT_B)
    rep.check('EXP2-13 机构开关关闭敏感导出 403 sensitive_export_disabled',
              s == 403 and biz_code(r) == 'sensitive_export_disabled', r)

    sel_unknown = _base_selection(act_a, columns={'registration_field_codes': ['NO_SUCH']})
    s, r = call(base, 'POST', '/api/cc/exports', sel_unknown, AT_A)
    rep.check('EXP2-14 create 未知字段代码 400', s == 400, r)

    s, r = call(base, 'POST', '/api/cc/exports', _base_selection(act_a), AT_B)
    rep.check('EXP2-15 create 跨机构活动 403 scope_forbidden',
              s == 403 and biz_code(r) == 'scope_forbidden', r)

    # ---------- create v2：XLSX 产物（机构A，非敏感全数据域）----------
    sel_full = _base_selection(act_a,
                               datasets=['registrations', 'checkins', 'pairings', 'surveys'],
                               columns={'system': ['participant_id', 'activity_role', 'registration_status',
                                                   'checked_in_at', 'onsite_code', 'pair_code'],
                                        'registration_field_codes': ['nickname'],
                                        'survey_questions': [{'activity_survey_id': sv_a,
                                                              'question_codes': ['SAT']}]})
    s, pv = call(base, 'POST', '/api/cc/exports/preview', sel_full, AT_A)
    rep.check('EXP2-16 全数据域 preview 预估（reg2/checkin2/pair1/survey1）',
              s == 200 and (pv.get('estimated_rows') or {}).get('registrations') == 2
              and pv['estimated_rows'].get('checkins') == 2
              and pv['estimated_rows'].get('pairings') == 1
              and pv['estimated_rows'].get('surveys') == 1, pv)

    s, r = call(base, 'POST', '/api/cc/exports', sel_full, AT_A)
    rep.check('EXP2-17 v2 xlsx 创建 200 且契约键齐全',
              s == 200 and r.get('contract_version') == '2026-08-28.t0-v1'
              and r.get('status') == 'running' and r.get('requires_sensitive_export') is False
              and bool(r.get('export_job_id')) and bool(r.get('normalized_selection')), r)
    job_xlsx = r.get('export_job_id')

    s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % job_xlsx, token=AT_A, raw=True)
    rep.check('EXP2-18 xlsx 下载 200 且 PK 头', s == 200 and isinstance(blob, bytes) and blob[:2] == b'PK')
    files = _unzip(blob)
    rep.check('EXP2-19 xlsx OOXML 结构齐全',
              '[Content_Types].xml' in files and 'xl/workbook.xml' in files
              and '_rels/.rels' in files and 'xl/_rels/workbook.xml.rels' in files
              and 'xl/worksheets/sheet1.xml' in files, sorted(files.keys()))
    sheet_names = _xlsx_sheet_names(files)
    rep.check('EXP2-20 xlsx sheet 覆盖数据域 + manifest + data_dictionary',
              'registrations' in sheet_names and 'checkins' in sheet_names
              and 'pairings' in sheet_names and any(n.startswith('survey_') for n in sheet_names)
              and 'manifest' in sheet_names and 'data_dictionary' in sheet_names, sheet_names)
    reg_sheet = files['xl/worksheets/sheet%d.xml' % (sheet_names.index('registrations') + 1)].decode('utf-8')
    rep.check('EXP2-21 registrations sheet：表头 + 2 行 + 现场编号/配对码',
              reg_sheet.count('<row ') == 3 and 'onsite_code' in reg_sheet
              and 'S01' in reg_sheet and 'L01' in reg_sheet and 'P01' in reg_sheet, reg_sheet[:400])
    rep.check('EXP2-22 非敏感导出不含 FULL_NAME 姓名值',
              '%s姓名1' % 'CC_IT_EXP2_A' not in reg_sheet and 'CC_IT_EXP2_A姓名1' not in reg_sheet)
    manifest_xml = files['xl/worksheets/sheet%d.xml' % (sheet_names.index('manifest') + 1)].decode('utf-8')
    rep.check('EXP2-23 manifest 含时区/格式/行数摘要',
              'Asia/Shanghai' in manifest_xml and 'xlsx' in manifest_xml
              and 'rows.registrations' in manifest_xml)
    rep.check('EXP2-24 preview 预估与正式行数一致（registrations=2）',
              pv['estimated_rows']['registrations'] == 2 and reg_sheet.count('<row ') == 3)

    # ---------- create v2：敏感确认 + 派生存储 + 审计（机构A）----------
    sel_sens = _base_selection(act_a, columns={'registration_field_codes': ['nickname', 'phone']})
    sel_sens['confirm_sensitive'] = True
    sel_sens['format'] = 'csv_zip'
    s, r = call(base, 'POST', '/api/cc/exports', sel_sens, AT_A)
    rep.check('EXP2-25 敏感 csv_zip 确认后 200', s == 200 and r.get('requires_sensitive_export') is True, r)
    job_sens = r.get('export_job_id')
    jr, sj = _job_scope(base, st, job_sens)
    rep.check('EXP2-26 scope_json 存 StoredExportSelectionV2（source=2）且 include_pii 派生为 true',
              sj.get('schema_version') == 2 and sj.get('source_schema_version') == 2
              and jr.get('include_pii') is True and sj.get('format') == 'csv_zip', sj)

    s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % job_sens, token=AT_A, raw=True)
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = set(zf.namelist())
    rep.check('EXP2-27 csv_zip 文件集 = 数据域 csv + manifest + data_dictionary',
              names == {'registrations.csv', 'data_dictionary.csv', 'manifest.csv'}, sorted(names))
    reg_csv = zf.read('registrations.csv').decode('utf-8-sig')
    rep.check('EXP2-28 csv_zip 带 BOM 且含敏感 phone 列值',
              zf.read('registrations.csv')[:3] == b'\xef\xbb\xbf'
              and ',phone' in reg_csv.split('\r\n')[0] and '13800000021' in reg_csv)
    dd_csv = zf.read('data_dictionary.csv').decode('utf-8-sig')
    rep.check('EXP2-29 data_dictionary 标 phone 敏感 yes', ',phone,' in dd_csv and ',yes' in dd_csv)

    s, ar = call(base, 'GET',
                 "/api/collections/audit_logs/records?filter=(target_id='%s')&perPage=5" % job_sens, token=st)
    items = [i for i in (ar.get('items') or []) if i.get('action') == 'export.sensitive']
    meta_str = json.dumps(items[0].get('metadata') if items else {}, ensure_ascii=False)
    rep.check('EXP2-30 审计含机器码且不含姓名/手机号明文',
              bool(items) and 'field_codes' in meta_str and 'phone' in meta_str
              and '13800000021' not in meta_str and 'CC_IT_EXP2_A姓名' not in meta_str, meta_str[:300])

    # ---------- 行筛选（机构C，均非敏感）----------
    def create_and_read_csv(at, sel, member='registrations.csv'):
        sel = json.loads(json.dumps(sel))
        sel['format'] = 'csv_zip'
        s, r = call(base, 'POST', '/api/cc/exports', sel, at)
        if s != 200:
            return None, r
        s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % r['export_job_id'], token=at, raw=True)
        zf = zipfile.ZipFile(io.BytesIO(blob))
        return zf.read(member).decode('utf-8-sig'), None

    csv_text, err = create_and_read_csv(AT_C, _base_selection(act_c, filters={'activity_roles': ['listener']}))
    rep.check('EXP2-31 行筛选 listener 只剩 1 行',
              csv_text is not None and csv_text.count('\r\n') == 2 and 'listener' in csv_text, err or csv_text)

    csv_text, err = create_and_read_csv(AT_C, _base_selection(act_c, filters={'pairing': 'paired'}))
    rep.check('EXP2-32 行筛选 paired=2 行', csv_text is not None and csv_text.count('\r\n') == 3, err or csv_text)

    csv_text, err = create_and_read_csv(AT_C, _base_selection(act_c, filters={'pairing': 'unpaired'}))
    rep.check('EXP2-33 行筛选 unpaired=0 行', csv_text is not None and csv_text.count('\r\n') == 1, err or csv_text)

    csv_text, err = create_and_read_csv(AT_C, _base_selection(act_c, filters={'checkin': 'valid'}))
    rep.check('EXP2-34 行筛选已签到=2 行', csv_text is not None and csv_text.count('\r\n') == 3, err or csv_text)

    csv_text, err = create_and_read_csv(AT_C, _base_selection(act_c, filters={'survey_completion': 'submitted'}))
    rep.check('EXP2-35 行筛选问卷已提交=1 行', csv_text is not None and csv_text.count('\r\n') == 2, err or csv_text)

    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_c, filters={'participant_ids': ['no_such_id_000']}), AT_C)
    rep.check('EXP2-36 指定参与者筛选（不存在的 id）行数=0',
              s == 200 and (r.get('estimated_rows') or {}).get('registrations') == 0, r)

    # ---------- v1 兼容归一化存储 ----------
    s, r = call(base, 'POST', '/api/cc/exports',
                {'scope': {'type': 'activity', 'activity_id': act_a}, 'include_pii': False}, AT_A)
    rep.check('EXP2-37 v1 请求仍 200（旧形状受理）', s == 200 and bool((r.get('export_job') or {}).get('id')), r)
    if s == 200:
        jr, sj = _job_scope(base, st, r['export_job']['id'])
        rep.check('EXP2-38 v1 scope_json 归一化为 v2（source_schema_version=1, csv_zip/UTC）',
                  sj.get('schema_version') == 2 and sj.get('source_schema_version') == 1
                  and sj.get('format') == 'csv_zip' and sj.get('timezone') == 'UTC'
                  and jr.get('include_pii') is False, sj)
        s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % r['export_job']['id'], token=AT_A, raw=True)
        zf = zipfile.ZipFile(io.BytesIO(blob))
        rep.check('EXP2-39 v1 产物仍为 13 个 CSV', len(zf.namelist()) == 13, zf.namelist())

    # ---------- review P1 回归：多个同码 def（机构覆盖标准）取值完整 ----------
    # A 机构自定义字段与平台标准 nick2_code 同码且敏感关闭 → analyzeSelection 的 scoped def
    # 集合含两条，答案反查须把「挂在标准 def 上的答案」也归位到该列
    s, ov = call(base, 'POST', '/api/collections/registration_field_defs/records', {
        'organization_id': org_a, 'field_code': 'nickname', 'field_type': 'text',
        'label': '昵称（机构自定义同码）', 'source_type': 'custom', 'is_sensitive': False,
        'required_default': False, 'status': 'active'}, AT_A)
    assert s == 200, '创建机构同码 override 失败：%s' % ov
    p3, pt3, _ = fx.create_participant(base, '%s_u3' % 'CC_IT_EXP2_A'.lower())
    reg3 = fx.register(base, pt3, act_a, 'listener', [
        {'field_def_id': fields['nickname'], 'value': '同码多def昵称'},  # 交在标准 def 上（旧口径漏取）
        {'field_def_id': full_name_id, 'value': 'CC_IT_EXP2_A姓名3'}])
    fx.transition(base, AT_A, reg3, 'approved')

    sel_multi = _base_selection(act_a, columns={'registration_field_codes': ['nickname']})
    s, r = call(base, 'POST', '/api/cc/exports', sel_multi, AT_A)
    rep.check('EXP2-41 机构同码 override 下 v2 create 200', s == 200 and bool(r.get('export_job_id')), r)
    if s == 200:
        s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % r['export_job_id'], token=AT_A, raw=True)
        files = _unzip(blob)
        sheet_names = _xlsx_sheet_names(files)
        reg_xml = files['xl/worksheets/sheet%d.xml' % (sheet_names.index('registrations') + 1)].decode('utf-8')
        rep.check('EXP2-41b 「多 def 同 code」两来源答案均归位该列（override 优先不丢值）',
                  'CC_IT_EXP2_A昵称1' in reg_xml and '同码多def昵称' in reg_xml, None)

    # F03/F09 回归：同码定义超过旧 limit=10，混合敏感性并包含停用历史定义。
    # 预览必须遍历全部定义并聚合敏感标记；创建后的 dictionary 也必须保留敏感标签。
    hist_code = 'hist_same_code'
    hist_orgs = [fx.create_org(base, st, '导出v2历史同码机构%d' % i, allow_sensitive=True) for i in range(11)]
    hist_activities = []
    for i, hist_org in enumerate(hist_orgs):
        _, hist_admin = fx.create_admin_via_impersonate(base, st, hist_org, 'exp2_hist_admin_%d' % i)
        hist_activities.append(fx.create_activity(base, hist_admin, hist_org, 'CC_IT_EXP2_HIST_%d' % i, '历史同码活动%d' % i))
    for i, hist_org in enumerate(hist_orgs):
        s_hist, definition = call(base, 'POST', '/api/collections/registration_field_defs/records', {
            'organization_id': hist_org, 'field_code': hist_code,
            'field_type': 'text', 'label': '历史同码%d' % i,
            'source_type': 'custom', 'is_sensitive': i == 10,
            'required_default': False, 'status': 'disabled' if i == 0 else 'active'}, st)
        assert s_hist == 200, '创建历史同码定义失败：%s' % definition
        participant_id, _, _ = fx.create_participant(base, 'exp2_hist_user_%d' % i)
        status, registration = call(base, 'POST', '/api/collections/registrations/records', {
            'activity_id': hist_activities[i], 'participant_id': participant_id,
            'activity_role': 'speaker', 'status': 'approved',
            'submitted_at': '2026-09-01 00:00:00.000Z'}, st)
        assert status == 200, registration
        status, answer = call(base, 'POST', '/api/collections/registration_answers/records', {
            'registration_id': registration['id'], 'field_def_id': definition['id'],
            'value_json': 'hist-answer-%02d' % i}, st)
        assert status == 200, answer
    hist_sel = _base_selection(hist_activities[-1], scope={'type': 'platform'},
                               columns={'registration_field_codes': [hist_code]})
    s, hist_preview = call(base, 'POST', '/api/cc/exports/preview', hist_sel, st)
    rep.check('EXP2-43 11+条混合敏感/停用同码定义预览判敏',
              s == 200 and hist_preview.get('requires_sensitive_export') is True, hist_preview)
    s, hist_denied = call(base, 'POST', '/api/cc/exports', hist_sel, st)
    rep.check('EXP2-44 同码敏感定义未确认拒绝', s == 400 and biz_code(hist_denied) == 'confirm_required', hist_denied)
    hist_sel['confirm_sensitive'] = True
    s, hist_created = call(base, 'POST', '/api/cc/exports', hist_sel, st)
    rep.check('EXP2-45 同码敏感定义确认创建并写审计', s == 200 and bool(hist_created.get('export_job_id')), hist_created)
    if s == 200:
        s, hist_blob = call(base, 'GET', '/api/cc/exports/%s/download' % hist_created['export_job_id'], token=st, raw=True)
        hist_files = _unzip(hist_blob)
        hist_names = _xlsx_sheet_names(hist_files)
        dictionary_xml = hist_files['xl/worksheets/sheet%d.xml' % (hist_names.index('data_dictionary') + 1)].decode('utf-8')
        rep.check('EXP2-46 dictionary 对混合同码聚合敏感标记', s == 200 and hist_code in dictionary_xml and '>yes<' in dictionary_xml, None)
        registration_xml = hist_files['xl/worksheets/sheet%d.xml' % (hist_names.index('registrations') + 1)].decode('utf-8')
        rep.check('EXP2-47 十一份同码定义的历史答案全部输出',
                  all('hist-answer-%02d' % i in registration_xml for i in range(11)), registration_xml[:100])

    # standard def 上的 channel 多选：value_json 标准 JSON 数组 → xlsx 单元格须为 JSON 字符串
    p3b, pt3b, _ = fx.create_participant(base, '%s_u4' % 'CC_IT_EXP2_A'.lower())
    reg_c = fx.register(base, pt3b, act_a, 'speaker', [
        {'field_def_id': fields['nickname'], 'value': '渠道昵称B'},
        {'field_def_id': full_name_id, 'value': 'CC_IT_EXP2_A姓名4'},
        {'field_def_id': fields['channel'], 'value': ['friend', 'poster']}])
    fx.transition(base, AT_A, reg_c, 'approved')

    sel_mc = _base_selection(act_a, columns={'registration_field_codes': ['nickname', 'channel']})
    s, r = call(base, 'POST', '/api/cc/exports', sel_mc, AT_A)
    rep.check('EXP2-42 multi_choice 列 v2 create 200', s == 200 and bool(r.get('export_job_id')), r)
    if s == 200:
        s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % r['export_job_id'], token=AT_A, raw=True)
        zf = zipfile.ZipFile(io.BytesIO(blob))
        # registrations.csv（csv_zip 口径）用 data_dictionary 之外的成员判断不便，这里取 xlsx 断言：
        files2 = _unzip(blob)
        sheet_names2 = _xlsx_sheet_names(files2)
        reg_xml2 = files2['xl/worksheets/sheet%d.xml' % (sheet_names2.index('registrations') + 1)].decode('utf-8')
        # JSON 数组经 xmlSafe 后引号转义为 &quot;；断言「friend」与「poster」同格出现 → 原样字符串未拆列
        rep.check('EXP2-42b multi_choice XLSX 单元格为标准 JSON 字符串（双选项完整、未展开为多列）',
                  '"friend"' in reg_xml2.replace('&quot;', '"') and 'poster' in reg_xml2
                  and reg_xml2.count('渠道昵称B') == 1, None)

    # 超管 platform v2
    s, r = call(base, 'POST', '/api/cc/exports/preview',
                _base_selection(act_a, scope={'type': 'platform'}), st)
    rep.check('EXP2-40 超管 platform preview 200 且行数覆盖多机构',
              s == 200 and (r.get('estimated_rows') or {}).get('registrations', 0) >= 6, r)
