import type { ReactNode } from 'react';
import type { PublicActivityDetailView, PublicLoadError } from '../../../public/types';
import { Button, Card, Loading } from '../../../shared/ui';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { formatTimeRange, registrationClosedReasonCopy } from '../lib/status';

/**
 * 公开活动详情纯展示视图（SSR 安全；/a/:activityId，FR-ACT-003：未登录可看）。
 * 仅 published/closed 活动由服务端放行；展示报名开放状态与剩余名额口径。
 * 「我的现场编号」配对卡等会话敏感内容经 personalSlot 插槽注入（容器用 ClientOnly 包裹），
 * 不进入服务端渲染图。「立即报名」为纯 <a> document navigation。
 */
export function ActivityDetailPageView({
  detail,
  error,
  loading,
  onRetry,
  activityId,
  personalSlot,
  actions,
}: {
  detail: PublicActivityDetailView | null;
  error: PublicLoadError | null;
  loading: boolean;
  onRetry?: () => void;
  /** 活动 id（用于报名链接）；与服务端路由参数一致。 */
  activityId: string;
  /** 会话敏感区插槽（如 MyPairingCard，经 ClientOnly 包裹注入）。 */
  personalSlot?: ReactNode;
  /** 站点头部账号区插槽。 */
  actions?: ReactNode;
}) {
  return (
    <PublicPageLayout className="ccp-has-sticky-cta" actions={actions}>
      {loading ? <Loading fullscreen /> : null}

      {!loading && error ? (
        <>
          <h1 className="ccp-detail-title">活动详情</h1>
          <Card>
            <p>
              {error.status === 404 || error.status === 403 ? '活动不存在或未开放' : error.message}
            </p>
            {error.status !== 404 && error.status !== 403 ? (
              <Button variant="secondary" onClick={onRetry}>
                重试
              </Button>
            ) : null}
          </Card>
        </>
      ) : null}

      {!loading && detail ? (
        <>
          {/* 活动封面占位：待活动照片素材替换 */}
          <div className="ccp-photo ccp-photo-detail" aria-hidden="true">
            活动照片
          </div>
          <h1 className="ccp-detail-title">{detail.activity.title}</h1>
          <dl className="cc-meta">
            <div className="cc-meta-row">
              <dt>活动时间</dt>
              <dd>{formatTimeRange(detail.activity.start_time, detail.activity.end_time)}</dd>
            </div>
            {detail.activity.location ? (
              <div className="cc-meta-row">
                <dt>活动地点</dt>
                <dd>{detail.activity.location}</dd>
              </div>
            ) : null}
            <div className="cc-meta-row">
              <dt>活动代码</dt>
              <dd>{detail.activity.activity_code}</dd>
            </div>
          </dl>
          {detail.activity.description ? (
            <p className="cc-activity-desc">{detail.activity.description}</p>
          ) : null}

          {/* T5 活动现场页入口：已登录且已签到时展示本人现场编号与配对状态 */}
          {personalSlot}

          <Card title="活动报名">
            {detail.registration.open ? (
              <>
                <p className="cc-capacity">
                  {typeof detail.registration.remaining_total === 'number'
                    ? `总名额剩余 ${detail.registration.remaining_total} 个`
                    : '报名开放中'}
                </p>
                <ul className="cc-capacity-detail">
                  {typeof detail.registration.remaining_speaker === 'number' ? (
                    <li>倾诉者剩余 {detail.registration.remaining_speaker} 个名额</li>
                  ) : null}
                  {typeof detail.registration.remaining_listener === 'number' ? (
                    <li>聆听者剩余 {detail.registration.remaining_listener} 个名额</li>
                  ) : null}
                </ul>
                <div className="ccp-cta-bar">
                  <a
                    href={`/a/${activityId}/register`}
                    className="cc-btn cc-btn-primary cc-btn-block"
                  >
                    立即报名
                  </a>
                </div>
                <p className="cc-hint">点击报名后登录或创建账号；已有账号会直接识别登录。</p>
              </>
            ) : (
              (() => {
                const copy = registrationClosedReasonCopy(detail.registration.reason);
                return (
                  <>
                    <p className="cc-closed-title">{copy.title}</p>
                    <p className="cc-hint">{copy.detail}</p>
                  </>
                );
              })()
            )}
          </Card>
        </>
      ) : null}
    </PublicPageLayout>
  );
}
