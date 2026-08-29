import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { participantAuth } from '../../../shared/auth';
import type { ParticipantAccountRecord } from '../../../shared/api/types';
import { Button, Card, Loading, PageLayout } from '../../../shared/ui';
import { getMeOverview, isUnauthorized, type MeOverview } from '../api';
import { PhoneBindingForm } from '../components/PhoneBindingForm';
import { PhoneChangeForm } from '../components/PhoneChangeForm';
import {
  activityRoleLabel,
  activityStatusLabel,
  formatDateTime,
  formatTimeRange,
  registrationStatusMeta,
} from '../lib/status';

/**
 * 「我的」中心（/me，FR-PAR-001/002，AC-22）：
 * 本人报名状态列表、开放中问卷入口、已提交答卷索引（答案只读）。
 * 跨机构展示、仅本人数据（服务端按登录身份过滤）。
 */
export function MePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MeOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [phoneForm, setPhoneForm] = useState<'none' | 'bind' | 'change'>('none');
  const [, setAccountVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMeOverview()
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
          navigate('/login?redirect=%2Fme', { replace: true });
          return;
        }
        setError(apiErr);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const account = participantAuth.record as ParticipantAccountRecord | null;
  const phoneStatus = account?.phone_migration_status || 'legacy_unbound';
  const phoneMasked = account?.phone_masked || '';
  const phoneUpdated = () => {
    setPhoneForm('none');
    setAccountVersion((value) => value + 1);
  };

  const headerActions = (
    <Button
      variant="secondary"
      onClick={() => {
        participantAuth.logout();
        navigate('/login', { replace: true });
      }}
    >
      退出登录
    </Button>
  );

  return (
    <PageLayout section="参与者端" title="我的中心" actions={headerActions} className="ccp-root" backTo="/">
      {loading ? <Loading fullscreen /> : null}

      {!loading && error ? (
        <Card>
          <p>{error.message}</p>
        </Card>
      ) : null}

      {!loading && data ? (
        <>
          <Card title="账号与手机号">
            {phoneStatus === 'phone_bound' ? (
              <>
                <p className="cc-hint">已绑定：{phoneMasked || '手机号已验证'}</p>
                {phoneForm === 'change' ? (
                  <PhoneChangeForm onSuccess={phoneUpdated} />
                ) : (
                  <Button variant="secondary" block onClick={() => setPhoneForm('change')}>
                    更换手机号
                  </Button>
                )}
              </>
            ) : phoneStatus === 'merge_required' ? (
              <p className="cc-notice">
                该手机号已关联其他账号，无法自动合并。请联系人工支持，并保留当前账号的登录信息。
              </p>
            ) : phoneForm === 'bind' ? (
              <PhoneBindingForm onSuccess={phoneUpdated} />
            ) : (
              <>
                <p className="cc-hint">当前是存量用户名账号，绑定手机号后才能使用新的验证码登录方式。</p>
                <Button variant="primary" block onClick={() => setPhoneForm('bind')}>
                  绑定手机号
                </Button>
              </>
            )}
          </Card>

          {data.has_approved_listener_registration ? (
            <Card title="聆听者培训">
              <p className="cc-hint">
                你的聆听者报名已通过审核，可查看培训安排并参加培训签到；完成培训后获得聆听者资质。
              </p>
              <Link to="/trainings" className="cc-btn cc-btn-primary cc-btn-block">
                查看培训
              </Link>
            </Card>
          ) : null}

          <Card title="我的报名">
            {data.registrations.length === 0 ? (
              <p className="cc-empty">暂无报名记录。扫描活动二维码或打开活动链接即可报名。</p>
            ) : (
              <ul className="cc-item-list">
                {data.registrations.map(({ registration, activity }) => {
                  const meta = registrationStatusMeta(registration.status);
                  return (
                    <li key={registration.id} className="cc-item">
                      <div className="cc-item-head">
                        <Link to={`/a/${activity.id}`} className="cc-item-title">
                          {activity.title}
                        </Link>
                        <span className={`cc-tag cc-tag-${meta.tone}`}>{meta.label}</span>
                      </div>
                      <p className="cc-item-meta">
                        {activityRoleLabel(registration.activity_role)} ·{' '}
                        {formatTimeRange(activity.start_time, activity.end_time)} · 活动
                        {activityStatusLabel(activity.status)}
                      </p>
                      {registration.status_reason ? (
                        <p className="cc-item-meta">原因：{registration.status_reason}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="开放中的问卷">
            {data.open_surveys.length === 0 ? (
              <p className="cc-empty">当前没有可填写的问卷。</p>
            ) : (
              <ul className="cc-item-list">
                {data.open_surveys.map(({ survey, activity_title, my_submission }) => (
                  <li key={survey.id} className="cc-item">
                    <div className="cc-item-head">
                      <span className="cc-item-title">{survey.title}</span>
                      {my_submission?.status === 'draft' ? (
                        <span className="cc-tag cc-tag-info">草稿待继续</span>
                      ) : null}
                    </div>
                    <p className="cc-item-meta">{activity_title}</p>
                    <Link to={`/survey/${survey.qr_token}`} className="cc-btn cc-btn-primary cc-btn-block">
                      {my_submission?.status === 'draft' ? '继续填写' : '去填写'}
                    </Link>
                  </li>
                ))}
            </ul>
            )}
          </Card>

          <Card title="已提交的答卷">
            {data.submissions.length === 0 ? (
              <p className="cc-empty">还没有已提交的答卷。</p>
            ) : (
              <ul className="cc-item-list">
                {data.submissions.map(({ submission, survey_title, survey_qr_token, activity_title }) => (
                  <li key={submission.id} className="cc-item">
                    <div className="cc-item-head">
                      <span className="cc-item-title">{survey_title}</span>
                    </div>
                    <p className="cc-item-meta">
                      {activity_title} · 提交于 {formatDateTime(submission.submitted_at)}
                    </p>
                    <Link
                      to={`/survey/${survey_qr_token}`}
                      className="cc-btn cc-btn-secondary cc-btn-block"
                    >
                      查看答案（只读）
                    </Link>
                  </li>
                ))}
            </ul>
            )}
          </Card>
        </>
      ) : null}
    </PageLayout>
  );
}
