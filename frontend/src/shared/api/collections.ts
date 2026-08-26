import type PocketBase from 'pocketbase';
import type { RecordService } from 'pocketbase';
import { pbForRole, type Role } from '../pocketbase';
import type {
  ActivityApprovalRecord,
  ActivityRecord,
  ActivitySurveyRecord,
  AdminAccountRecord,
  AdminInviteRecord,
  AnswerRecord,
  AuditLogRecord,
  CheckinRecord,
  CheckinSessionRecord,
  ExportJobRecord,
  OrganizationRecord,
  ParticipantAccountRecord,
  PostRecord,
  RegistrationAnswerRecord,
  RegistrationFieldDefRecord,
  RegistrationRecord,
  SubmissionRecord,
  SurveyQuestionRecord,
  SurveyTemplateRecord,
  SurveyTemplateVersionRecord,
  TrainingAttendanceRecord,
  TrainingCheckinSessionRecord,
  TrainingRecord,
} from './types';

/**
 * 各集合的类型化 pb.collection() 封装（database-design §5.2，另含培训体系、posts 等改版新增集合）。
 *
 * 用法：
 *   import { collectionsForRole } from '@/shared/api';
 *   const cc = collectionsForRole('admin');
 *   const list = await cc.activities.getList(1, 20, { filter: 'status="published"' });
 *
 * 权限提醒：collection API rules 在服务端强制机构隔离与「仅本人」过滤
 * （technical-design §5.5），前端封装不做任何权限判断；越权请求由服务端拒绝。
 * 自定义业务端点（状态迁移、导出、看板等）走 shared/api/http 的 apiPost/apiGet。
 */

/** 集合名常量，避免各处硬编码字符串。 */
export const COLLECTION_NAMES = {
  organizations: 'organizations',
  adminInvites: 'admin_invites',
  adminAccounts: 'admin_accounts',
  participantAccounts: 'participant_accounts',
  activities: 'activities',
  activityApprovals: 'activity_approvals',
  registrationFieldDefs: 'registration_field_defs',
  registrations: 'registrations',
  registrationAnswers: 'registration_answers',
  checkinSessions: 'checkin_sessions',
  checkins: 'checkins',
  surveyTemplates: 'survey_templates',
  surveyTemplateVersions: 'survey_template_versions',
  activitySurveys: 'activity_surveys',
  surveyQuestions: 'survey_questions',
  submissions: 'submissions',
  answers: 'answers',
  exportJobs: 'export_jobs',
  auditLogs: 'audit_logs',
  trainings: 'trainings',
  trainingCheckinSessions: 'training_checkin_sessions',
  trainingAttendances: 'training_attendances',
  posts: 'posts',
} as const;

/** 某个 client 下全部集合的类型化访问入口。 */
export interface TypedCollections {
  organizations: RecordService<OrganizationRecord>;
  adminInvites: RecordService<AdminInviteRecord>;
  adminAccounts: RecordService<AdminAccountRecord>;
  participantAccounts: RecordService<ParticipantAccountRecord>;
  activities: RecordService<ActivityRecord>;
  activityApprovals: RecordService<ActivityApprovalRecord>;
  registrationFieldDefs: RecordService<RegistrationFieldDefRecord>;
  registrations: RecordService<RegistrationRecord>;
  registrationAnswers: RecordService<RegistrationAnswerRecord>;
  checkinSessions: RecordService<CheckinSessionRecord>;
  checkins: RecordService<CheckinRecord>;
  surveyTemplates: RecordService<SurveyTemplateRecord>;
  surveyTemplateVersions: RecordService<SurveyTemplateVersionRecord>;
  activitySurveys: RecordService<ActivitySurveyRecord>;
  surveyQuestions: RecordService<SurveyQuestionRecord>;
  submissions: RecordService<SubmissionRecord>;
  answers: RecordService<AnswerRecord>;
  exportJobs: RecordService<ExportJobRecord>;
  auditLogs: RecordService<AuditLogRecord>;
  trainings: RecordService<TrainingRecord>;
  trainingCheckinSessions: RecordService<TrainingCheckinSessionRecord>;
  trainingAttendances: RecordService<TrainingAttendanceRecord>;
  posts: RecordService<PostRecord>;
}

/** 按 client 构建类型化集合访问入口（每次调用新建轻量 RecordService，无状态）。 */
export function collections(client: PocketBase): TypedCollections {
  return {
    organizations: client.collection<OrganizationRecord>(COLLECTION_NAMES.organizations),
    adminInvites: client.collection<AdminInviteRecord>(COLLECTION_NAMES.adminInvites),
    adminAccounts: client.collection<AdminAccountRecord>(COLLECTION_NAMES.adminAccounts),
    participantAccounts: client.collection<ParticipantAccountRecord>(
      COLLECTION_NAMES.participantAccounts,
    ),
    activities: client.collection<ActivityRecord>(COLLECTION_NAMES.activities),
    activityApprovals: client.collection<ActivityApprovalRecord>(
      COLLECTION_NAMES.activityApprovals,
    ),
    registrationFieldDefs: client.collection<RegistrationFieldDefRecord>(
      COLLECTION_NAMES.registrationFieldDefs,
    ),
    registrations: client.collection<RegistrationRecord>(COLLECTION_NAMES.registrations),
    registrationAnswers: client.collection<RegistrationAnswerRecord>(
      COLLECTION_NAMES.registrationAnswers,
    ),
    checkinSessions: client.collection<CheckinSessionRecord>(COLLECTION_NAMES.checkinSessions),
    checkins: client.collection<CheckinRecord>(COLLECTION_NAMES.checkins),
    surveyTemplates: client.collection<SurveyTemplateRecord>(COLLECTION_NAMES.surveyTemplates),
    surveyTemplateVersions: client.collection<SurveyTemplateVersionRecord>(
      COLLECTION_NAMES.surveyTemplateVersions,
    ),
    activitySurveys: client.collection<ActivitySurveyRecord>(COLLECTION_NAMES.activitySurveys),
    surveyQuestions: client.collection<SurveyQuestionRecord>(COLLECTION_NAMES.surveyQuestions),
    submissions: client.collection<SubmissionRecord>(COLLECTION_NAMES.submissions),
    answers: client.collection<AnswerRecord>(COLLECTION_NAMES.answers),
    exportJobs: client.collection<ExportJobRecord>(COLLECTION_NAMES.exportJobs),
    auditLogs: client.collection<AuditLogRecord>(COLLECTION_NAMES.auditLogs),
    trainings: client.collection<TrainingRecord>(COLLECTION_NAMES.trainings),
    trainingCheckinSessions: client.collection<TrainingCheckinSessionRecord>(
      COLLECTION_NAMES.trainingCheckinSessions,
    ),
    trainingAttendances: client.collection<TrainingAttendanceRecord>(
      COLLECTION_NAMES.trainingAttendances,
    ),
    posts: client.collection<PostRecord>(COLLECTION_NAMES.posts),
  };
}

/** 按角色取对应 client 的类型化集合访问入口（自动携带该角色会话）。 */
export function collectionsForRole(role: Role): TypedCollections {
  return collections(pbForRole(role));
}
