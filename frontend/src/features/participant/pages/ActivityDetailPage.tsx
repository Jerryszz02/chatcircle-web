import { Link, useParams } from 'react-router-dom';
import { Button, Card, Loading } from '../../../shared/ui';
import { usePublicActivity } from '../lib/usePublicActivity';
import { formatTimeRange, registrationClosedReasonCopy } from '../lib/status';
import { MyPairingCard } from '../components/MyPairingCard';
import { PublicPageLayout } from '../components/PublicPageLayout';

/**
 * 公开活动详情（/a/:activityId，FR-ACT-003：未登录可看，点击报名时才要求登录）。
 * 仅 published/closed 活动由服务端放行；展示报名开放状态与剩余名额口径。
 * 已登录参与者签到后，本页同时作为活动现场页展示「我的现场编号」配对卡（T5，PRD §5.3）。
 * 2026-08 UI 重构：改用站点公共框架（导航 + 页脚），活动标题即页面主标题，
 * 顶部封面为图片占位块，待活动照片素材替换。
 */
export function ActivityDetailPage() {
  const { activityId = '' } = useParams();
  const { data, error, loading, reload } = usePublicActivity(activityId);

  return (
    <PublicPageLayout className="ccp-has-sticky-cta">
      {loading ? <Loading fullscreen /> : null}

      {!loading && error ? (
        <>
          <h1 className="ccp-detail-title">活动详情</h1>
          <Card>
            <p>{error.status === 404 || error.status === 403 ? '活动不存在或未开放' : error.message}</p>
            {error.status !== 404 && error.status !== 403 ? (
              <Button variant="secondary" onClick={reload}>
                重试
              </Button>
            ) : null}
          </Card>
        </>
      ) : null}

      {!loading && data ? (
        <>
          {/* 活动封面占位：待活动照片素材替换 */}
          <div className="ccp-photo ccp-photo-detail" aria-hidden="true">
            活动照片
          </div>
          <h1 className="ccp-detail-title">{data.activity.title}</h1>
          <dl className="cc-meta">
            <div className="cc-meta-row">
              <dt>活动时间</dt>
              <dd>{formatTimeRange(data.activity.start_time, data.activity.end_time)}</dd>
            </div>
            {data.activity.location ? (
              <div className="cc-meta-row">
                <dt>活动地点</dt>
                <dd>{data.activity.location}</dd>
              </div>
            ) : null}
            <div className="cc-meta-row">
              <dt>活动代码</dt>
              <dd>{data.activity.activity_code}</dd>
            </div>
          </dl>
          {data.activity.description ? (
            <p className="cc-activity-desc">{data.activity.description}</p>
          ) : null}

          {/* T5 活动现场页入口：已登录且已签到时展示本人现场编号与配对状态 */}
          <MyPairingCard activityId={activityId} />

          <Card title="活动报名">
            {data.registration.open ? (
              <>
                <p className="cc-capacity">
                  {typeof data.registration.remaining_total === 'number'
                    ? `总名额剩余 ${data.registration.remaining_total} 个`
                    : '报名开放中'}
                </p>
                <ul className="cc-capacity-detail">
                  {typeof data.registration.remaining_speaker === 'number' ? (
                    <li>倾诉者剩余 {data.registration.remaining_speaker} 个名额</li>
                  ) : null}
                  {typeof data.registration.remaining_listener === 'number' ? (
                    <li>聆听者剩余 {data.registration.remaining_listener} 个名额</li>
                  ) : null}
                </ul>
                <div className="ccp-cta-bar">
                  <Link to={`/a/${activityId}/register`} className="cc-btn cc-btn-primary cc-btn-block">
                    立即报名
                  </Link>
                </div>
                <p className="cc-hint">
                  点击报名后登录或创建账号；已有账号会直接识别登录。
                </p>
              </>
            ) : (
              (() => {
                const copy = registrationClosedReasonCopy(data.registration.reason);
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
