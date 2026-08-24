#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Chat Circles 后端集成测试 runner（L3，test-plan §3）。

两种模式：

1) ``--sql-fixture --data-dir DIR``（serve 启动前执行一次）：
   对临时库直插「标准问卷模板 + 首个版本」。
   之所以用 SQL 直插而非集合 API：survey_templates.current_version_id ↔
   survey_template_versions.template_id 构成循环引用，无法经 API 一次创建
   （迁移 1785888660 顶部注释；PocketBase 侧也无绕过校验的导入接口）。
   列名与该迁移建表结构保持一致，仅依赖标准库 sqlite3。

2) 默认模式（对运行中的实例执行全部套件）：
   顺序执行 suite_* 模块，输出逐条 PASS/FAIL 与汇总；任一失败以退出码 1 结束。

套件相互独立：各套件自建机构/管理员/活动/参与者（test-plan §7 隔离要求），
共享仅为只读的平台级 fixture（标准字段、模板版本）。
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime
from datetime import timezone

from cc_client import Reporter
import cc_fixture as fx

# SQL 直插用固定 id（15 位，PocketBase id 格式），保证可重复执行时幂等
TEMPLATE_ID = 'tpltccitest0001'
VERSION_ID = 'verccitest00001'
TEMPLATE_CODE = 'PARTICIPANT_POST_V1'
# 模板首版题目快照：MOOD 敏感锁定题（导出过滤断言依赖），SAT 单选，NOTE 多行文本
TEMPLATE_SCHEMA = {
    'questions': [
        {'question_code': 'MOOD', 'question_type': 'scale_1_5', 'title': '最近一周情绪状态',
         'required': True, 'locked': True, 'is_sensitive': True, 'order_index': 1},
        {'question_code': 'SAT', 'question_type': 'single_choice', 'title': '整体满意度',
         'required': True, 'order_index': 2,
         'options': [{'value': 'good', 'label': '满意'}, {'value': 'ok', 'label': '一般'}]},
        {'question_code': 'NOTE', 'question_type': 'text_long', 'title': '想说的话',
         'required': False, 'order_index': 3},
    ],
}


def sql_fixture(data_dir):
    """向指定 pb_data 目录的 data.db 直插模板与首版（幂等：按 template_code 去重）。"""
    db = '%s/data.db' % data_dir
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.000Z')
    conn = sqlite3.connect(db, timeout=30)
    try:
        cur = conn.cursor()
        row = cur.execute(
            'SELECT id FROM survey_templates WHERE template_code = ?', (TEMPLATE_CODE,)).fetchone()
        if row:
            print('[INFO] 模板 %s 已存在（id=%s），跳过 SQL 注入' % (TEMPLATE_CODE, row[0]))
            return
        cur.execute(
            "INSERT INTO survey_templates (id, template_code, name, description, status, "
            "current_version_id, created, updated) VALUES (?, ?, '活动后问卷 V1', '', 'active', ?, ?, ?)",
            (TEMPLATE_ID, TEMPLATE_CODE, VERSION_ID, now, now))
        cur.execute(
            "INSERT INTO survey_template_versions (id, template_id, version, schema_json, "
            "published_at, published_by, created, updated) VALUES (?, ?, 1, ?, ?, 'ccitsuperfix001', ?, ?)",
            (VERSION_ID, TEMPLATE_ID, json.dumps(TEMPLATE_SCHEMA, ensure_ascii=False),
             '2026-08-01 00:00:00.000Z', now, now))
        conn.commit()
        print('[INFO] SQL 直插模板完成：%s / %s' % (TEMPLATE_ID, VERSION_ID))
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description='Chat Circles 后端集成测试 runner')
    ap.add_argument('--sql-fixture', action='store_true', help='仅执行模板 SQL 直插后退出')
    ap.add_argument('--data-dir', default='', help='pb_data 目录（--sql-fixture 必填）')
    ap.add_argument('--base-url', default='http://127.0.0.1:8097', help='运行中的实例地址')
    ap.add_argument('--su', default='it-super@cc.local', help='超管邮箱')
    ap.add_argument('--sp', default='cc_it_super_pass_123', help='超管密码')
    args = ap.parse_args()

    if args.sql_fixture:
        if not args.data_dir:
            print('--sql-fixture 需要 --data-dir', file=sys.stderr)
            return 2
        sql_fixture(args.data_dir)
        return 0

    rep = Reporter()
    st, sid = fx.super_login(args.base_url, args.su, args.sp)
    print('[INFO] 超管登录成功，准备平台级 fixture（标准字段 / 模板版本）')
    fields = fx.ensure_standard_fields(args.base_url, st)
    tpl_id, ver_id = fx.template_version_id(args.base_url, st)
    print('[INFO] 标准字段 %d 个；模板 %s 版本 %s' % (len(fields), tpl_id, ver_id))

    ctx = {
        'base': args.base_url, 'st': st, 'sid': sid,
        'fields': fields, 'tpl_id': tpl_id, 'ver_id': ver_id,
        'rep': rep,
    }

    # 套件按依赖无关顺序执行；每个套件自带独立组织数据
    import suite_flow
    import suite_acl
    import suite_capacity
    import suite_transitions
    import suite_checkins
    import suite_trainings
    import suite_surveys
    import suite_exports
    import suite_auth
    import suite_backup
    import suite_nodelete
    import suite_templates
    import suite_hardening

    for mod in (suite_flow, suite_acl, suite_capacity, suite_transitions, suite_checkins,
                suite_trainings, suite_surveys, suite_exports, suite_auth, suite_backup,
                suite_nodelete, suite_templates, suite_hardening):
        mod.run(ctx)

    ok = rep.summary()
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
