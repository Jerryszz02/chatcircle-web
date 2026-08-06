import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { currentRole, participantAuth } from '../../../shared/auth';
import { Button, Loading, PageLayout } from '../../../shared/ui';
import {
  getMeOverview,
  getPublicActivities,
  type MeOverview,
  type PublicActivityListItem,
} from '../api';
import { activityStatusLabel, formatTimeRange, registrationClosedReasonCopy } from '../lib/status';
import { ProjectIntro } from '../components/ProjectIntro';

/**
 * 首页（/，未登录可看）：
 * 活动广场（公开活动列表，点击进详情/报名）、登录入口、问卷入口。
 * 浏览活动不需要账号；报名与填写问卷时在对应链路内登录/自动注册（FR-AUTH-001）。
 * 问卷也可直接扫描活动现场二维码进入（/survey/:qrToken，未登录由守卫引导登录后回跳）。
 * 右上角「登录」聚合参与者/机构管理员/超级管理员三类登录入口。
 */
export function HomePage() {
  const authed = participantAuth.isValid();
  // 当前有效会话角色（单会话互斥，见 shared/auth.ts）：决定顶部入口指向哪个端。
  const role = currentRole();
  const [activities, setActivities] = useState<PublicActivityListItem[] | null>(null);
  const [activitiesError, setActivitiesError] = useState<ApiError | null>(null);
  const [overview, setOverview] = useState<MeOverview | null>(null);
  const [tick, setTick] = useState(0);

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
        /* 问卷区加载失败不阻塞首页主体，静默降级为扫码指引 */
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  // 问卷区兜底提示：仅完全未登录时引导登录；管理端会话下不引导（单会话互斥）。
  const surveyHint = authed
    ? '当前没有可填写的问卷。'
    : role === null
      ? '登录后，您可以填写的问卷也会显示在这里。'
      : '';

  const headerActions =
    role === 'participant' ? (
      <Link to="/me" className="cc-btn cc-btn-secondary">
        我的中心
      </Link>
    ) : role === 'admin' ? (
      <Link to="/admin/activities" className="cc-btn cc-btn-secondary">
        机构管理面板
      </Link>
    ) : role === 'super' ? (
      <Link to="/super/dashboard" className="cc-btn cc-btn-secondary">
        超级管理面板
      </Link>
    ) : (
      <LoginMenu />
    );

  return (
    <PageLayout actions={headerActions} className="ccp-root">
      <section className="ccp-hero" aria-label="平台介绍">
        <div className="ccp-hero-rings" aria-hidden="true">
          <span />
          <span />
        </div>
        <p className="ccp-hero-eyebrow">参与者端</p>
        <h1 className="ccp-hero-title">Chat Circles</h1>
        <p className="ccp-hero-sub">
          安全表达，认真倾听，形成连接。浏览活动无需账号；报名活动、填写问卷时需要登录，
          报名过程中输入用户名和密码即可自动注册。
        </p>
      </section>

      {/* 页内锚点导航：项目介绍区块 + 活动/问卷（吸顶，样式见 participant.css .ccp-nav） */}
      <nav className="ccp-nav" aria-label="页面导航">
        <a href="#challenge">挑战</a>
        <a href="#programme">计划</a>
        <a href="#impact">影响</a>
        <a href="#measurement">成效评估</a>
        <a href="#partners">合作伙伴</a>
        <a href="#activities">活动</a>
        <a href="#surveys">问卷</a>
      </nav>

      <ProjectIntro />

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

/**
 * 顶部「登录」入口：聚合参与者/机构管理员/超级管理员三类登录。
 * 点击展开菜单，点击外部或按 Escape 收起。
 */
function LoginMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="ccp-login-menu" ref={rootRef}>
      <button
        type="button"
        className="cc-btn cc-btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        登录
      </button>
      {open ? (
        <div className="ccp-login-menu-list" role="menu" aria-label="选择登录身份">
          <Link role="menuitem" to="/login" onClick={() => setOpen(false)}>
            参与者登录
          </Link>
          <Link role="menuitem" to="/admin/login" onClick={() => setOpen(false)}>
            机构管理员登录
          </Link>
          <Link role="menuitem" to="/super/login" onClick={() => setOpen(false)}>
            超级管理员登录
          </Link>
        </div>
      ) : null}
    </div>
  );
}
