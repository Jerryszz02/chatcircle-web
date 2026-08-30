import { useState } from 'react';
import type { MyPairingResponse } from '../../../shared/api/accountEvent';
import { participantAuth } from '../../../shared/auth';
import type { ApiError } from '../../../shared/api/http';
import { Button, Card } from '../../../shared/ui';
import { myPairingStateMeta, type PairingStatusIcon } from '../lib/pairingStatus';
import type { MyPairingConnectionStatus } from '../lib/myPairingLive';
import { useMyPairing } from '../lib/useMyPairing';

/**
 * 「我的现场编号」卡片（T5，PRD §5.3）：签到成功页、「我的」报名条目与活动详情页
 * 共用的本人配对状态入口。数据只来自 GET my-pairing + 本人 Realtime 失效事件，
 * 不从其他来源推导配对结果。
 *
 * 卡片默认展示本人现场编号与状态标签；已配对/已调整时点开卡片查看组号与搭档。
 * 等待、已配对、已调整均用文字 + 状态图标 + 颜色共同表达，不只依赖颜色。
 * 搭档手机号不展示（服务端也不会下发）。
 * 后台刷新失败时保留旧快照并明确提示“可能不是最新”，同时给出重试入口。
 */

function StatusIcon({ icon }: { icon: PairingStatusIcon }) {
  switch (icon) {
    case 'clock':
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      );
    case 'circles':
      // 双圆交叠：呼应品牌「连接」母题，表示已成组。
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="9" cy="12" r="6" />
          <circle cx="15" cy="12" r="6" />
        </svg>
      );
    case 'refresh':
      return (
        <svg viewBox="0 0 24 24">
          <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      );
    case 'alert':
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
      );
  }
}

export interface MyPairingCardViewProps {
  snapshot: MyPairingResponse | null;
  status: MyPairingConnectionStatus;
  error: ApiError | null;
  loading: boolean;
  onRetry: () => void;
}

/** 纯展示层：容器（MyPairingCard / MePage）负责取数，本组件只按 props 渲染。 */
export function MyPairingCardView({
  snapshot,
  status,
  error,
  loading,
  onRetry,
}: MyPairingCardViewProps) {
  const [expanded, setExpanded] = useState(false);

  if (loading && !snapshot) {
    return (
      <Card title="我的现场编号" className="ccp-pairing-card">
        <p className="cc-hint" aria-busy="true">
          正在加载配对信息…
        </p>
      </Card>
    );
  }

  if (!snapshot) {
    // 未报名/无权限/会话失效：本卡片没有可展示内容，静默隐藏（页面主流程另行引导）。
    if (!error || error.status === 401 || error.status === 403 || error.status === 404) {
      return null;
    }
    return (
      <Card title="我的现场编号" className="ccp-pairing-card">
        <p className="cc-hint">{error.message}</p>
        <Button variant="secondary" block onClick={onRetry}>
          重试
        </Button>
      </Card>
    );
  }

  const meta = myPairingStateMeta(snapshot.state);
  // not_checked_in：三个入口只展示已签到后的配对状态（PRD §5.3），未签到不渲染卡片。
  if (!meta) return null;

  const hasDetails =
    (snapshot.state === 'paired' || snapshot.state === 'reassigned') &&
    !!snapshot.pair_code &&
    !!snapshot.partner;

  return (
    <Card title="我的现场编号" className="ccp-pairing-card">
      <div aria-live="polite">
        <div className="ccp-pairing-status">
          <span className={`ccp-pairing-icon ccp-pairing-icon-${meta.tone}`} aria-hidden="true">
            <StatusIcon icon={meta.icon} />
          </span>
          <span className={`cc-tag cc-tag-${meta.tone}`}>{meta.label}</span>
        </div>
        {snapshot.state !== 'checkin_revoked' && snapshot.onsite_code ? (
          <p className="ccp-onsite-code">{snapshot.onsite_code}</p>
        ) : null}
        <p className="cc-hint">{meta.hint}</p>
        {hasDetails ? (
          <>
            <Button
              variant="secondary"
              block
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              {expanded ? '收起配对详情' : '查看组号与搭档'}
            </Button>
            {expanded ? (
              <dl className="cc-meta ccp-pairing-details">
                <div className="cc-meta-row">
                  <dt>配对组号</dt>
                  <dd>{snapshot.pair_code}</dd>
                </div>
                <div className="cc-meta-row">
                  <dt>我的编号</dt>
                  <dd>{snapshot.onsite_code}</dd>
                </div>
                <div className="cc-meta-row">
                  <dt>搭档编号</dt>
                  <dd>{snapshot.partner!.onsite_code}</dd>
                </div>
                <div className="cc-meta-row">
                  <dt>搭档姓名</dt>
                  <dd>{snapshot.partner!.display_name || '—'}</dd>
                </div>
              </dl>
            ) : null}
          </>
        ) : null}
        {error ? (
          <div className="cc-notice ccp-pairing-stale" role="alert">
            <p className="cc-hint">配对信息刷新失败，显示的可能不是最新状态。</p>
            <Button variant="secondary" block onClick={onRetry}>
              重新获取
            </Button>
          </div>
        ) : status === 'offline' ? (
          <p className="cc-hint ccp-pairing-offline">实时连接已断开，恢复后会自动更新。</p>
        ) : null}
      </div>
    </Card>
  );
}

/** 单活动容器（签到成功页 / 活动详情页）：未登录不渲染。 */
export function MyPairingCard({ activityId }: { activityId: string }) {
  const authed = participantAuth.isValid();
  const { snapshot, status, error, loading, reload } = useMyPairing(authed ? activityId : null);
  if (!authed) return null;
  return (
    <MyPairingCardView
      snapshot={snapshot}
      status={status}
      error={error}
      loading={loading}
      onRetry={reload}
    />
  );
}
