import type { PublicActivitySummary } from '../../../public/types';
import { NavAnchor } from '../../../public/nav';
import { activityStatusLabel, formatTimeRange, registrationClosedReasonCopy } from '../lib/status';

/**
 * 活动卡片（SSR 安全纯组件；首页与活动列表页共用，2026-08 UI 重构）：
 * 可选封面占位 + 标题 + 时间地点 + 报名状态 tag + CTA。
 * 封面为图片占位块，待活动照片素材到位后替换。
 */
export function ActivityCard({
  activity,
  showCover = true,
}: {
  activity: PublicActivitySummary;
  showCover?: boolean;
}) {
  const reg = activity.registration;
  const regCopy = reg.open ? null : registrationClosedReasonCopy(reg.reason);
  return (
    <li className="ccp-card">
      {showCover ? (
        <div className="ccp-photo ccp-photo-card" aria-hidden="true">
          活动照片
        </div>
      ) : null}
      <div className="ccp-card-body">
        <div className="cc-item-head">
          <NavAnchor href={`/a/${activity.id}`} className="cc-item-title">
            {activity.title}
          </NavAnchor>
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
          <NavAnchor
            href={`/a/${activity.id}/register`}
            className="cc-btn cc-btn-primary cc-btn-block"
          >
            立即报名
          </NavAnchor>
        ) : (
          <NavAnchor href={`/a/${activity.id}`} className="cc-btn cc-btn-secondary cc-btn-block">
            查看详情
          </NavAnchor>
        )}
      </div>
    </li>
  );
}
