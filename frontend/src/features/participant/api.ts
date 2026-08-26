import { apiGet, apiPost, ApiError } from '../../shared/api/http';
import { pbClients } from '../../shared/pocketbase';
import type {
  ActivityRecord,
  ActivityRole,
  ActivityStatus,
  CheckinRecord,
  CheckinStatus,
  FieldType,
  RegistrationRecord,
  RegistrationStatus,
  RoleScope,
  SourceType,
  SubmissionStatus,
  SurveyQuestionRecord,
  SurveyStatus,
  TrainingAttendanceRecord,
} from '../../shared/api/types';

/**
 * 参与者端自定义端点封装（统一端点契约，technical-design §5.5）。
 *
 * 路径/方法/参数与后端 pb_hooks 严格一致，不得自行改名；全部业务校验在服务端，
 * 前端只做体验层预校验与状态展示（technical-design §5.5 总原则、PRD §11.2）。
 *
 * ── 响应体对接口径（V1 集成联调已逐项实跑核对，与后端 pb_hooks 实际响应一致）──
 * 1. GET /api/cc/public/activities/:id  → PublicActivityDetail【已核对】
 *    registration_fields 由服务端按活动配置解析后下发（标准字段 + 本机构自定义字段，
 *    required 为 form_config_json 数组版覆盖后的生效值；元素含 id/source_type/
 *    is_sensitive/required/options_json）。参与者对 registration_field_defs
 *    无集合读权限（见迁移 1785888360），报名字段只能经本端点获得。
 *    registration 含 open 与未开放 reason（not_started/ended/closed/full）。
 * 2. GET /api/cc/surveys/:qrToken       → SurveyMeta【已核对】
 *    { survey（含 activity_id）, activity, questions, eligible, reasons,
 *      my_submission（含 submitted_at）, my_answers? }；
 *    题目在资格全过或本人已有答卷（草稿预填/只读回看）时下发。
 * 3. 错误响应统一 { code: <http status>, message, data: { code } }【已核对】
 *    （对应后端 lib/http.pb.js jsonError；业务码经 ApiError.details.code 可读，
 *    签到分支 checkin_not_open/checkin_closed/registration_not_approved 实测可读）。
 * 4. POST /api/cc/checkin/self（body: { token }）→ SelfCheckinResult
 *    token = 活动 checkin_qr_token（扫码落地页 /checkin/:token 带入，不暴露活动 id）；
 *    幂等重复扫码返回 { checkin, already_checked_in: true }（FR-CHK-004）。
 * 5. GET /api/cc/me/overview → MeOverview【已核对】
 *    { registrations: [{ registration, activity }], open_surveys: [{ survey（含
 *    qr_token）, activity_title, my_submission }], submissions: [{ submission,
 *    survey_title, survey_qr_token, activity_title }] }；survey_qr_token 供只读页链接。
 * 6. 答卷答案出参元素统一为 { question_code, value }【已核对】
 *    （GET /api/cc/submissions/:id、surveys/:qrToken 的 my_answers、draft/submit 响应）；
 *    提交入参同为 { question_code, value }。
 * 7. GET /api/cc/public/activities → PublicActivityList（首页活动广场，未登录可看；
 *    仅 published/closed，按开始时间倒序，registration 口径同详情端点）
 */

/** 报名未开放原因（registration.open=false 时服务端给出）。 */
export type RegistrationClosedReason = 'not_started' | 'ended' | 'closed' | 'full';

/** 公开报名状态与剩余名额口径（GET /api/cc/public/activities/:id）。 */
export interface PublicRegistrationInfo {
  /** 当前是否可新提交报名（服务端综合报名开关/起止时间/名额判定）。 */
  open: boolean;
  /** open=false 时的原因：not_started 未开始 / ended 已过截止 / closed 开关关闭或活动已关闭 / full 名额已满。 */
  reason?: RegistrationClosedReason | null;
  /** 剩余名额（总/倾诉者/聆听者）；null 或缺省表示服务端未给出。 */
  remaining_total?: number | null;
  remaining_speaker?: number | null;
  remaining_listener?: number | null;
}

/**
 * 公开活动详情中的报名字段（服务端已解析的活动级生效配置）。
 * 与 RegistrationFieldDefRecord 的差异：required 为活动级生效值（required_default
 * 经 activities.form_config_json 覆盖后的结果，database-design D-3）。
 */
export interface PublicRegistrationField {
  id: string;
  field_code: string;
  field_type: FieldType;
  label: string;
  source_type: SourceType;
  is_sensitive: boolean;
  /** 活动级生效必填（服务端解析后下发）。 */
  required: boolean;
  /** 适用角色：both=两角色均作答；speaker/listener=仅对应角色报名时出现并参与校验。 */
  role_scope: RoleScope;
  options_json?: unknown;
}

/** GET /api/cc/public/activities/:id 响应。 */
export interface PublicActivityDetail {
  activity: Pick<
    ActivityRecord,
    | 'id'
    | 'title'
    | 'activity_code'
    | 'description'
    | 'location'
    | 'start_time'
    | 'end_time'
    | 'status'
    | 'capacity_total'
    | 'capacity_speaker'
    | 'capacity_listener'
  >;
  registration: PublicRegistrationInfo;
  registration_fields: PublicRegistrationField[];
}

/** 公开活动详情（FR-ACT-003：未登录可看；仅 published/closed 可见）。 */
export function getPublicActivity(activityId: string): Promise<PublicActivityDetail> {
  return apiGet(pbClients.participant, `/api/cc/public/activities/${activityId}`);
}

/** 公开活动列表项（首页活动广场；GET /api/cc/public/activities）。 */
export interface PublicActivityListItem {
  id: string;
  title: string;
  activity_code: string;
  description?: string;
  location?: string;
  start_time: string;
  end_time: string;
  status: ActivityStatus;
  capacity_total: number;
  registration: Pick<PublicRegistrationInfo, 'open' | 'reason' | 'remaining_total'>;
}

/** GET /api/cc/public/activities 响应。 */
export interface PublicActivityList {
  activities: PublicActivityListItem[];
}

/**
 * 公开活动列表（首页活动广场：未登录可看；仅 published/closed，按开始时间倒序）。
 * scope='current' 仅未结束场次、'past' 仅已结束/已关闭场次（服务端过滤，避免列表
 * 100 条上限跨口径截断往期）；不传返回全部。划分口径同 lib/activitySplit.ts。
 */
export function getPublicActivities(scope?: 'current' | 'past'): Promise<PublicActivityList> {
  return apiGet(
    pbClients.participant,
    `/api/cc/public/activities${scope ? `?scope=${scope}` : ''}`,
  );
}

/** 报名答案项（POST /api/cc/activities/:id/register 的 answers 元素）。 */
export interface RegistrationAnswerInput {
  field_def_id: string;
  value: unknown;
}

/** 参与者报名（幂等：已有有效报名则服务端返回现有记录，AC-20）。 */
export function registerForActivity(
  activityId: string,
  input: { activity_role: ActivityRole; answers: RegistrationAnswerInput[] },
): Promise<{ registration: RegistrationRecord }> {
  return apiPost(pbClients.participant, `/api/cc/activities/${activityId}/register`, input);
}

/** 「我的」中心活动摘要。 */
export interface MeActivitySummary {
  id: string;
  title: string;
  activity_code: string;
  start_time: string;
  end_time: string;
  location?: string;
  status: ActivityStatus;
}

/** 「我的」中心报名条目（本人报名 + 活动信息，FR-PAR-001）。 */
export interface MeRegistrationItem {
  registration: RegistrationRecord;
  activity: MeActivitySummary;
}

/** 「我的」中心开放问卷入口（FR-PAR-002：已按登录/审核通过/角色匹配/开放中过滤）。 */
export interface MeSurveyEntry {
  survey: {
    id: string;
    title: string;
    role_scope: RoleScope;
    status: SurveyStatus;
    qr_token: string;
  };
  activity_title: string;
  /** 已有答卷（草稿可继续填写）；null = 未开始。 */
  my_submission: { id: string; status: SubmissionStatus } | null;
}

/** 「我的」中心已提交答卷索引（答案只读，FR-SUR-009）。 */
export interface MeSubmissionItem {
  submission: { id: string; status: SubmissionStatus; submitted_at?: string };
  survey_title: string;
  /** 只读答案页复用问卷落地页路由 /survey/:qrToken。 */
  survey_qr_token: string;
  activity_title: string;
}

/** GET /api/cc/me/overview 响应。 */
export interface MeOverview {
  registrations: MeRegistrationItem[];
  open_surveys: MeSurveyEntry[];
  submissions: MeSubmissionItem[];
  /** 是否存在已通过的聆听者报名（控制「聆听者培训」入口显隐）。 */
  has_approved_listener_registration: boolean;
}

/** 「我的」中心总览（FR-PAR-001/002）。 */
export function getMeOverview(): Promise<MeOverview> {
  return apiGet(pbClients.participant, '/api/cc/me/overview');
}

/** POST /api/cc/checkin/self 响应。 */
export interface SelfCheckinResult {
  checkin: CheckinRecord;
  /** true = 幂等返回的既有签到（FR-CHK-004 重复扫码不报错不新建）。 */
  already_checked_in?: boolean;
}

/**
 * 自助签到（幂等：重复扫码返回已有记录，FR-CHK-004、AC-09/AC-20）。
 * token 为活动 checkin_qr_token（由 /checkin/:token 扫码落地页带入，不暴露活动 id）。
 * 失败时 ApiError.details.code 预期取值：checkin_not_open（未开放）/
 * checkin_closed（已结束）/ registration_not_approved（报名未通过）。
 */
export function selfCheckin(token: string): Promise<SelfCheckinResult> {
  return apiPost(pbClients.participant, '/api/cc/checkin/self', { token });
}

/** 「我的培训」列表项（GET /api/cc/me/trainings 的 trainings 元素）。 */
export interface MyTrainingItem {
  id: string;
  title: string;
  training_code: string;
  description?: string;
  location?: string;
  start_time: string;
  end_time: string;
  status: 'published' | 'closed';
  /** 本人签到记录（revoked 视为未参加）；null = 未参加。 */
  my_attendance: { status: CheckinStatus; checked_in_at: string } | null;
}

/** GET /api/cc/me/trainings 响应。 */
export interface MyTrainingsOverview {
  /** 是否有已通过的聆听者报名（无则培训功能不开放）。 */
  eligible: boolean;
  /** 是否已完成培训（存在任一 valid 签到，账号级标记，全平台通用）。 */
  trained: boolean;
  /** 全部已发布培训 + 本人有记录的已关闭培训。 */
  trainings: MyTrainingItem[];
}

/** 我的培训总览（需参与者登录；eligible=false 时培训列表为空）。 */
export function getMyTrainings(): Promise<MyTrainingsOverview> {
  return apiGet(pbClients.participant, '/api/cc/me/trainings');
}

/** POST /api/cc/training-checkin/self 响应（照搬活动签到形态）。 */
export interface SelfTrainingCheckinResult {
  attendance: TrainingAttendanceRecord;
  /** true = 幂等返回的既有签到（重复扫码不报错不新建）。 */
  already_checked_in?: boolean;
}

/**
 * 培训自助签到（幂等，同活动签到语义）。
 * token 为培训 checkin_qr_token（由 /training-checkin/:token 扫码落地页带入）。
 * 失败时 ApiError.details.code 预期取值：checkin_not_open（未开放）/
 * checkin_closed（已结束）/ listener_not_approved（聆听者报名未通过）。
 * 响应签到记录键名以 attendance 为准，兼容服务端沿用活动签到形态的 checkin 键。
 */
export async function selfTrainingCheckin(token: string): Promise<SelfTrainingCheckinResult> {
  const res = await apiPost<{
    attendance?: TrainingAttendanceRecord;
    checkin?: TrainingAttendanceRecord;
    already_checked_in?: boolean;
  }>(pbClients.participant, '/api/cc/training-checkin/self', { token });
  const attendance = res.attendance ?? res.checkin;
  if (!attendance) {
    throw new ApiError('服务响应格式异常，请稍后重试', 0, 'INVALID_RESPONSE');
  }
  return { attendance, already_checked_in: res.already_checked_in === true };
}

/** 问卷资格校验失败原因（GET /api/cc/surveys/:qrToken 的 reasons 元素，FR-SUR-006）。 */
export type SurveyIneligibleReason =
  'not_logged_in' | 'not_approved' | 'role_mismatch' | 'not_open' | 'ended';

/** 题目答案项（服务端出参形态：{ question_code, value }，已实跑核对）。 */
export interface SurveyAnswerItem {
  question_code: string;
  value: unknown;
}

/** 服务端 hooks 下发的问卷题目（公开裁剪形态：无 created/updated 系统字段）。 */
export type PublicSurveyQuestion = Omit<SurveyQuestionRecord, 'created' | 'updated'>;

/** GET /api/cc/surveys/:qrToken 响应：问卷元信息 + 资格校验结果。 */
export interface SurveyMeta {
  survey: {
    id: string;
    activity_id: string;
    title: string;
    survey_code: string;
    status: SurveyStatus;
    role_scope: RoleScope;
  };
  activity: { id: string; title: string };
  /** 按 order_index 排序的题目（资格全过或本人已有答卷时下发，否则为空数组）。 */
  questions: PublicSurveyQuestion[];
  /** 四条件（登录/报名已通过/角色匹配/开放中）校验结果。 */
  eligible: boolean;
  /** eligible=false 时的失败原因列表（分因展示）。 */
  reasons?: SurveyIneligibleReason[];
  /** 本人已有答卷：draft 可继续、submitted 只读。 */
  my_submission: { id: string; status: SubmissionStatus; submitted_at?: string } | null;
  /** 本人已有答案（草稿预填 / 已提交只读展示）。 */
  my_answers?: SurveyAnswerItem[];
}

/** 问卷元信息与资格校验（FR-SUR-006）。 */
export function getSurveyByToken(qrToken: string): Promise<SurveyMeta> {
  return apiGet(pbClients.participant, `/api/cc/surveys/${qrToken}`);
}

/** 问卷答案提交项（draft/submit 的 answers 元素；value 为题目答案原始值）。 */
export interface SurveyAnswerInput {
  question_code: string;
  value: unknown;
}

/** 保存草稿（FR-SUR-008：草稿可继续编辑）。 */
export function saveSurveyDraft(
  activitySurveyId: string,
  answers: SurveyAnswerInput[],
): Promise<{ submission: { id: string; status: SubmissionStatus } }> {
  return apiPost(pbClients.participant, `/api/cc/activity-surveys/${activitySurveyId}/draft`, {
    answers,
  });
}

/** 正式提交（锁定 + 幂等：重复提交返回原记录，FR-SUR-008、AC-12/AC-20）。 */
export function submitSurvey(
  activitySurveyId: string,
  answers: SurveyAnswerInput[],
): Promise<{ submission: { id: string; status: SubmissionStatus; submitted_at?: string } }> {
  return apiPost(pbClients.participant, `/api/cc/activity-surveys/${activitySurveyId}/submit`, {
    answers,
  });
}

/** GET /api/cc/submissions/:id 响应（本人已提交答案只读，FR-SUR-009）。 */
export interface SubmissionDetail {
  submission: { id: string; status: SubmissionStatus; submitted_at?: string };
  survey_title: string;
  activity_title?: string;
  questions: PublicSurveyQuestion[];
  answers: SurveyAnswerItem[];
}

/** 本人已提交答卷只读详情。 */
export function getSubmission(submissionId: string): Promise<SubmissionDetail> {
  return apiGet(pbClients.participant, `/api/cc/submissions/${submissionId}`);
}

/**
 * 提取规范化错误中的业务码（后端 jsonError 放入 data.code）。
 * 用于签到/问卷等需要按失败原因分开展示的场景。
 */
export function bizCodeOf(err: ApiError): string | null {
  const details = err.details;
  if (!details) return null;
  const code = details['code'] ?? details['error'];
  return typeof code === 'string' ? code : null;
}

/** 是否为 401 未授权（token 过期等）：页面据此引导重新登录。 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** 报名状态（重导出，页面展示用）。 */
export type { RegistrationStatus };
