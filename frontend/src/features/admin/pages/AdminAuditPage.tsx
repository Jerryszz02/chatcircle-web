import { useCallback, useEffect, useState } from 'react';
import type { AuditLogRecord } from '../../../shared/api/types';
import { normalizeApiError } from '../../../shared/api/http';
import { localDayToPbUtcRange } from '../../../shared/lib/datetime';
import { pbClients } from '../../../shared/pocketbase';
import { Button, Card, Input, Loading } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { StatusTag } from '../components/StatusTag';
import { adminCollections } from '../lib/api';
import { AUDIT_ACTOR_ROLE_LABELS, AUDIT_RESULT_LABELS } from '../lib/labels';
import { formatDateTime } from '../lib/format';

/**
 * 本机构审计日志只读检索（/admin/audit，FR-AUD-001~005）。
 *
 * - 机构管理员只读检索本机构日志（机构范围由服务端规则强制过滤，FR-AUD-005）；
 * - 检索维度：时间、操作者、动作（FR-AUD-004）；
 * - 审计不可变：无任何修改/删除入口（FR-AUD-002、AC-18）。
 */
export function AdminAuditPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');

  const [items, setItems] = useState<AuditLogRecord[] | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(
    async (pageNo: number) => {
      setError('');
      const conditions: string[] = [];
      const params: Record<string, string> = {};
      // 本地日期 → 该自然日对应的 UTC 边界（PB 按 UTC 存储比较，直接拼本地日期会偏移一个时区）
      const fromRange = from ? localDayToPbUtcRange(from) : null;
      if (fromRange) {
        conditions.push('created >= {:fromGte}');
        params.fromGte = fromRange.gte;
      }
      const toRange = to ? localDayToPbUtcRange(to) : null;
      if (toRange) {
        conditions.push('created < {:toLt}');
        params.toLt = toRange.lt;
      }
      // 用户输入一律经 client.filter 参数绑定，防 filter 注入（引号/运算符截断）
      if (actorId.trim()) {
        conditions.push('actor_id = {:actorId}');
        params.actorId = actorId.trim();
      }
      if (action.trim()) {
        conditions.push('action ~ {:action}');
        params.action = action.trim();
      }
      try {
        const list = await adminCollections().auditLogs.getList(pageNo, 50, {
          sort: '-created',
          filter:
            conditions.length > 0
              ? pbClients.admin.filter(conditions.map((c) => `(${c})`).join(' && '), params)
              : undefined,
        });
        setItems(list.items);
        setTotalPages(Math.max(1, list.totalPages));
        setPage(list.page);
      } catch (err) {
        setError(normalizeApiError(err).message);
        setItems([]);
      }
    },
    [from, to, actorId, action],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <AdminLayout title="本机构审计日志">
      <Card>
        <div className="admin-toolbar" role="search" aria-label="审计检索条件">
          <Input label="开始日期" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="结束日期" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input
            label="操作者 ID"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            hint="精确匹配；系统任务为 system"
          />
          <Input
            label="动作代码"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            hint="模糊匹配，如 export、registration、checkin"
          />
          <Button variant="secondary" onClick={() => void load(1)}>
            查询
          </Button>
        </div>
        <p className="admin-muted">
          审计日志不可修改、不可删除，仅支持检索查看（FR-AUD-002/005）；保留期至少 1 年（FR-AUD-003）。
        </p>
      </Card>

      <Card className="admin-section">
        {error ? (
          <p className="cc-error" role="alert">
            {error}
          </p>
        ) : null}
        {items === null && !error ? <Loading label="审计日志加载中…" /> : null}
        {items !== null && items.length === 0 && !error ? (
          <p className="admin-empty">没有符合条件的审计记录。</p>
        ) : null}
        {items && items.length > 0 ? (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>操作者</th>
                    <th>角色</th>
                    <th>动作</th>
                    <th>对象</th>
                    <th>结果</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((log) => (
                    <tr key={log.id}>
                      <td>{formatDateTime(log.created)}</td>
                      <td>
                        <code>{log.actor_id}</code>
                      </td>
                      <td>{AUDIT_ACTOR_ROLE_LABELS[log.actor_role] ?? log.actor_role}</td>
                      <td>
                        <code>{log.action}</code>
                      </td>
                      <td>
                        <code className="admin-muted">
                          {log.target_type}:{log.target_id}
                        </code>
                      </td>
                      <td>
                        <StatusTag
                          label={AUDIT_RESULT_LABELS[log.result] ?? log.result}
                          tone={log.result === 'success' ? 'success' : 'danger'}
                        />
                      </td>
                      <td className="admin-muted">{log.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 ? (
              <div className="admin-row-actions admin-section">
                <Button variant="secondary" disabled={page <= 1} onClick={() => void load(page - 1)}>
                  上一页
                </Button>
                <span className="admin-muted">
                  第 {page} / {totalPages} 页
                </span>
                <Button
                  variant="secondary"
                  disabled={page >= totalPages}
                  onClick={() => void load(page + 1)}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
    </AdminLayout>
  );
}
