import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type { ActivityRecord, OrganizationRecord } from '../../../shared/api/types';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { approveActivity, rejectActivity } from '../api';
import { validateRejectReason } from '../lib/approvals';
import { formatDateTime } from '../lib/format';

type ActivityWithOrg = ActivityRecord & {
  expand?: { organization_id?: OrganizationRecord };
};

const PER_PAGE = 20;

/**
 * 活动发布审批队列（/super/approvals）。
 * 机构开启「发布需平台审核」后，活动提交进入 pending_review（PRD §4.3、FR-ORG-004）；
 * 批准/驳回仅超管可执行，驳回必填原因（机构可见并修改重提），写 activity_approvals + 审计。
 */
export function SuperApprovalsPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);

  const [items, setItems] = useState<ActivityWithOrg[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [rejecting, setRejecting] = useState<ActivityWithOrg | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [approving, setApproving] = useState<ActivityWithOrg | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (targetPage: number) => {
      const res = await cc.activities.getList<ActivityWithOrg>(targetPage, PER_PAGE, {
        filter: 'status="pending_review"',
        sort: 'created',
        expand: 'organization_id',
      });
      setItems(res.items);
      setPage(res.page);
      setTotalPages(Math.max(1, res.totalPages));
    },
    [cc],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await cc.activities.getList<ActivityWithOrg>(1, PER_PAGE, {
          filter: 'status="pending_review"',
          sort: 'created',
          expand: 'organization_id',
        });
        if (!cancelled) {
          setItems(res.items);
          setPage(res.page);
          setTotalPages(Math.max(1, res.totalPages));
        }
      } catch (err) {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  const onApprove = async () => {
    if (!approving) return;
    setSaving(true);
    try {
      await approveActivity(approving.id);
      toast(`已批准发布「${approving.title}」`, 'success');
      setApproving(null);
      await load(page);
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const onReject = async () => {
    if (!rejecting) return;
    const error = validateRejectReason(reason);
    setReasonError(error);
    if (error) return;
    setSaving(true);
    try {
      await rejectActivity(rejecting.id, reason.trim());
      toast(`已驳回「${rejecting.title}」`, 'success');
      setRejecting(null);
      setReason('');
      await load(page);
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SuperLayout title="活动发布审批">
      <Card title="待审核队列">
        {items === null ? (
          <Loading />
        ) : items.length === 0 ? (
          <p className="sa-muted">当前没有待审核的活动。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>活动</th>
                  <th>机构</th>
                  <th>活动时间</th>
                  <th>名额（总/倾诉/聆听）</th>
                  <th>提交时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((act) => (
                  <tr key={act.id}>
                    <td className="sa-cell-wrap">
                      <div>{act.title}</div>
                      <div className="sa-muted">{act.activity_code}</div>
                    </td>
                    <td className="sa-cell-wrap">
                      {act.expand?.organization_id?.name ?? act.organization_id}
                    </td>
                    <td>
                      {formatDateTime(act.start_time)}
                      <br />
                      {formatDateTime(act.end_time)}
                    </td>
                    <td>
                      {act.capacity_total} / {act.capacity_speaker} / {act.capacity_listener}
                    </td>
                    <td>{formatDateTime(act.created)}</td>
                    <td>
                      <div className="sa-actions">
                        <Button onClick={() => setApproving(act)}>批准</Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            setRejecting(act);
                            setReason('');
                            setReasonError(null);
                          }}
                        >
                          驳回
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 ? (
          <div className="sa-pagination">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => void load(page - 1).catch((err) => toast(normalizeApiError(err).message, 'error'))}
            >
              上一页
            </Button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => void load(page + 1).catch((err) => toast(normalizeApiError(err).message, 'error'))}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </Card>

      {/* 批准确认 */}
      <Modal
        open={approving !== null}
        title="批准发布"
        onClose={() => setApproving(null)}
        footer={
          <>
            <Button loading={saving} onClick={() => void onApprove()}>
              确认批准
            </Button>
            <Button variant="secondary" onClick={() => setApproving(null)}>
              取消
            </Button>
          </>
        }
      >
        <p>
          确认批准「{approving?.title}」发布？批准后活动对外可访问（仅链接/二维码可达，无公开广场），
          审批结果将写入审核历史与审计日志。
        </p>
      </Modal>

      {/* 驳回（原因必填） */}
      <Modal
        open={rejecting !== null}
        title={`驳回：${rejecting?.title ?? ''}`}
        onClose={() => setRejecting(null)}
        footer={
          <>
            <Button variant="danger" loading={saving} onClick={() => void onReject()}>
              确认驳回
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              取消
            </Button>
          </>
        }
      >
        <div className="cc-field">
          <label className="cc-label" htmlFor="sa-reject-reason">
            驳回原因
            <span className="cc-required" aria-hidden="true">
              *
            </span>
          </label>
          <textarea
            id="sa-reject-reason"
            className="sa-textarea"
            style={{ minHeight: '6rem' }}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (reasonError) setReasonError(validateRejectReason(e.target.value));
            }}
            aria-invalid={reasonError ? true : undefined}
          />
          {reasonError ? (
            <p className="cc-error" role="alert">
              {reasonError}
            </p>
          ) : null}
          <p className="sa-muted">机构可查看驳回原因，修改后可重新提交审核（PRD §4.3）。</p>
        </div>
      </Modal>
    </SuperLayout>
  );
}
