import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type {
  AuditLogRecord,
  AuditResult,
  OrganizationRecord,
} from '../../../shared/api/types';
import { Button, Card, Input, Loading } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { escapeFilterValue } from '../lib/approvals';
import { formatDateTime } from '../lib/format';
import { AUDIT_ACTOR_ROLE_LABELS, AUDIT_RESULT_LABELS } from '../lib/labels';

type AuditWithOrg = AuditLogRecord & {
  expand?: { organization_id?: OrganizationRecord };
};

const PER_PAGE = 20;

/** 组装审计检索的 PocketBase filter（FR-AUD-004：按时间、操作者、机构和动作检索）。 */
function buildAuditFilter(input: {
  from: string;
  to: string;
  actorId: string;
  organizationId: string;
  action: string;
  result: AuditResult | '';
}): string | undefined {
  const parts: string[] = [];
  if (input.from) parts.push(`created >= "${escapeFilterValue(input.from)} 00:00:00"`);
  if (input.to) parts.push(`created <= "${escapeFilterValue(input.to)} 23:59:59.999"`);
  if (input.actorId.trim()) parts.push(`actor_id = "${escapeFilterValue(input.actorId.trim())}"`);
  if (input.organizationId) parts.push(`organization_id = "${escapeFilterValue(input.organizationId)}"`);
  if (input.action.trim()) parts.push(`action ~ "${escapeFilterValue(input.action.trim())}"`);
  if (input.result) parts.push(`result = "${escapeFilterValue(input.result)}"`);
  return parts.length > 0 ? parts.join(' && ') : undefined;
}

/**
 * 全局审计检索（/super/audit，FR-AUD-001~005）。
 * 审计记录不可变：本页只读检索，不提供任何修改/删除入口；
 * 高风险事件（导出、补签、作废、审批、机构开关、邀请码、备份等）由服务端写入。
 */
export function SuperAuditPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);

  const [orgs, setOrgs] = useState<OrganizationRecord[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actorId, setActorId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [action, setAction] = useState('');
  const [result, setResult] = useState<AuditResult | ''>('');

  const [items, setItems] = useState<AuditWithOrg[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void cc.organizations
      .getFullList({ sort: 'created' })
      .then((list) => {
        if (!cancelled) setOrgs(list);
      })
      .catch((err) => {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  const load = useCallback(
    async (targetPage: number) => {
      const res = await cc.auditLogs.getList<AuditWithOrg>(targetPage, PER_PAGE, {
        filter: buildAuditFilter({ from, to, actorId, organizationId, action, result }),
        sort: '-created',
        expand: 'organization_id',
      });
      setItems(res.items);
      setPage(res.page);
      setTotalPages(Math.max(1, res.totalPages));
      setTotalItems(res.totalItems);
    },
    [cc, from, to, actorId, organizationId, action, result],
  );

  const runLoad = useCallback(
    (targetPage: number) => {
      void load(targetPage).catch((err) => toast(normalizeApiError(err).message, 'error'));
    },
    [load, toast],
  );

  useEffect(() => {
    runLoad(1);
    // 仅首屏加载；筛选变更后由「查询」按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SuperLayout title="全局审计检索">
      <Card title="检索条件">
        <div className="sa-filter-bar">
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-audit-from">
              开始日期
            </label>
            <input
              id="sa-audit-from"
              className="cc-input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-audit-to">
              结束日期
            </label>
            <input
              id="sa-audit-to"
              className="cc-input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Input
            label="操作者 ID"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            hint="精确匹配；系统任务为 system"
          />
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-audit-org">
              机构
            </label>
            <select
              id="sa-audit-org"
              className="sa-select"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
            >
              <option value="">全部机构</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="动作代码"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            hint="模糊匹配，如 export、invite"
          />
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-audit-result">
              结果
            </label>
            <select
              id="sa-audit-result"
              className="sa-select"
              value={result}
              onChange={(e) => setResult(e.target.value as AuditResult | '')}
            >
              <option value="">全部</option>
              <option value="success">{AUDIT_RESULT_LABELS.success}</option>
              <option value="failure">{AUDIT_RESULT_LABELS.failure}</option>
            </select>
          </div>
          <Button onClick={() => runLoad(1)}>查询</Button>
        </div>
      </Card>

      <Card title={`审计记录（共 ${totalItems} 条）`}>
        {items === null ? (
          <Loading />
        ) : items.length === 0 ? (
          <p className="sa-muted">暂无符合条件的审计记录。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>角色</th>
                  <th>机构</th>
                  <th>动作</th>
                  <th>对象</th>
                  <th>结果</th>
                  <th>原因 / 详情</th>
                </tr>
              </thead>
              <tbody>
                {items.map((log) => (
                  <tr key={log.id}>
                    <td>{formatDateTime(log.created)}</td>
                    <td>{log.actor_id}</td>
                    <td>{AUDIT_ACTOR_ROLE_LABELS[log.actor_role] ?? log.actor_role}</td>
                    <td className="sa-cell-wrap">
                      {log.expand?.organization_id?.name ?? log.organization_id ?? '平台级'}
                    </td>
                    <td>
                      <span className="sa-badge sa-badge-info">{log.action}</span>
                    </td>
                    <td className="sa-cell-wrap">
                      {log.target_type}:{log.target_id}
                    </td>
                    <td>
                      <span
                        className={`sa-badge ${log.result === 'success' ? 'sa-badge-success' : 'sa-badge-danger'}`}
                      >
                        {AUDIT_RESULT_LABELS[log.result]}
                      </span>
                    </td>
                    <td className="sa-cell-wrap">
                      {log.reason ? <div>{log.reason}</div> : null}
                      {log.metadata ? (
                        <details>
                          <summary className="sa-muted">上下文</summary>
                          <pre className="sa-json-preview">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                      {!log.reason && !log.metadata ? <span className="sa-muted">—</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="sa-pagination">
          <Button variant="secondary" disabled={page <= 1} onClick={() => runLoad(page - 1)}>
            上一页
          </Button>
          <span>
            第 {page} / {totalPages} 页
          </span>
          <Button variant="secondary" disabled={page >= totalPages} onClick={() => runLoad(page + 1)}>
            下一页
          </Button>
        </div>
        <p className="sa-muted">
          审计日志只读、不可修改（FR-AUD-002）；默认至少保留 1 年（FR-AUD-003）。
        </p>
      </Card>
    </SuperLayout>
  );
}
