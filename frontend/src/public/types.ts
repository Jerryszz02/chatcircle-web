import type { ActivityStatus } from '../shared/api/types';

/**
 * 公开页 SSR 数据契约（src/public 各模块与 server/ 共用的纯类型，无运行时依赖）。
 *
 * 这里定义的 DTO 是「允许进入公开 HTML 的字段白名单」：后端记录中的
 * registration_fields（报名编辑器数据）、created_by/updated_by（归因字段）、
 * 手机号等一律不得出现在这些类型里；server/public/data.ts 的 mapper 负责收窄。
 */

/** 公开活动列表项（首页/现有活动/往期活动卡片）。 */
export interface PublicActivitySummary {
  id: string;
  title: string;
  activity_code: string;
  description?: string;
  location?: string;
  start_time: string;
  end_time: string;
  status: ActivityStatus;
  capacity_total: number;
  registration: {
    open: boolean;
    reason?: 'not_started' | 'ended' | 'closed' | 'full' | null;
    remaining_total?: number | null;
  };
}

/** 公开活动详情（不含 registration_fields——报名编辑器数据不进公开 HTML）。 */
export interface PublicActivityDetailView {
  activity: {
    id: string;
    title: string;
    activity_code: string;
    description?: string;
    location?: string;
    start_time: string;
    end_time: string;
    status: ActivityStatus;
    capacity_total: number;
    capacity_speaker?: number;
    capacity_listener?: number;
  };
  registration: {
    open: boolean;
    reason?: 'not_started' | 'ended' | 'closed' | 'full' | null;
    remaining_total?: number | null;
    remaining_speaker?: number | null;
    remaining_listener?: number | null;
  };
}

/** 公开推文（字段白名单；不含 status/created_by/updated_by 与系统字段）。
 * 列表卡片经服务端 fields 收窄、不含 body_md（避免列表/sitemap 响应越过大小上限）；
 * body_md 仅详情端点下发。 */
export interface PublicPostView {
  id: string;
  title: string;
  summary?: string;
  cover?: string;
  body_md?: string;
  external_url?: string;
  is_pinned: boolean;
  published_at?: string;
}

/** 公开页数据加载错误（view 只认这个口径；由容器/服务端把各类错误收窄而来）。 */
export interface PublicLoadError {
  status: number;
  message: string;
}

/**
 * 公开页首屏数据（判别联合，kind 与 public/routes.ts 的路由 id 一一对应）。
 * 经 __CC_PUBLIC_DATA__ 内嵌进 HTML，供浏览器 hydrate 首帧复用（不得 refetch）。
 */
export type PublicPageData =
  | {
      kind: 'home';
      generatedAt: string;
      activities: PublicActivitySummary[] | null;
      activitiesError: PublicLoadError | null;
      posts: PublicPostView[] | null;
      postsError: PublicLoadError | null;
    }
  | { kind: 'about'; generatedAt: string }
  | { kind: 'privacy'; generatedAt: string }
  | {
      kind: 'activities';
      generatedAt: string;
      activities: PublicActivitySummary[] | null;
      activitiesError: PublicLoadError | null;
    }
  | {
      kind: 'past';
      generatedAt: string;
      posts: PublicPostView[] | null;
      postsError: PublicLoadError | null;
    }
  | { kind: 'activity'; generatedAt: string; detail: PublicActivityDetailView }
  | { kind: 'post'; generatedAt: string; post: PublicPostView };
