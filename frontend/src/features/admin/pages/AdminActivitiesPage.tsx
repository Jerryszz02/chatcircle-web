import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityRecord, ActivityStatus } from '../../../shared/api/types';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { ActivityForm } from '../components/ActivityForm';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { adminCollections } from '../lib/api';
import { ACTIVITY_STATUS_LABELS } from '../lib/labels';
import { formatDateTime } from '../lib/format';

const STATUS_TONES: Record<ActivityStatus, StatusTone> = {
  draft: 'neutral',
  pending_review: 'info',
  rejected: 'danger',
  published: 'success',
  closed: 'warning',
  taken_down: 'danger',
  archived: 'neutral',
};

/**
 * 活动列表（/admin/activities）。
 * 本机构活动（机构隔离由服务端规则强制），含状态筛选与创建入口；
 * 列表不出现公开广场语义——活动仅链接/二维码可达（FR-ACT-002）。
 */
export function AdminActivitiesPage() {
  const [items, setItems] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | ActivityStatus>('');
  const [showCreate, setShowCreate] = useState(false);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    // 竞态保护：连续切换筛选/刷新时仅最后一次响应生效，避免旧响应覆盖新状态
    const seq = ++loadSeq.current;
    setError('');
    try {
      const filter = statusFilter ? `status = "${statusFilter}"` : undefined;
      const list = await adminCollections().activities.getFullList({
        sort: '-created',
        filter,
      });
      if (seq !== loadSeq.current) return;
      setItems(list);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(normalizeApiError(err).message);
      setItems([]);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AdminLayout
      title="活动列表"
      actions={<Button onClick={() => setShowCreate(true)}>创建活动</Button>}
    >
      <div className="admin-toolbar">
        <div className="cc-field">
          <label className="cc-label" htmlFor="activity-status-filter">
            状态筛选
          </label>
          <select
            id="activity-status-filter"
            className="admin-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | ActivityStatus)}
          >
            <option value="">全部状态</option>
            {Object.entries(ACTIVITY_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          刷新
        </Button>
      </div>

      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {items === null && !error ? <Loading fullscreen label="活动加载中…" /> : null}
      {items !== null && items.length === 0 && !error ? (
        <p className="admin-empty">暂无活动，点击右上角「创建活动」开始。</p>
      ) : null}
      {items && items.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>代码</th>
                <th>状态</th>
                <th>时间</th>
                <th>名额（总/倾诉/聆听）</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{a.title}</td>
                  <td>
                    <code>{a.activity_code}</code>
                  </td>
                  <td>
                    <StatusTag label={ACTIVITY_STATUS_LABELS[a.status]} tone={STATUS_TONES[a.status]} />
                  </td>
                  <td>
                    {formatDateTime(a.start_time)}
                    <br />
                    <span className="admin-muted">至 {formatDateTime(a.end_time)}</span>
                  </td>
                  <td>
                    {a.capacity_total} / {a.capacity_speaker} / {a.capacity_listener}
                  </td>
                  <td>
                    <Link to={`/admin/activities/${a.id}`}>
                      <Button variant="secondary">管理</Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Modal open={showCreate} title="创建活动" onClose={() => setShowCreate(false)}>
        <ActivityForm
          mode="create"
          approvedCounts={{ total: 0, speaker: 0, listener: 0 }}
          onSaved={() => {
            setShowCreate(false);
            void load();
          }}
          onCancel={() => setShowCreate(false)}
        />
      </Modal>

      <Card className="admin-section">
        <p className="admin-muted">
          活动不会出现在任何公开列表，仅通过活动链接/二维码可达（FR-ACT-002）。创建后为草稿，
          按机构开关直接发布或提交平台审核（FR-ORG-004）。
        </p>
      </Card>
    </AdminLayout>
  );
}
