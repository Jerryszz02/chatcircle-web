# -*- coding: utf-8 -*-
"""集成测试共享设施：薄 HTTP 客户端 + PASS/FAIL 断言收集器。

仅依赖 Python 标准库；所有断言只针对 API 行为与数据终态（test-plan §3），
不测 hooks 内部函数。统一错误体形态见 pb_hooks/lib/http.pb.js：
{ code: <http status>, message, data: { code: <业务码> } }。
"""
import json
import urllib.error
import urllib.request

# 集成测试只打本机回环实例：禁用代理（urllib 在 macOS 会拾取系统代理设置，
# 本机代理转发 127.0.0.1 会 502 空响应；curl 不读系统代理故手工 curl 正常）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(base, method, path, body=None, token=None, raw=False):
    """发起一次 HTTP 调用，返回 (status, 解析后的 JSON / raw=True 时为原始字节)。"""
    req = urllib.request.Request(base + path, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with _OPENER.open(req, data, timeout=30) as res:
            payload = res.read()
            return res.status, (payload if raw else json.loads(payload or b'{}'))
    except urllib.error.HTTPError as e:
        payload = e.read()
        if raw:
            return e.code, payload
        try:
            return e.code, json.loads(payload or b'{}')
        except Exception:
            return e.code, {'_raw': payload.decode('utf-8', 'replace')}


def biz_code(body):
    """统一错误体内的业务码（data.code）；非字典响应返回 None。"""
    if not isinstance(body, dict):
        return None
    return (body.get('data') or {}).get('code')


class Reporter:
    """按套件分组的断言收集与汇总；fail_count > 0 时 summary() 返回 False。"""

    def __init__(self):
        self._suite = ''
        self.pass_count = 0
        self.fail_count = 0
        self.failures = []  # [(suite, name, detail)]

    def section(self, name):
        self._suite = name
        print()
        print('==== %s ====' % name)

    def check(self, name, cond, detail=''):
        if cond:
            self.pass_count += 1
            print('[PASS] %s' % name)
        else:
            self.fail_count += 1
            self.failures.append((self._suite, name, detail))
            print('[FAIL] %s | %s' % (name, str(detail)[:300]))

    def summary(self):
        total = self.pass_count + self.fail_count
        print()
        print('=' * 50)
        print('集成测试结果：共 %d 项断言，PASS=%d FAIL=%d'
              % (total, self.pass_count, self.fail_count))
        for suite, name, detail in self.failures:
            print('  FAILED [%s] %s | %s' % (suite, name, str(detail)[:300]))
        print('=' * 50)
        return self.fail_count == 0
