import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { currentRole, participantAuth } from '../../../shared/auth';
import { useSessionSnapshot } from '../../../shared/session';
import { Button, Loading, PageLayout } from '../../../shared/ui';
import {
  getMeOverview,
  getPublicActivities,
  type MeOverview,
  type PublicActivityListItem,
} from '../api';
import { activityStatusLabel, formatTimeRange, registrationClosedReasonCopy } from '../lib/status';
import { HeaderActions } from '../components/HeaderActions';

/**
 * 活动与问卷页（/activities，未登录可看）：由首页拆出。
 * 活动广场（公开活动列表，点击进详情/报名）+ 问卷入口（登录后显示本人可填问卷，
 * 未登录显示扫码指引）。浏览活动不需要账号；报名与填写问卷时在对应链路内
 * 登录/自动注册（FR-AUTH-001）。问卷也可直接扫描活动现场二维码进入
 * （/survey/:qrToken，未登录由守卫引导登录后回跳）。
 * 支持 #activities / #surveys 锚点直达对应区块。
 */
export function ActivitiesPage() {
  // 订阅会话变化：登录/登出后问卷区与头部入口即时刷新
  useSessionSnapshot();
  const authed = participantAuth.isValid();
  // 当前有效会话角色（单会话互斥，见 shared/auth.ts）：仅用于问卷区兜底提示。
  const role = currentRole();
  const [activities, setActivities] = useState<PublicActivityListItem[] | null>(null);
  const [activitiesError, setActivitiesError] = useState<ApiError | null>(null);
  const [overview, setOverview] = useState<MeOverview | null>(null);
  const [tick, setTick] = useState(0);
  const { hash } = useLocation();

  useEffect(() => {
    let cancelled = false;
    getPublicActivities()
      .then((res) => {
        if (cancelled) return;
        setActivities(res.activities);
      })
      .catch((err) => {
        if (cancelled) return;
        setActivitiesError(normalizeApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // 已登录时拉取「我的」开放问卷入口；未登录不请求（问卷填写需账号）。
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    getMeOverview()
      .then((res) => {
        if (!cancelled) setOverview(res);
      })
      .catch(() => {
        /* 问卷区加载失败不阻塞活动列表，静默降级为扫码指引 */
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  // 锚点直达（如 /activities#surveys）：数据到达后目标区块才渲染，故依赖列表就绪再滚动。
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView();
  }, [hash, activities, overview]);

  // 问卷区兜底提示：仅完全未登录时引导登录；管理端会话下不引导（单会话互斥）。
  const surveyHint = authed
    ? '当前没有可填写的问卷。'
    : role === null
      ? '登录后，您可以填写的问卷也会显示在这里。'
      : '';

  return (
    <PageLayout
      actions={
        <>
          <Link to="/" className="cc-btn cc-btn-secondary">
            返回首页
          </Link>
          <HeaderActions />
        </>
      }
      className="ccp-root"
    >
      <section id="activities" className="ccp-anchor">
        <h2 className="ccp-section-title">活动</h2>
        {activities === null && !activitiesError ? <Loading /> : null}

        {activitiesError ? (
          <>
            <p className="cc-empty">{activitiesError.message}</p>
            <Button variant="secondary" onClick={() => setTick((t) => t + 1)}>
              重试
            </Button>
          </>
        ) : null}

        {activities !== null && activities.length === 0 ? (
          <div className="ccp-empty">
            <span className="ccp-empty-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </span>
            <p className="cc-empty">暂无进行中的活动，请稍后再来。</p>
          </div>
        ) : null}

        {activities !== null && activities.length > 0 ? (
          <ul className="cc-item-list">
            {activities.map((activity) => {
              const reg = activity.registration;
              const regCopy = reg.open ? null : registrationClosedReasonCopy(reg.reason);
              return (
                <li key={activity.id} className="cc-item">
                  <div className="cc-item-head">
                    <Link to={`/a/${activity.id}`} className="cc-item-title">
                      {activity.title}
                    </Link>
                    {reg.open ? (
                      <span className="cc-tag cc-tag-success">报名中</span>
                    ) : (
                      <span className="cc-tag cc-tag-muted">
                        {activity.status === 'closed'
                          ? activityStatusLabel(activity.status)
                          : (regCopy?.title ?? '报名未开放')}
                      </span>
                    )}
                  </div>
                  <p className="cc-item-meta">
                    {formatTimeRange(activity.start_time, activity.end_time)}
                    {activity.location ? ` · ${activity.location}` : ''}
                  </p>
                  {reg.open && reg.remaining_total != null ? (
                    <p className="cc-item-meta">剩余名额：{reg.remaining_total}</p>
                  ) : null}
                  {reg.open ? (
                    <Link
                      to={`/a/${activity.id}/register`}
                      className="cc-btn cc-btn-primary cc-btn-block"
                    >
                      立即报名
                    </Link>
                  ) : (
                    <Link to={`/a/${activity.id}`} className="cc-btn cc-btn-secondary cc-btn-block">
                      查看详情
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <section id="surveys" className="ccp-anchor">
        <h2 className="ccp-section-title">问卷</h2>
        {authed && overview && overview.open_surveys.length > 0 ? (
          <ul className="cc-item-list">
            {overview.open_surveys.map(({ survey, activity_title, my_submission }) => (
              <li key={survey.id} className="cc-item">
                <div className="cc-item-head">
                  <span className="cc-item-title">{survey.title}</span>
                  {my_submission?.status === 'draft' ? (
                    <span className="cc-tag cc-tag-info">草稿待继续</span>
                  ) : null}
                </div>
                <p className="cc-item-meta">{activity_title}</p>
                <Link
                  to={`/survey/${survey.qr_token}`}
                  className="cc-btn cc-btn-primary cc-btn-block"
                >
                  {my_submission?.status === 'draft' ? '继续填写' : '去填写'}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ccp-empty">
            <span className="ccp-empty-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <p className="cc-empty">
              问卷通过活动现场的二维码进入；填写问卷需要登录参与者账号。
              {surveyHint}
            </p>
            {!authed && role === null ? (
              <div className="cc-actions">
                <Link to="/login" className="cc-btn cc-btn-primary cc-btn-block">
                  登录查看我的问卷
                </Link>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </PageLayout>
  );
}
