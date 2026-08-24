#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""import_historical_20260612.py — 2026-06-12 凯德专场历史活动数据一次性导入。

背景：该活动（培训 2026-06-09 / 活动 2026-06-12）举办时系统尚未上线，现有
Excel 存档需补录入库。脚本经 superuser REST API 直接建记录（参与者侧 hook 对
superuser 豁免，见 submissions.pb.js / surveys.pb.js 守卫注释），不模拟 UI 全流程。

数据源（均在 测试数据/ 下，不进 git）：
- 倾听者最终报名表 xlsx（40 人，含姓名/邮箱/部门等）
- extracted_20260612/ 下 8 份问卷 xlsx（1A/1B/1C/1D/2A/2B/2D/问卷3）

导入内容：机构「凯德管理（上海）有限公司」+ 管理员 kaide_admin、16+1 个机构自定义
报名字段、活动 CC20260612KD（closed）、54+ 个参与者账号（密码随机，写本地 CSV）、
报名记录（到场倾听者与 Chatter 为 approved，未到场倾听者与机构方占位为 cancelled，含报名表答案）、8 个问卷模板 + 8 个活动问卷（ended）、
全部 submissions/answers。幂等：全部按唯一键先查后建，可安全重跑。

用法：
    # 干跑（只解析 + 打印计划，不写库；给了凭据则额外做只读预检）
    python3 backend/scripts/import_historical_20260612.py --dry-run
    # 正式执行
    PB_BASE_URL=https://chatcircle.empact.cn:8443 \
    PB_SUPER_EMAIL=admin@example.com PB_SUPER_PASSWORD=xxx \
    python3 backend/scripts/import_historical_20260612.py
"""
import argparse
import csv
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

CST = timedelta(hours=8)  # 源数据时间为北京时间

ORG_NAME = '凯德管理（上海）有限公司'
ADMIN_USERNAME = 'kaide_admin'
ACTIVITY_CODE = 'CC20260612KD'

# ---------------------------------------------------------------------------
# 最小 xlsx 读取（纯标准库；只取第一个工作表）
# ---------------------------------------------------------------------------
_M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
_R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
_PR = '{http://schemas.openxmlformats.org/package/2006/relationships}'


def xlsx_rows(path):
    import posixpath
    z = zipfile.ZipFile(path)
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    shared = []
    try:
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si', ns):
            shared.append(''.join(t.text or '' for t in si.iter(_M + 't')))
    except KeyError:
        pass
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    relmap = {r.get('Id'): r.get('Target') for r in rels.iter(_PR + 'Relationship')}
    target = None
    for s in wb.iter(_M + 'sheet'):
        target = relmap[s.get(_R + 'id')]
        break
    if target is None:
        raise ValueError('%s：没有工作表' % path)
    sheet_path = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
    sheet = ET.fromstring(z.read(sheet_path))
    rows = []
    for row in sheet.iter(_M + 'row'):
        vals, maxcol = {}, 0
        for c in row.findall('m:c', ns):
            ref = c.get('r')
            col = 0
            for ch in ref:
                if ch.isalpha():
                    col = col * 26 + ord(ch) - 64
                else:
                    break
            maxcol = max(maxcol, col)
            t = c.get('t')
            v = c.find('m:v', ns)
            isv = c.find('m:is', ns)
            if v is not None:
                vals[col] = shared[int(v.text)] if t == 's' else v.text
            elif isv is not None:
                vals[col] = ''.join(t.text or '' for t in isv.iter(_M + 't'))
            else:
                vals[col] = ''
        rows.append([vals.get(i, '') for i in range(1, maxcol + 1)])
    return rows


# ---------------------------------------------------------------------------
# HTTP（与 seed_demo.py 同形态）
# ---------------------------------------------------------------------------
# 显式禁用代理：macOS 下 urllib 默认读取系统代理（getproxies 走 _scproxy），
# 本机代理可能拦截/拒绝 127.0.0.1 与服务器 IP 的请求（表现为 502/连接失败），
# 脚本与目标服务器之间一律直连。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 运行期上下文（base/token/org/activity id）：导入中途异常退出时尽力补写失败审计
_RUN_CTX = {}


def write_import_audit(result, reason, metadata=None):
    """写 import.historical 审计；未认证或写失败时静默跳过（不掩盖原始异常）。"""
    base = _RUN_CTX.get('base')
    token = _RUN_CTX.get('token')
    if not base or not token:
        return
    body = {'actor_id': _RUN_CTX.get('su_id', ''), 'actor_role': 'system',
            'organization_id': _RUN_CTX.get('org_id', ''),
            'action': 'import.historical', 'target_type': 'activity',
            'target_id': _RUN_CTX.get('act_id', ''), 'result': result,
            'reason': reason, 'metadata': metadata}
    try:
        call(base, 'POST', '/api/collections/audit_logs/records', body, token)
    except Exception:
        pass


def call(base, method, path, body=None, token=None):
    req = urllib.request.Request(base + path, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with _OPENER.open(req, data, timeout=60) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


def must(base, method, path, body=None, token=None, what=''):
    s, r = call(base, method, path, body, token)
    if s not in (200, 201, 204):
        raise RuntimeError('%s 失败（HTTP %s）：%s' % (what or path, s, json.dumps(r, ensure_ascii=False)[:400]))
    return r


def get_one(base, collection, filt, token):
    q = urllib.parse.quote(filt)
    _, r = call(base, 'GET', '/api/collections/%s/records?filter=(%s)&perPage=1' % (collection, q), token=token)
    items = r.get('items') or []
    return items[0] if items else None


def count_of(base, collection, filt, token):
    q = urllib.parse.quote(filt)
    _, r = call(base, 'GET', '/api/collections/%s/records?filter=(%s)&perPage=1' % (collection, q), token=token)
    return r.get('totalItems', 0)


def list_all(base, collection, filt, token):
    q = urllib.parse.quote(filt)
    _, r = call(base, 'GET', '/api/collections/%s/records?filter=(%s)&perPage=500' % (collection, q), token=token)
    return r.get('items') or []


# ---------------------------------------------------------------------------
# 数据值解析
# ---------------------------------------------------------------------------
def parse_scale(v):
    """'4.相当多' / '10' / '7' → int；无法解析返回 None。"""
    m = re.match(r'^\s*(\d{1,2})', str(v))
    return int(m.group(1)) if m else None


def parse_multi(v):
    """按 ', ' 拆分多选；空返回 []。"""
    s = str(v).strip()
    if not s:
        return []
    return [x.strip() for x in s.split(', ') if x.strip()]


def to_cst(v):
    """'2026-06-12 13:55'（北京时间）→ '2026-06-12 05:55:00.000Z'。
    兼容 Excel 序列日期（如 '46183.733'：1899-12-30 起的天数）。"""
    s = str(v).strip()
    if re.match(r'^\d+(\.\d+)?$', s):
        dt = datetime(1899, 12, 30) + timedelta(days=float(s))
    else:
        dt = datetime.strptime(s, '%Y-%m-%d %H:%M')
    return (dt - CST).strftime('%Y-%m-%d %H:%M:%S.000Z')


def cell(row, idx):
    return str(row[idx]).strip() if idx < len(row) else ''


# ---------------------------------------------------------------------------
# 问卷规格：col 为 xlsx 列下标；choice 题选项从数据 distinct 收集
# ---------------------------------------------------------------------------
C_TITLES = [
    '我感到自信能够与一位陌生人进行一次支持性对话。',
    '我感到自己能够在不给建议、不转移话题的情况下倾听。',
    '我感到自信能够识别并点名他人分享中的个人优势。',
    '我感到准备好识别何时某人可能需要进一步支持，以及如何妥善回应。',
]
P_TITLES = [
    '此刻，我对周围的事物感到感兴趣。', '此刻，我感到兴奋。', '此刻，我感到强健有力。',
    '此刻，我感到热情高涨。', '此刻，我感到自豪。',
]
H_TITLES = [
    '我感到自己有能力应对前方的挑战。', '我感到在面对挑战时有自信。', '我能看到自己前进的方向。',
]


def q(code, qtype, title, col, required=True):
    return {'code': code, 'type': qtype, 'title': title, 'col': col, 'required': required}


SURVEYS = [
    {
        'prefix': '1A-', 'sig': (3, '请创建您的个人问卷ID'),
        'template_code': 'HIST_1A_CHATTER_PRE_V1', 'template_name': '参与者前测问卷（历史导入）',
        'survey_title': '1A 参与者前测问卷（2026-06-12）', 'role_scope': 'speaker', 'suffix': 'S01',
        'identity': ('qid', 3),
        'questions': [q('CONSENT', 'single_choice', '知情同意确认', 4)]
        + [q('P%d' % (i + 1), 'scale_1_5', t, 5 + i) for i, t in enumerate(P_TITLES)]
        + [q('H%d' % (i + 1), 'scale_1_5', t, 10 + i) for i, t in enumerate(H_TITLES)]
        + [q('STRESS', 'scale_0_10', '你现在感到多大压力', 13)],
    },
    {
        'prefix': '1B-', 'sig': (4, 'P1'),
        'template_code': 'HIST_1B_CHATTER_EXIT_V1', 'template_name': '参与者离场问卷（历史导入）',
        'survey_title': '1B 参与者离场问卷（2026-06-12）', 'role_scope': 'speaker', 'suffix': 'S02',
        'identity': ('qid', 3),
        'questions': [q('P%d' % (i + 1), 'scale_1_5', t, 4 + i) for i, t in enumerate(P_TITLES)]
        + [q('STRESS', 'scale_0_10', '你现在感到多大压力', 9)]
        + [q('H%d' % (i + 1), 'scale_1_5', t, 10 + i) for i, t in enumerate(H_TITLES)]
        + [
            q('E1', 'scale_1_5', '今天的对话让我感到被真正倾听。', 13),
            q('E2', 'scale_1_5', '我带着对自己某个积极方面的认知离开。', 14),
            q('E3', 'scale_1_5', '今天让我感到更愿意与身边的人建立连结。', 15),
            q('E4A', 'multi_choice', '根据今天的活动，您接下来希望探索什么？', 16),
            q('E4A_OTHER', 'text_short', '上题的其他回复', 17, required=False),
            q('E4B', 'scale_1_5', '今天的活动是否帮助您更了解可获得的支持和资源？', 18),
            q('O1', 'text_long', '用一句话描述，今天的对话对你意味着什么？（选答）', 19, required=False),
        ],
    },
    {
        'prefix': '1C-', 'sig': (3, 'D1'),
        'template_code': 'HIST_1C_LISTENER_CARD_V1', 'template_name': '倾听者汇报卡片（历史导入）',
        'survey_title': '1C 倾听者汇报卡片（2026-06-12）', 'role_scope': 'listener', 'suffix': 'S03',
        'identity': ('nickname', 0),
        'questions': [
            q('D1', 'text_long', '今天您在参与者身上注意到的一个优势或有意义的特质是什么？', 3),
            q('D2', 'single_choice', '您的参与者是否提到任何可能需要跟进或进一步支持的内容？', 4),
        ],
    },
    {
        'prefix': '1D-', 'sig': (4, 'H1'),
        'template_code': 'HIST_1D_CHATTER_FUP4W_V1', 'template_name': '参与者4周跟进问卷（历史导入）',
        'survey_title': '1D 参与者4周跟进问卷（2026-06-12）', 'role_scope': 'speaker', 'suffix': 'S04',
        'identity': ('qid', 3),
        'questions': [q('H%d' % (i + 1), 'scale_1_5', t, 4 + i) for i, t in enumerate(H_TITLES)]
        + [q('STRESS', 'scale_0_10', '你现在感到多大压力', 7)]
        + [
            q('F1', 'single_choice', '自活动以来，您是否发现自己更愿意在对话中敞开心扉——无论是新认识的人还是熟悉的人？', 8),
            q('F2', 'single_choice', '在Chat Circles活动中，您表示了希望探索的下一步。您是否已跟进？', 9),
            q('F2_DESC', 'text_long', '对上一题的回答作简述', 10, required=False),
        ],
    },
    {
        'prefix': '2A-', 'sig': (3, 'C1'),
        'template_code': 'HIST_2A_LISTENER_TRAIN_PRE_V1', 'template_name': '倾听者培训前自信心调查（历史导入）',
        'survey_title': '2A 培训前自信心调查（2026-06-09）', 'role_scope': 'listener', 'suffix': 'S05',
        'identity': ('nickname', 0),
        'questions': [q('C%d' % (i + 1), 'scale_1_5', t, 3 + i) for i, t in enumerate(C_TITLES)],
    },
    {
        'prefix': '2B-', 'sig': (3, 'C1'),
        'template_code': 'HIST_2B_LISTENER_TRAIN_POST_V1', 'template_name': '倾听者培训后自信心调查（历史导入）',
        'survey_title': '2B 培训后自信心调查（2026-06-09）', 'role_scope': 'listener', 'suffix': 'S06',
        'identity': ('nickname', 0),
        'questions': [q('C%d' % (i + 1), 'scale_1_5', t, 3 + i) for i, t in enumerate(C_TITLES)],
    },
    {
        'prefix': '2D-', 'sig': (3, 'L1'),
        'template_code': 'HIST_2D_LISTENER_POST_V1', 'template_name': '倾听者活动后问卷（历史导入）',
        'survey_title': '2D 倾听者活动后问卷（2026-06-12）', 'role_scope': 'listener', 'suffix': 'S07',
        'identity': ('nickname', 0),
        'questions': [
            q('L1', 'scale_1_5', '与活动开始前相比，我现在感到更积极、更有活力。', 3),
            q('L2', 'scale_1_5', '今天的对话对我个人而言是有意义、有目的的。', 4),
            q('L3', 'scale_1_5', '我感到自己在今天的对话中真正发挥了积极作用。', 5),
            q('L4A', 'scale_0_10', '以0至10分评分，您向与您相似的人推荐成为Chat Circles倾听者的可能性有多大？', 6),
            q('L4B', 'text_long', '您给出这个分数的主要原因是什么？哪些改善能让分数更高？', 7, required=False),
            q('L5', 'multi_choice', '今天活动后，您打算采取哪些后续行动？', 8),
            q('L5_OTHER', 'text_short', '上题的其他回复', 9, required=False),
        ]
        + [q('C%d' % (i + 1), 'scale_1_5', t, 10 + i) for i, t in enumerate(C_TITLES)]
        + [q('L7', 'text_long', '用一句话描述，今天的活动对你作为倾听者意味着什么？（选答）', 14, required=False)],
    },
    {
        'prefix': '问卷3', 'sig': (3, 'PR1'),
        'template_code': 'HIST_3_PARTNER_REPORT_V1', 'template_name': '合作机构活动后汇报（历史导入）',
        'survey_title': '合作机构活动后汇报（2026-06-12）', 'role_scope': 'both', 'suffix': 'S08',
        'identity': ('partner', 0),
        'questions': [
            q('PR1', 'single_choice', '活动结束后，贵机构引荐的参与者中，是否有人采取了此前从未尝试过的具体后续行动？', 3),
            q('PR2', 'single_choice', '贵机构曾提出过一个想要探索的后续行动，后续会有跟进落实的措施吗？', 4),
            q('PR3', 'scale_0_10', '以0至10分评分，您向类似贵机构的其他机构推荐与Chat Circles合作的可能性有多大？', 5),
            q('PR4', 'text_long', '您给出这个分数的主要原因是什么？哪些改善能让分数更高？', 6, required=False),
            q('PR5', 'text_long', '您是否有其他反馈、观察或建议希望与Empact分享？（选答）', 7, required=False),
        ],
    },
]

# 报名表列 → 机构自定义报名字段（col 下标见表头）
REG_FIELDS = [
    # 直接标识符必须 is_sensitive=True：普通导出按此标记排除（exports.pb.js FR-EXP-002）
    {'code': 'kd_name', 'type': 'text', 'label': '姓名', 'col': 2, 'required': True, 'sensitive': True},
    {'code': 'kd_email', 'type': 'text', 'label': '邮箱', 'col': 3, 'required': True, 'sensitive': True},
    {'code': 'kd_commit_attend', 'type': 'single_choice', 'label': '确认并承诺培训和活动均能到场', 'col': 4, 'required': True},
    {'code': 'kd_expectation', 'type': 'text', 'label': '对项目的期待或特殊说明', 'col': 5, 'required': False},
    {'code': 'kd_commit_principle', 'type': 'single_choice', 'label': '了解并愿意遵守倾听原则', 'col': 6, 'required': True},
    {'code': 'kd_self_eval', 'type': 'multi_choice', 'label': '自我评价', 'col': 7, 'required': False},
    {'code': 'kd_self_eval_other', 'type': 'text', 'label': '自我评价的其他回复', 'col': 8, 'required': False},
    {'code': 'kd_experience', 'type': 'multi_choice', 'label': '相关经验', 'col': 9, 'required': False},
    {'code': 'kd_experience_other', 'type': 'text', 'label': '相关经验的其他回复', 'col': 10, 'required': False},
    {'code': 'kd_gain', 'type': 'multi_choice', 'label': '最希望通过本次活动收获什么', 'col': 11, 'required': False},
    {'code': 'kd_gain_other', 'type': 'text', 'label': '收获的其他回复', 'col': 12, 'required': False},
    {'code': 'kd_motivation', 'type': 'multi_choice', 'label': '想成为Chat Circles志愿者的原因', 'col': 13, 'required': False},
    {'code': 'kd_motivation_other', 'type': 'text', 'label': '志愿者原因的其他回复', 'col': 14, 'required': False},
    # 直接标识符必须 is_sensitive=True：普通导出按此标记排除（exports.pb.js FR-EXP-002）
    {'code': 'kd_employee_id', 'type': 'text', 'label': '公司ID', 'col': 15, 'required': False, 'sensitive': True},
    {'code': 'kd_age_range', 'type': 'single_choice', 'label': '年龄段', 'col': 16, 'required': False},
    {'code': 'kd_age_range_other', 'type': 'text', 'label': '年龄段的其他回复', 'col': 17, 'required': False},
    {'code': 'kd_department', 'type': 'text', 'label': '所在部门', 'col': 18, 'required': False},
    {'code': 'kd_gender', 'type': 'single_choice', 'label': '性别', 'col': 19, 'required': False},
]


def info(msg):
    print('[IMPORT] %s' % msg)


def distinct_values(rows, col, multi=False):
    seen, out = set(), []
    for r in rows:
        vals = parse_multi(cell(r, col)) if multi else ([cell(r, col)] if cell(r, col) else [])
        for v in vals:
            if v not in seen:
                seen.add(v)
                out.append(v)
    return out


def collect_options(rows, spec_questions):
    """为 choice 题从数据收集选项；单选值过长（>30 字符）时降级为 text_short。"""
    for qu in spec_questions:
        if qu['type'] == 'multi_choice':
            vals = distinct_values(rows, qu['col'], multi=True)
            qu['options'] = vals
            if not vals:
                raise RuntimeError('题目 %s 未收集到任何多选选项' % qu['code'])
        elif qu['type'] == 'single_choice':
            vals = distinct_values(rows, qu['col'])
            if any(len(v) > 30 for v in vals):
                qu['type'] = 'text_short'  # 自由文本混入，降级保真
            else:
                qu['options'] = vals
                if not vals:
                    raise RuntimeError('题目 %s 未收集到任何单选选项' % qu['code'])


def sanitize_username(local):
    u = re.sub(r'[^a-z0-9_]', '_', local.lower())
    u = re.sub(r'_+', '_', u).strip('_')
    if len(u) < 4:
        u = 'kd_' + u
    return u[:20]


def main():
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    ap = argparse.ArgumentParser(description='2026-06-12 凯德专场历史数据导入')
    ap.add_argument('--base-url', default=os.environ.get('PB_BASE_URL', 'http://127.0.0.1:8090'))
    ap.add_argument('--su', default=os.environ.get('PB_SUPER_EMAIL', ''))
    ap.add_argument('--sp', default=os.environ.get('PB_SUPER_PASSWORD', ''))
    ap.add_argument('--data-dir', default=os.path.join(repo, '测试数据', 'extracted_20260612'))
    ap.add_argument('--reg-file', default='')
    ap.add_argument('--accounts-out',
                    default=os.path.join(repo, '测试数据', 'import_accounts_20260612.csv'))
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    # ---------------- 解析源数据 ----------------
    reg_file = args.reg_file
    if not reg_file:
        for fn in os.listdir(os.path.join(repo, '测试数据')):
            if fn.endswith('.xlsx') and '报名表' in fn:
                reg_file = os.path.join(repo, '测试数据', fn)
                break
    if not reg_file or not os.path.exists(reg_file):
        print('[FAIL] 找不到倾听者报名表 xlsx', file=sys.stderr)
        return 1
    reg_rows = xlsx_rows(reg_file)
    reg_header, reg_data = reg_rows[0], [r for r in reg_rows[1:] if cell(r, 0)]
    if '姓名' not in reg_header[2]:
        print('[FAIL] 报名表表头不符合预期（col2 应为姓名）：%s' % reg_header[2], file=sys.stderr)
        return 1
    listeners = {}  # nickname -> row
    for r in reg_data:
        listeners[cell(r, 0)] = r
    info('报名表：%d 名倾听者' % len(listeners))

    for spec in SURVEYS:
        path = None
        for fn in sorted(os.listdir(args.data_dir)):
            if fn.startswith(spec['prefix']) and fn.endswith('.xlsx'):
                path = os.path.join(args.data_dir, fn)
                break
        if not path:
            print('[FAIL] %s 找不到 %s* 文件' % (spec['suffix'], spec['prefix']), file=sys.stderr)
            return 1
        rows = xlsx_rows(path)
        sig_col, sig_text = spec['sig']
        if sig_text not in rows[0][sig_col]:
            print('[FAIL] %s 表头不符合预期（col%d 应含 %s）：%s'
                  % (spec['prefix'], sig_col, sig_text, rows[0][sig_col][:40]), file=sys.stderr)
            return 1
        spec['rows'] = [r for r in rows[1:] if any(cell(r, i) for i in range(min(4, len(r))))]
        collect_options(spec['rows'], spec['questions'])
        info('%s %s：%d 份答卷，%d 题' % (spec['suffix'], spec['survey_title'], len(spec['rows']), len(spec['questions'])))

    # ---------------- 预检：身份映射 ----------------
    chatter_ids = set()
    partner_names = []
    errors = []
    for spec in SURVEYS:
        kind, col = spec['identity']
        for r in spec['rows']:
            ident = cell(r, col)
            if not ident:
                errors.append('%s 有一行缺少身份标识' % spec['prefix'])
                continue
            if kind == 'nickname':
                if ident not in listeners:
                    errors.append('%s 填写人「%s」不在报名表中' % (spec['prefix'], ident))
                else:
                    spec.setdefault('ident_map', {})[ident] = ('listener', ident)
            elif kind == 'qid':
                chatter_ids.add(ident)
                spec.setdefault('ident_map', {})[ident] = ('chatter', ident)
            else:
                if ident not in partner_names:
                    partner_names.append(ident)
                spec.setdefault('ident_map', {})[ident] = ('partner', ident)
    if errors:
        for e in errors:
            print('[FAIL] %s' % e, file=sys.stderr)
        return 1
    info('身份映射：%d listener + %d chatter + %d partner' % (len(listeners), len(chatter_ids), len(partner_names)))

    # 实际到场倾听者 = 在四份倾听者问卷（1C/2A/2B/2D）中留下记录的昵称。
    # 数据实证：四份问卷填写人为完全相同的 15 人；其余报名者从培训起无任何记录，
    # 属"报名后未到场"，其报名建成 cancelled（见报名创建段）。
    attended_nicks = set()
    for spec in SURVEYS:
        if spec['identity'][0] == 'nickname':
            attended_nicks.update(spec['ident_map'].keys())
    info('有问卷记录的到场倾听者：%d 人；未到场：%d 人'
         % (len(attended_nicks), len(listeners) - len(attended_nicks)))

    # ---------------- 账号规划（用户名唯一） ----------------
    used = set()
    accounts = []  # {role, username, name, email, password(仅新建时写)}

    def plan_username(base):
        u = base
        n = 1
        while u in used:
            n += 1
            suffix = str(n)
            u = (base[:20 - len(suffix)] + suffix)
        used.add(u)
        return u

    for nick, r in listeners.items():
        local = cell(r, 3).split('@')[0] if '@' in cell(r, 3) else ''
        base = sanitize_username(local) if local else 'kd_lis'
        accounts.append({'role': 'listener', 'username': plan_username(base),
                         'name': cell(r, 2), 'nickname': nick, 'email': cell(r, 3)})
    for cid in sorted(chatter_ids):
        accounts.append({'role': 'chatter', 'username': plan_username('c' + cid),
                         'name': '', 'nickname': '', 'email': '', 'qid': cid})
    for i, name in enumerate(partner_names):
        accounts.append({'role': 'partner', 'username': plan_username('partner_%02d' % (i + 1)),
                         'name': name, 'nickname': '', 'email': ''})
    uname_of = {}  # ('listener', nickname)/('chatter', qid)/('partner', name) -> username
    for a in accounts:
        key = (a['role'], a.get('nickname') or a.get('qid') or a['name'])
        uname_of[key] = a['username']

    # 每份答卷的预期 answers 数（非空且可解析）
    def expected_answers(spec):
        total = 0
        for r in spec['rows']:
            for qu in spec['questions']:
                v = cell(r, qu['col'])
                if not v:
                    continue
                if qu['type'].startswith('scale'):
                    if parse_scale(v) is not None:
                        total += 1
                elif qu['type'] == 'multi_choice':
                    if parse_multi(v):
                        total += 1
                else:
                    total += 1
        return total

    print()
    print('===== 导入计划 =====')
    print('机构：%s；管理员：%s' % (ORG_NAME, ADMIN_USERNAME))
    print('活动：%s（2026-06-12 14:00-16:30，closed，容量 40/40）' % ACTIVITY_CODE)
    print('账号：%d 个（listener %d / chatter %d / partner %d）'
          % (len(accounts), len(listeners), len(chatter_ids), len(partner_names)))
    print('报名：%d 条（到场倾听者/Chatter 为 approved；未到场倾听者与机构方占位为 cancelled）+ 倾听者报名答案'
          % len(accounts))
    for spec in SURVEYS:
        print('问卷 %s %-28s 答卷 %2d 份，预期答案 %3d 条'
              % (spec['suffix'], spec['survey_title'], len(spec['rows']), expected_answers(spec)))
    print('凭据输出：%s' % args.accounts_out)
    if args.dry_run:
        if not (args.su and args.sp):
            print('--dry-run：未提供凭据，仅本地解析，不做服务端预检。')
            return 0
        # 有凭据时做只读预检（只 GET 不写）：提前暴露机构/管理员/活动/用户名冲突
        print('--dry-run：仅做只读预检，不写库。')
        base = args.base_url.rstrip('/')
        s, auth = call(base, 'POST', '/api/collections/_superusers/auth-with-password',
                       {'identity': args.su, 'password': args.sp})
        if s != 200:
            print('[FAIL] superuser 登录失败（%s）：%s' % (s, auth), file=sys.stderr)
            return 1
        ST = auth['token']
        org = get_one(base, 'organizations', "name='%s'" % ORG_NAME, ST)
        print('机构「%s」：%s' % (ORG_NAME, ('已存在（将复用 id=%s）' % org['id']) if org else '不存在（将新建）'))
        admin = get_one(base, 'admin_accounts', "username='%s'" % ADMIN_USERNAME, ST)
        if admin:
            org_ok = org and admin.get('organization_id') == org['id']
            print('管理员 %s：已存在，机构归属%s' % (ADMIN_USERNAME, '匹配（将复用）' if org_ok else '【不匹配，正式执行将中止】'))
        else:
            print('管理员 %s：不存在（将新建）' % ADMIN_USERNAME)
        act = get_one(base, 'activities', "activity_code='%s'" % ACTIVITY_CODE, ST)
        print('活动代码 %s：%s' % (ACTIVITY_CODE, ('已存在（将复用 id=%s）' % act['id']) if act else '不存在（将新建）'))
        hit = sum(1 for a in accounts
                  if get_one(base, 'participant_accounts', "username='%s'" % a['username'], ST))
        print('参与者用户名：%d/%d 已存在（正式执行时按复用规则预检：本活动有报名或在凭据 CSV 中才复用）'
              % (hit, len(accounts)))
        for spec in SURVEYS:
            tpl = get_one(base, 'survey_templates', "template_code='%s'" % spec['template_code'], ST)
            sv = get_one(base, 'activity_surveys', "survey_code='%s_%s'" % (ACTIVITY_CODE, spec['suffix']), ST)
            print('问卷 %s：模板%s / 活动问卷%s' % (spec['suffix'],
                  '已存在' if tpl else '将新建', '已存在' if sv else '将新建'))
        return 0
    if not args.su or not args.sp:
        print('[FAIL] 缺少 superuser 凭据（--su/--sp 或 PB_SUPER_EMAIL/PB_SUPER_PASSWORD）', file=sys.stderr)
        return 1

    # ---------------- 认证 ----------------
    base = args.base_url.rstrip('/')
    s, auth = call(base, 'POST', '/api/collections/_superusers/auth-with-password',
                   {'identity': args.su, 'password': args.sp})
    if s != 200:
        print('[FAIL] superuser 登录失败（%s）：%s' % (s, auth), file=sys.stderr)
        return 1
    ST = auth['token']
    su_id = auth.get('record', {}).get('id', '')
    _RUN_CTX.update({'base': base, 'token': ST, 'su_id': su_id})
    info('superuser 已登录：%s' % base)

    def write_cred(role_, username_, pw_, name_, email_):
        """新建账号凭据即时落盘：脚本中途崩溃也不丢已建账号的密码。"""
        new = not os.path.exists(args.accounts_out) or os.path.getsize(args.accounts_out) == 0
        with open(args.accounts_out, 'a', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            if new:
                w.writerow(['role', 'username', 'password', 'name', 'email'])
            w.writerow([role_, username_, pw_, name_, email_])

    new_participants = 0

    # ---------------- 机构 ----------------
    row = get_one(base, 'organizations', "name='%s'" % ORG_NAME, ST)
    if row:
        org_id = row['id']
        info('机构已存在，复用 %s' % org_id)
    else:
        r = must(base, 'POST', '/api/collections/organizations/records',
                 {'name': ORG_NAME, 'status': 'active', 'require_activity_approval': False,
                  'allow_sensitive_export': True, 'remark': '历史活动数据导入（2026-06-12 专场）'}, ST, '创建机构')
        org_id = r['id']
        info('机构已创建：%s' % org_id)
    _RUN_CTX['org_id'] = org_id

    # ---------------- 机构管理员 ----------------
    row = get_one(base, 'admin_accounts', "username='%s'" % ADMIN_USERNAME, ST)
    if row:
        if row.get('organization_id') != org_id:
            # 用户名全局唯一：被其它机构占用时静默跳过会让本机构没有可用管理员
            print('[FAIL] 管理员用户名 %s 已被其它机构占用（organization_id=%s），'
                  '请改用其它用户名后重试' % (ADMIN_USERNAME, row.get('organization_id')),
                  file=sys.stderr)
            return 1
        info('管理员 %s 已存在且属于本机构，跳过（密码不重置）' % ADMIN_USERNAME)
    else:
        pw = secrets.token_urlsafe(12)
        must(base, 'POST', '/api/collections/admin_accounts/records',
             {'username': ADMIN_USERNAME, 'password': pw, 'passwordConfirm': pw,
              'organization_id': org_id, 'status': 'active', 'display_name': '凯德管理员'}, ST, '创建管理员')
        write_cred('admin', ADMIN_USERNAME, pw, '凯德管理员', '')
        info('管理员 %s 已创建' % ADMIN_USERNAME)

    # ---------------- 报名字段 ----------------
    field_ids = {}
    for f in REG_FIELDS:
        row = get_one(base, 'registration_field_defs',
                      "organization_id='%s'&&field_code='%s'" % (org_id, f['code']), ST)
        if row:
            field_ids[f['code']] = row['id']
            continue
        body = {'organization_id': org_id, 'field_code': f['code'], 'field_type': f['type'],
                'label': f['label'], 'source_type': 'custom',
                'is_sensitive': f.get('sensitive', False),
                'required_default': f['required'], 'status': 'active'}
        if f['type'] in ('single_choice', 'multi_choice'):
            vals = distinct_values(reg_data, f['col'], multi=(f['type'] == 'multi_choice'))
            body['options_json'] = {'options': [{'value': v, 'label': v} for v in vals]}
        r = must(base, 'POST', '/api/collections/registration_field_defs/records', body, ST,
                 '创建字段 %s' % f['code'])
        field_ids[f['code']] = r['id']
    info('报名字段就绪：%d 个' % len(field_ids))

    # ---------------- 活动 ----------------
    row = get_one(base, 'activities', "activity_code='%s'" % ACTIVITY_CODE, ST)
    if row:
        act_id = row['id']
        info('活动已存在，复用 %s' % act_id)
    else:
        r = must(base, 'POST', '/api/collections/activities/records', {
            'organization_id': org_id, 'activity_code': ACTIVITY_CODE,
            'title': 'Chat Circles · 凯德专场（2026-06-12）',
            'description': '历史活动数据导入（2026-08 补录）：倾听者培训 2026-06-09，活动 2026-06-12。',
            'location': '',
            'start_time': to_cst('2026-06-12 14:00'), 'end_time': to_cst('2026-06-12 16:30'),
            'status': 'closed',
            'capacity_total': 80, 'capacity_speaker': 40, 'capacity_listener': 40,
            'registration_open': False,
            'registration_start_at': to_cst('2026-05-01 00:00'),
            'registration_end_at': to_cst('2026-06-12 00:00'),
            'checkin_qr_token': secrets.token_urlsafe(18)[:24],
            'group_tag': '',
            'form_config_json': {'fields': [
                {'field_def_id': field_ids[f['code']], 'enabled': True, 'required': f['required']}
                for f in REG_FIELDS]},
        }, ST, '创建活动')
        act_id = r['id']
        info('活动已创建：%s' % act_id)
    _RUN_CTX['act_id'] = act_id

    # ---------------- 参与者账号 ----------------
    # 预检：用户名全局唯一，已存在账号须证明源自此前的导入运行才允许复用——
    # 在本活动已有报名（上次导入所建），或在凭据 CSV 中（上次导入所建但尚未建报名
    # 即中断；凭据逐账号即时落盘，正好覆盖该场景）。无报名记录也不在 CSV 中的账号
    # 可能是平台用户自助注册后未报名（/api/cc/auth/participant 登录即建账号），
    # 一律视为撞名中止待人工核对，不把历史数据挂到他人名下。
    known_usernames = set()  # 此前运行写入凭据 CSV 的用户名 = 可复用的导入凭据
    if os.path.exists(args.accounts_out):
        with open(args.accounts_out, encoding='utf-8') as f:
            for i, row_ in enumerate(csv.reader(f)):
                if i == 0 or len(row_) < 2:
                    continue
                known_usernames.add(row_[1])
    pid_of = {}  # username -> participant id
    reused_participants = []
    foreign = []
    for a in accounts:
        row = get_one(base, 'participant_accounts', "username='%s'" % a['username'], ST)
        if not row:
            continue
        pid = row['id']
        has_here = bool(get_one(base, 'registrations',
                                "activity_id='%s'&&participant_id='%s'" % (act_id, pid), ST))
        if has_here:
            pid_of[a['username']] = pid
            reused_participants.append(a['username'])
            continue
        if a['username'] in known_usernames:
            pid_of[a['username']] = pid
            reused_participants.append('%s（凭据CSV在册，按中断续跑复用）' % a['username'])
            continue
        total = count_of(base, 'registrations', "participant_id='%s'" % pid, ST)
        if total == 0:
            foreign.append('%s（无报名记录且不在凭据CSV，疑为平台自助注册用户）' % a['username'])
        else:
            foreign.append('%s（在其它活动有 %d 条报名）' % (a['username'], total))
    if foreign:
        print('[FAIL] 以下用户名已是平台既有参与者且与本活动无关，拒绝复用：\n  %s\n'
              '请人工核对后调整账号映射（如为撞名，请修改源数据映射关系）再执行。'
              % '\n  '.join(foreign), file=sys.stderr)
        return 1
    for a in accounts:
        if a['username'] in pid_of:
            continue
        pw = secrets.token_urlsafe(12)
        r = must(base, 'POST', '/api/collections/participant_accounts/records',
                 {'username': a['username'], 'password': pw, 'passwordConfirm': pw,
                  'status': 'active'}, ST, '创建参与者 %s' % a['username'])
        pid_of[a['username']] = r['id']
        write_cred(a['role'], a['username'], pw, a.get('name', ''), a.get('email', ''))
        new_participants += 1
    info('参与者账号就绪：%d 个（新建 %d）' % (len(pid_of), new_participants))
    if reused_participants:
        info('复用已存在账号 %d 个（均有本活动报名或在凭据CSV在册，视为此前导入所建）：%s'
             % (len(reused_participants), ', '.join(reused_participants)))

    # ---------------- 报名记录 + 答案 ----------------
    reg_id_of = {}  # username -> registration id
    new_regs = 0
    fixed_regs = 0
    for a in accounts:
        uname = a['username']
        # 状态判定（新建与既有报名通用）：机构方占位与未到场倾听者为 cancelled，
        # 不计入名额与 survey_completion_rate 分母（metrics.pb.js 按 approved 计数）；
        # 其答卷的可见性与导出不依赖报名状态，故不受影响。
        if a['role'] == 'partner':
            reg_status = 'cancelled'
            reg_reason = '机构方占位账号，非活动参与者（仅为挂接问卷3答卷；不计入名额与完成率口径）'
        elif a['role'] == 'listener' and a['nickname'] not in attended_nicks:
            reg_status = 'cancelled'
            reg_reason = '报名后未到场（培训/活动四份倾听者问卷均无记录）'
        else:
            reg_status = 'approved'
            reg_reason = '历史数据导入：最终名单'
        row = get_one(base, 'registrations',
                      "activity_id='%s'&&participant_id='%s'" % (act_id, pid_of[uname]), ST)
        if row:
            reg_id_of[uname] = row['id']
            # 既有报名状态对齐：早期版本导入的占位/未到场报名可能还是 approved，
            # 重跑必须收敛到本次计算的终态，否则口径虚增一直残留
            if row.get('status') != reg_status or row.get('status_reason') != reg_reason:
                must(base, 'PATCH', '/api/collections/registrations/records/%s' % row['id'],
                     {'status': reg_status, 'status_reason': reg_reason}, ST, '修正报名状态 %s' % uname)
                fixed_regs += 1
        else:
            role = 'listener' if a['role'] == 'listener' else 'speaker'
            if a['role'] == 'listener':
                submitted = to_cst(cell(listeners[a['nickname']], 1))
            elif a['role'] == 'chatter':
                r1a = next(r for r in SURVEYS[0]['rows'] if cell(r, 3) == a['qid'])
                submitted = to_cst(cell(r1a, 2))
            else:
                r3 = next(r for r in SURVEYS[-1]['rows'] if cell(r, 0) == a['name'])
                submitted = to_cst(cell(r3, 2))
            r = must(base, 'POST', '/api/collections/registrations/records',
                     {'activity_id': act_id, 'participant_id': pid_of[uname], 'activity_role': role,
                      'status': reg_status, 'submitted_at': submitted,
                      'status_reason': reg_reason}, ST, '创建报名 %s' % uname)
            reg_id_of[uname] = r['id']
            new_regs += 1
        # 报名答案按 (registration_id, field_def_id) 补齐：中断重跑只补缺失项，不整行跳过
        if a['role'] == 'listener':
            existing = {x['field_def_id'] for x in list_all(
                base, 'registration_answers', "registration_id='%s'" % reg_id_of[uname], ST)}
            src = listeners[a['nickname']]
            for f in REG_FIELDS:
                if field_ids[f['code']] in existing:
                    continue
                v = cell(src, f['col'])
                if not v:
                    continue
                if f['type'] == 'multi_choice':
                    vals = parse_multi(v)
                    if not vals:
                        continue
                    value = vals
                else:
                    value = v
                must(base, 'POST', '/api/collections/registration_answers/records',
                     {'registration_id': reg_id_of[uname], 'field_def_id': field_ids[f['code']],
                      'value_json': value}, ST, '报名答案 %s/%s' % (uname, f['code']))
    info('报名就绪：共 %d 条（新建 %d，状态修正 %d）' % (len(reg_id_of), new_regs, fixed_regs))

    # ---------------- 问卷模板 + 活动问卷 ----------------
    survey_ids = {}  # suffix -> activity_survey id
    for spec in SURVEYS:
        tpl = get_one(base, 'survey_templates', "template_code='%s'" % spec['template_code'], ST)
        if tpl:
            version_id = tpl['current_version_id']
        else:
            schema_qs = []
            for i, qu in enumerate(spec['questions']):
                item = {'question_code': qu['code'], 'question_type': qu['type'],
                        'title': qu['title'], 'required': qu['required'],
                        'locked': False, 'is_sensitive': False, 'order_index': i}
                if qu['type'] in ('single_choice', 'multi_choice'):
                    item['options'] = [{'value': v, 'label': v} for v in qu['options']]
                schema_qs.append(item)
            r = must(base, 'POST', '/api/cc/super/templates',
                     {'template_code': spec['template_code'], 'name': spec['template_name'],
                      'description': '历史数据导入模板', 'schema_json': {'questions': schema_qs}},
                     ST, '创建模板 %s' % spec['template_code'])
            version_id = r['version']['id']
        code = '%s_%s' % (ACTIVITY_CODE, spec['suffix'])
        sv = get_one(base, 'activity_surveys', "survey_code='%s'" % code, ST)
        if sv:
            survey_ids[spec['suffix']] = sv['id']
            existing_codes = {x['question_code'] for x in list_all(
                base, 'survey_questions', "activity_survey_id='%s'" % sv['id'], ST)}
        else:
            times = [to_cst(cell(r, 2)) for r in spec['rows'] if cell(r, 2)]
            opened = min(times) if times else to_cst('2026-06-09 00:00')
            ended = max(times) if times else to_cst('2026-06-13 00:00')
            r = must(base, 'POST', '/api/collections/activity_surveys/records',
                     {'activity_id': act_id, 'template_version_id': version_id, 'survey_code': code,
                      'title': spec['survey_title'], 'role_scope': spec['role_scope'],
                      'status': 'ended', 'qr_token': secrets.token_urlsafe(18)[:24],
                      'opened_at': opened, 'ended_at': ended}, ST, '创建活动问卷 %s' % code)
            survey_ids[spec['suffix']] = r['id']
            existing_codes = set()
        # 题目按 (activity_survey_id, question_code) 补齐：中断重跑只补缺失题
        for i, qu in enumerate(spec['questions']):
            if qu['code'] in existing_codes:
                continue
            body = {'activity_survey_id': survey_ids[spec['suffix']], 'question_code': qu['code'],
                    'source_type': 'standard', 'question_type': qu['type'], 'title': qu['title'],
                    'required': qu['required'], 'locked': False, 'is_sensitive': False,
                    'order_index': i + 1, 'options_json': None, 'validation_json': None}
            if qu['type'] in ('single_choice', 'multi_choice'):
                body['options_json'] = {'options': [{'value': v, 'label': v} for v in qu['options']]}
            must(base, 'POST', '/api/collections/survey_questions/records', body, ST,
                 '物化题目 %s/%s' % (code, qu['code']))
    info('活动问卷就绪：%d 份' % len(survey_ids))

    # ---------------- 答卷 ----------------
    new_subs, new_answers, skipped_rows = 0, 0, []
    for spec in SURVEYS:
        kind, col = spec['identity']
        sid = survey_ids[spec['suffix']]
        for r in spec['rows']:
            ident = cell(r, col)
            uname = uname_of[spec['ident_map'][ident]]
            row = get_one(base, 'submissions',
                          "activity_survey_id='%s'&&participant_id='%s'" % (sid, pid_of[uname]), ST)
            if row:
                sub_id = row['id']
                existing_codes = {x['question_code'] for x in list_all(
                    base, 'answers', "submission_id='%s'" % sub_id, ST)}
            else:
                sub = must(base, 'POST', '/api/collections/submissions/records',
                           {'activity_survey_id': sid, 'participant_id': pid_of[uname],
                            'registration_id': reg_id_of[uname], 'status': 'submitted',
                            'submitted_at': to_cst(cell(r, 2))}, ST, '创建答卷 %s/%s' % (spec['suffix'], uname))
                sub_id = sub['id']
                new_subs += 1
                existing_codes = set()
            # 答案按 (submission_id, question_code) 补齐：中断重跑只补缺失答案
            for qu in spec['questions']:
                if qu['code'] in existing_codes:
                    continue
                v = cell(r, qu['col'])
                if not v:
                    continue
                if qu['type'].startswith('scale'):
                    n = parse_scale(v)
                    if n is None:
                        skipped_rows.append('%s %s 无法解析量表值「%s」' % (spec['suffix'], qu['code'], v))
                        continue
                    lo, hi = (1, 5) if qu['type'] == 'scale_1_5' else (0, 10)
                    if not (lo <= n <= hi):
                        skipped_rows.append('%s %s 量表值越界「%s」' % (spec['suffix'], qu['code'], v))
                        continue
                    value = n
                elif qu['type'] == 'multi_choice':
                    value = parse_multi(v)
                    if not value:
                        continue
                else:
                    value = v
                must(base, 'POST', '/api/collections/answers/records',
                     {'submission_id': sub_id, 'question_code': qu['code'], 'value_json': value},
                     ST, '答案 %s/%s' % (spec['suffix'], qu['code']))
                new_answers += 1
    info('答卷就绪：新建 %d 份答卷、%d 条答案' % (new_subs, new_answers))
    if skipped_rows:
        info('警告：%d 个单元格被跳过：%s' % (len(skipped_rows), '；'.join(skipped_rows[:10])))

    # ---------------- 对账 ----------------
    print()
    print('===== 对账 =====')
    total_reg = count_of(base, 'registrations', "activity_id='%s'" % act_id, ST)
    print('报名记录：预期 %d，实际 %d %s'
          % (len(accounts), total_reg, 'OK' if total_reg == len(accounts) else 'MISMATCH'))
    all_ok = total_reg == len(accounts)
    # 状态口径核对：approved 应 = 到场倾听者 + Chatter，cancelled 应 = 未到场 + 机构方占位
    expect_approved = len(attended_nicks) + len(chatter_ids)
    expect_cancelled = len(accounts) - expect_approved
    actual_approved = count_of(base, 'registrations', "activity_id='%s'&&status='approved'" % act_id, ST)
    ok = actual_approved == expect_approved and (total_reg - actual_approved) == expect_cancelled
    all_ok = all_ok and ok
    print('报名状态：approved 预期/实际 %d/%d，cancelled 预期/实际 %d/%d %s'
          % (expect_approved, actual_approved, expect_cancelled, total_reg - actual_approved,
             'OK' if ok else 'MISMATCH'))
    # 报名答案逐条核对（中断重跑场景下答卷/答案数可能比父级计数更能发现问题）
    expect_reg_ans = 0
    for src in listeners.values():
        for f in REG_FIELDS:
            v = cell(src, f['col'])
            if not v:
                continue
            if f['type'] == 'multi_choice' and not parse_multi(v):
                continue
            expect_reg_ans += 1
    actual_reg_ans = sum(
        count_of(base, 'registration_answers', "registration_id='%s'" % reg_id_of[a['username']], ST)
        for a in accounts if a['role'] == 'listener')
    ok = actual_reg_ans == expect_reg_ans
    all_ok = all_ok and ok
    print('报名答案：预期 %d，实际 %d %s' % (expect_reg_ans, actual_reg_ans, 'OK' if ok else 'MISMATCH'))
    for spec in SURVEYS:
        sid = survey_ids[spec['suffix']]
        subs = list_all(base, 'submissions', "activity_survey_id='%s'" % sid, ST)
        actual = len(subs)
        actual_ans = sum(count_of(base, 'answers', "submission_id='%s'" % s['id'], ST) for s in subs)
        expect = len(spec['rows'])
        expect_ans = expected_answers(spec)
        ok = actual == expect and actual_ans == expect_ans
        all_ok = all_ok and ok
        print('问卷 %s：答卷预期/实际 %d/%d，答案预期/实际 %d/%d %s'
              % (spec['suffix'], expect, actual, expect_ans, actual_ans, 'OK' if ok else 'MISMATCH'))

    # ---------------- 审计（对账之后，按实际结果记录） ----------------
    write_import_audit('success' if all_ok else 'failure',
                       '2026-06-12 凯德专场历史数据导入' + ('' if all_ok else '（对账存在 MISMATCH）'),
                       {'activity_code': ACTIVITY_CODE, 'accounts': len(accounts),
                        'registrations': len(reg_id_of), 'surveys': len(survey_ids),
                        'submissions_created': new_subs, 'answers_created': new_answers})

    # ---------------- 凭据输出 ----------------
    if os.path.exists(args.accounts_out):
        info('新建账号凭据已写入 %s（请勿提交 git）' % args.accounts_out)
    print()
    print('结果：%s' % ('全部 OK' if all_ok else '存在 MISMATCH，请检查上面的对账表'))
    return 0 if all_ok else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as err:
        # 写入阶段中途失败（如某个答案 POST 报错）：尽力补写失败审计再抛出
        write_import_audit('failure', '导入中途失败：%s' % str(err)[:200])
        raise
