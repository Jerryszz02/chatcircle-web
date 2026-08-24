import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { participantAuth } from '../../../shared/auth';
import { Card, Loading, PageLayout } from '../../../shared/ui';
import { getMyTrainings, isUnauthorized, type MyTrainingsOverview } from '../api';
import { formatDateTime, formatTimeRange, trainingStatusLabel } from '../lib/status';

/**
 * 聆听者培训页（/trainings，需参与者登录）。
 * 资格：账号存在已通过的聆听者报名（eligible，服务端判定）；
 * 未达标 → 空态引导先报名聆听者；达标 → 流程说明 + 培训资质标记 + 培训列表。
 * 「培训通过」为账号级标记（任一 valid 签到即 trained），全平台通用，之后参加同类活动无需重复培训；
 * 签到记录被撤销（revoked）视为未参加。
 */
export function TrainingsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MyTrainingsOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getMyTrainings()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const apiErr = normalizeApiError(err);
        if (isUnauthorized(apiErr)) {
          // 会话过期：清除后由守卫引导重新登录，并回跳本页。
          participantAuth.logout();
          navigate('/login?redirect=%2Ftrainings', { replace: true });
          return;
        }
        setError(apiErr);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <PageLayout section="参与者端" title="聆听者培训" className="ccp-root" backTo="/me">
      {loading ? <Loading fullscreen /> : null}

      {!loading && error ? (
        <Card>
          <p>{error.message}</p>
        </Card>
      ) : null}

      {!loading && data && !data.eligible ? (
        <Card>
          <p className="cc-result-title">培训功能暂未开放</p>
          <p className="cc-hint">
            报名聆听者并通过审核后开放培训功能。你可以先在活动详情页报名聆听者，审核通过后即可查看培训安排并参加培训签到。
          </p>
          <Link to="/me" className="cc-btn cc-btn-secondary cc-btn-block">
            返回「我的」中心
          </Link>
        </Card>
      ) : null}

      {!loading && data?.eligible ? (
        <>
          <Card title="培训流程">
            <p className="cc-hint">1. 报名聆听者，等待机构审核通过；</p>
            <p className="cc-hint">2. 按培训安排到场，扫培训二维码完成签到；</p>
            <p className="cc-hint">
              3. 签到成功后获得聆听者资质，之后参加同类活动无需重复培训。
            </p>
          </Card>

          {data.trained ? (
            <Card>
              <p>
                <span className="cc-tag cc-tag-success">已完成聆听者培训</span>
              </p>
              <p className="cc-hint">你已获得聆听者资质，之后参加同类活动无需重复培训。</p>
            </Card>
          ) : null}

          <Card title="培训列表">
            {data.trainings.length === 0 ? (
              <p className="cc-empty">暂无培训安排，请留意机构通知。</p>
            ) : (
              <ul className="cc-item-list">
                {data.trainings.map((t) => {
                  const attended = t.my_attendance?.status === 'valid';
                  return (
                    <li key={t.id} className="cc-item">
                      <div className="cc-item-head">
                        <span className="cc-item-title">{t.title}</span>
                        <span
                          className={`cc-tag ${t.status === 'published' ? 'cc-tag-info' : 'cc-tag-muted'}`}
                        >
                          {trainingStatusLabel(t.status)}
                        </span>
                      </div>
                      <p className="cc-item-meta">
                        {formatTimeRange(t.start_time, t.end_time)}
                        {t.location ? ` · ${t.location}` : ''}
                      </p>
                      {t.description ? <p className="cc-item-meta">{t.description}</p> : null}
                      <p className="cc-item-meta">
                        我的状态：
                        {attended && t.my_attendance
                          ? `已通过（签到于 ${formatDateTime(t.my_attendance.checked_in_at)}）`
                          : '未参加'}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </PageLayout>
  );
}
