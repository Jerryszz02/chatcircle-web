import { useEffect, useState } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { currentRole, participantAuth } from '../../../shared/auth';
import { useSessionSnapshot } from '../../../shared/session';
import { ClientOnly } from '../../../public/ClientOnly';
import { toPublicLoadError } from '../../../public/loadError';
import type { PublicLoadError } from '../../../public/types';
import {
  getMeOverview,
  getPublicActivities,
  type MeOverview,
  type PublicActivityListItem,
} from '../api';
import { AccountActions } from '../components/AccountActions';
import { ActivitiesPageView, SurveysGuide } from './ActivitiesPageView';

/**
 * 活动与问卷页容器（/activities，未登录可看）：hook 取数后渲染 ActivitiesPageView。
 * 现有活动（公开活动列表中尚未结束的场次）+ 问卷入口（登录后显示本人可填问卷，
 * 未登录显示扫码指引）。浏览活动不需要账号；报名与填写问卷时在对应链路内完成
 * 手机号认证。问卷也可直接扫描活动现场二维码进入（/survey/:qrToken）。
 * 已结束/已关闭的场次归入往期活动页（/activities/past），判定口径见 lib/activitySplit.ts。
 */

/**
 * 问卷区会话敏感部分（客户端岛屿）：仅浏览器挂载后渲染
 * （容器经 ClientOnly 注入，服务端输出为 SurveysGuide 匿名指引态）。
 * 登录后拉取「我的」开放问卷入口；加载失败静默降级为指引态。
 */
export function AuthedSurveys() {
  // 订阅会话变化：登录/登出后问卷区即时刷新
  useSessionSnapshot();
  const authed = participantAuth.isValid();
  // 当前有效会话角色（单会话互斥，见 shared/auth.ts）：仅用于问卷区兜底提示。
  const role = currentRole();
  const [overview, setOverview] = useState<MeOverview | null>(null);

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

  if (authed && overview && overview.open_surveys.length > 0) {
    return (
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
            <a href={`/survey/${survey.qr_token}`} className="cc-btn cc-btn-primary cc-btn-block">
              {my_submission?.status === 'draft' ? '继续填写' : '去填写'}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  // 兜底提示：仅完全未登录时引导登录；管理端会话下不引导（单会话互斥）。
  if (authed) return <SurveysGuide hint="当前没有可填写的问卷。" showLogin={false} />;
  if (role === null) {
    return <SurveysGuide hint="登录后，您可以填写的问卷也会显示在这里。" showLogin />;
  }
  return <SurveysGuide hint="" showLogin={false} />;
}

export function ActivitiesPage() {
  const [activities, setActivities] = useState<PublicActivityListItem[] | null>(null);
  const [activitiesError, setActivitiesError] = useState<PublicLoadError | null>(null);
  const [tick, setTick] = useState(0);
  // 「现有活动」判定基准时刻：挂载时固定一次，避免重渲染间漂移
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    getPublicActivities('current')
      .then((res) => {
        if (cancelled) return;
        setActivities(res.activities);
        // 重试成功后清除此前的错误提示与重试按钮
        setActivitiesError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setActivitiesError(toPublicLoadError(normalizeApiError(err)));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <ActivitiesPageView
      now={now}
      activities={activities}
      activitiesError={activitiesError}
      onRetryActivities={() => setTick((t) => t + 1)}
      surveysSlot={
        <ClientOnly
          placeholder={<SurveysGuide hint="登录后，您可以填写的问卷也会显示在这里。" showLogin />}
        >
          <AuthedSurveys />
        </ClientOnly>
      }
      actions={<AccountActions />}
    />
  );
}
