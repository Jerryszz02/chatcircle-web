import type {
  ActivityRole,
  ActivityStatus,
  RegistrationStatus,
} from '../../../shared/api/types';
import { bizCodeOf, type RegistrationClosedReason, type SurveyIneligibleReason } from '../api';
import { ApiError } from '../../../shared/api/http';

/**
 * 参与者端状态展示分支（状态机口径：database-design §5.5、PRD §4）。
 * 所有分支文案集中在此，页面只消费本模块的 view 模型，便于单测覆盖全部分支。
 */

/** 状态标签色调（对应 participant.css 的 .cc-tag-* 类）。 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'muted' | 'info';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** 状态说明（报名状态页向参与者展示的提示）。 */
  hint: string;
}

/** 报名 4 态展示元（PRD §4.4；待审核只读并提示联系管理员，FR-REG-004）。 */
export function registrationStatusMeta(status: RegistrationStatus): StatusMeta {
  switch (status) {
    case 'pending':
      return {
        label: '待审核',
        tone: 'warning',
        hint: '报名已提交，等待机构管理员审核。提交后不能自行修改或取消，如需调整请联系机构管理员。',
      };
    case 'approved':
      return {
        label: '已通过',
        tone: 'success',
        hint: '报名已通过，请按活动时间参加；现场签到与问卷填写以本账号为准。',
      };
    case 'rejected':
      return {
        label: '已拒绝',
        tone: 'danger',
        hint: '报名未通过审核。如有疑问请联系机构管理员。',
      };
    case 'cancelled':
      return {
        label: '已取消',
        tone: 'muted',
        hint: '报名已被管理员取消。如需恢复请联系机构管理员。',
      };
  }
}

export function activityRoleLabel(role: ActivityRole): string {
  return role === 'speaker' ? '倾诉者' : '聆听者';
}

/** 活动状态短标签（「我的」中心列表展示用，PRD §4.3）。 */
export function activityStatusLabel(status: ActivityStatus): string {
  switch (status) {
    case 'draft':
      return '草稿';
    case 'pending_review':
      return '待平台审核';
    case 'rejected':
      return '已驳回';
    case 'published':
      return '已发布';
    case 'closed':
      return '已关闭';
    case 'taken_down':
      return '已下架';
    case 'archived':
      return '已归档';
  }
}

/** 报名未开放原因文案（FR-ACT-005/007）。 */
export function registrationClosedReasonCopy(reason: RegistrationClosedReason | null | undefined): {
  title: string;
  detail: string;
} {
  switch (reason) {
    case 'not_started':
      return { title: '报名尚未开始', detail: '报名还没有开始，请留意活动时间，稍后再来。' };
    case 'ended':
      return { title: '报名已截止', detail: '本活动报名已截止，感谢关注。' };
    case 'full':
      return { title: '名额已满', detail: '本活动名额已满，暂时无法报名。' };
    case 'closed':
    default:
      return { title: '报名未开放', detail: '本活动当前不接受报名。' };
  }
}

/** 问卷资格失败分因展示（FR-SUR-006 四条件缺一即拒）。 */
export function surveyIneligibleCopy(reason: SurveyIneligibleReason | string): {
  title: string;
  detail: string;
} {
  switch (reason) {
    case 'not_logged_in':
      return { title: '请先登录', detail: '填写问卷需要先登录参与者账号。' };
    case 'not_approved':
      return {
        title: '报名未通过审核',
        detail: '只有报名已通过的活动才能填写问卷，请先在「我的」中心确认审核结果。',
      };
    case 'role_mismatch':
      return {
        title: '本问卷不适用于您的角色',
        detail: '本问卷仅面向特定活动角色（倾诉者 / 聆听者）开放。',
      };
    case 'not_open':
      return { title: '问卷尚未开放', detail: '问卷还没有开放填写，请留意机构通知，稍后再来。' };
    case 'ended':
      return { title: '问卷已结束', detail: '本问卷已结束填写，感谢参与。' };
    default:
      return { title: '暂不能填写', detail: '当前无法填写本问卷。' };
  }
}

/** 签到失败展示（POST /api/cc/checkin/self 的错误码映射，FR-CHK-002/003）。 */
export function checkinFailureCopy(err: ApiError): { title: string; detail: string } {
  switch (bizCodeOf(err)) {
    case 'checkin_not_open':
      return { title: '签到未开放', detail: '现场签到还没有开放，请按工作人员指引操作。' };
    case 'checkin_closed':
      return { title: '签到已结束', detail: '本场签到已结束。如需补签请联系现场工作人员。' };
    case 'registration_not_approved':
      return {
        title: '报名未通过审核',
        detail: '只有报名已通过才能签到。您可以在「我的」中心查看报名审核结果。',
      };
    default:
      return { title: '签到失败', detail: err.message || '签到未完成，请稍后重试。' };
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * PocketBase 日期（'YYYY-MM-DD HH:mm:ss.sssZ'）转本地展示 'YYYY-MM-DD HH:mm'。
 * 导出/界面时区口径属待确认项（technical-design「待确认」#15），界面先按设备本地时区展示。
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 活动起止时间展示。 */
export function formatTimeRange(start: string | null | undefined, end: string | null | undefined): string {
  return `${formatDateTime(start)} 至 ${formatDateTime(end)}`;
}
