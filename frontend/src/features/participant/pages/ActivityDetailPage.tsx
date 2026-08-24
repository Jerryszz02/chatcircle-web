import { Link, useParams } from 'react-router-dom';
import { Button, Card, Loading, PageLayout } from '../../../shared/ui';
import { usePublicActivity } from '../lib/usePublicActivity';
import { formatTimeRange, registrationClosedReasonCopy } from '../lib/status';

/**
 * 公开活动详情（/a/:activityId，FR-ACT-003：未登录可看，点击报名时才要求登录）。
 * 仅 published/closed 活动由服务端放行；展示报名开放状态与剩余名额口径。
 */
export function ActivityDetailPage() {
  const { activityId = '' } = useParams();
  const { data, error, loading, reload } = usePublicActivity(activityId);

  return (
    <PageLayout
      section="参与者端"
      title="公开活动详情"
      className="ccp-root ccp-has-sticky-cta"
      backTo="/"
    >
      {loading ? <Loading fullscreen /> : null}

      {!loading && error ? (
        <Card>
          <p>{error.status === 404 || error.status === 403 ? '活动不存在或未开放' : error.message}</p>
          {error.status !== 404 && error.status !== 403 ? (
            <Button variant="secondary" onClick={reload}>
              重试
            </Button>
          ) : null}
        </Card>
      ) : null}

      {!loading && data ? (
        <>
          <Card title={data.activity.title}>
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
          </Card>

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
    </PageLayout>
  );
}
