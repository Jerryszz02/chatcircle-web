// Chat Circles E2E 最小 fixture（test-plan §7 的 E2E 子集）。
//
// TODO(待统一)：backend/scripts/ 下的标准种子脚本目前尚未就绪；本文件以
// 「SQL 直插模板 + HTTP 真实 API 造业务数据」自造最小 fixture。
// 标准种子脚本落地后，本文件应改为调用它，仅保留 E2E 专属断言数据（固定用户名/答案文案）。
//
// fixture 不含真实个人信息（test-plan §7：敏感字段使用明显伪造值）。
import { spawnSync } from 'node:child_process';

// ---- 固定断言数据（测试与种子共用；全新库每次重建，固定值不冲突）----
export const FIXTURE = {
  orgName: 'E2E 测试机构',
  adminUsername: 'e2e_admin',
  adminPassword: 'e2e_admin_pass_123',
  adminEmail: 'e2e_admin@e2e.cc.local', // 2026-08 改版：管理员注册必填邮箱（AC-24）
  participantUsername: 'e2e_user1',
  participantPassword: 'e2e_user_pass_1',
  participantPhone: '13800003001',
  phoneCode: '246810',
  activityTitle: 'E2E 八月倾诉茶话会',
  surveyTitle: 'E2E 活动后问卷',
  // 培训链路 fixture（training-flow.spec.ts）：
  // 资格报名挂在独立第二活动上，避免污染主链路活动的审核列表断言（toHaveCount(1)）。
  qualActivityTitle: 'E2E 培训资格活动',
  trainingTitle: 'E2E 聆听者培训八月场',
  listenerUsername: 'e2e_listener1', // 已有 approved 聆听者报名（培训签到资格，账号级）
  listenerPassword: 'e2e_lis_pass_1',
  listenerPhone: '13800003002',
  outsiderUsername: 'e2e_user2', // 仅有 approved 倾诉者报名，无聆听者资格（负向用例）
  outsiderPassword: 'e2e_user_pass_2',
  outsiderPhone: '13800003003',
  listenerNickname: '小听',
  outsiderNickname: '小外',
  answers: {
    nickname: '阿一',
    age: '26',
    wechat: 'secret_wx_001', // 敏感报名字段：普通导出必须过滤
    mood: '4', // 敏感问卷题（MOOD，模板内 is_sensitive）：普通导出必须过滤
    sat: 'good',
    satLabel: '满意',
    note: '很有收获',
  },
};

/** ISO Date → PocketBase 日期时间格式。 */
function pbTime(date) {
  return date.toISOString().replace('T', ' ');
}

/**
 * 标准问卷模板 + 版本 SQL 直插。
 * 原因：survey_templates.current_version_id 为必填循环引用（迁移 12 注释），
 * 集合 API 无法创建模板；与联调期 /tmp/cc_reset.sh 同一份 fixture。
 * 模板 3 题：MOOD(scale_1_5, 敏感, 锁定) / SAT(单选) / NOTE(多行文本)。
 */
export function seedTemplatesSql(dbPath) {
  const now = pbTime(new Date());
  const schema = JSON.stringify({
    questions: [
      { question_code: 'MOOD', question_type: 'scale_1_5', title: '最近一周情绪状态', required: true, locked: true, is_sensitive: true, order_index: 1 },
      { question_code: 'SAT', question_type: 'single_choice', title: '整体满意度', required: true, order_index: 2, options: [{ value: 'good', label: '满意' }, { value: 'ok', label: '一般' }] },
      { question_code: 'NOTE', question_type: 'text_long', title: '想说的话', required: false, order_index: 3 },
    ],
  });
  const sqls = [
    `INSERT INTO survey_templates (id, template_code, name, description, status, current_version_id, created, updated) VALUES ('tplalpha0000001', 'PARTICIPANT_POST_V1', '活动后问卷 V1', '', 'active', 'veralpha0000001', '${now}', '${now}');`,
    `INSERT INTO survey_template_versions (id, template_id, version, schema_json, published_at, published_by, created, updated) VALUES ('veralpha0000001', 'tplalpha0000001', 1, '${schema}', '2026-08-01 00:00:00.000Z', 'superfixture000', '${now}', '${now}');`,
  ];
  for (const sql of sqls) {
    const res = spawnSync('sqlite3', [dbPath, sql]);
    if (res.status !== 0) {
      throw new Error(`模板 fixture SQL 失败：${String(res.stderr)}`);
    }
  }
}

/** 简单 JSON API 调用；非 2xx 抛错并带响应体。 */
async function call(method, url, body, token) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  if (!res.ok) {
    throw new Error(`fixture API 失败 ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

/**
 * 业务 fixture（全部走真实 API，与联调脚本 cc_e2e.py 的 A/B/C 段一致）：
 * 机构（发布直发、允许敏感导出）→ 3 个标准报名字段（含 1 个敏感字段）
 * → 邀请码 → 管理员注册 → 创建活动（报名窗口覆盖当前时刻）→ 直接发布。
 * 返回测试所需的 id 与凭据。
 */
export async function seedBizData(pbUrl, superEmail, superPassword) {
  // 超级管理员登录
  const su = await call('POST', `${pbUrl}/api/collections/_superusers/auth-with-password`, {
    identity: superEmail, password: superPassword,
  });
  const ST = su.token;

  // 机构：发布审核关（管理员可直接发布）、敏感导出开（fixture 含敏感字段用于过滤断言）
  const org = await call('POST', `${pbUrl}/api/collections/organizations/records`, {
    name: FIXTURE.orgName, status: 'active',
    require_activity_approval: false, allow_sensitive_export: true, remark: '',
  }, ST);

  // 标准报名字段：昵称(必填)、年龄(选填)、微信号(选填+敏感)
  const fieldDefs = {};
  for (const [code, type, label, required, sensitive] of [
    ['nickname', 'text', '昵称', true, false],
    ['age', 'number', '年龄', false, false],
    ['wechat_id', 'text', '微信号', false, true],
  ]) {
    const r = await call('POST', `${pbUrl}/api/collections/registration_field_defs/records`, {
      organization_id: '', field_code: code, field_type: type, label,
      source_type: 'standard', is_sensitive: sensitive, options_json: null,
      required_default: required, status: 'active',
    }, ST);
    fieldDefs[code] = r.id;
  }

  // 一次性邀请码 → 管理员注册（FR-ORG-002 链路本身也是 fixture 的一部分）
  const inv = await call('POST', `${pbUrl}/api/cc/super/invites`, { organization_id: org.id }, ST);
  const inviteToken = inv.invite.token;
  await call('POST', `${pbUrl}/api/cc/auth/admin-register`, {
    invite_code: inviteToken, username: FIXTURE.adminUsername,
    email: FIXTURE.adminEmail, password: FIXTURE.adminPassword,
  });
  const adminAuth = await call('POST', `${pbUrl}/api/collections/admin_accounts/auth-with-password`, {
    identity: FIXTURE.adminUsername, password: FIXTURE.adminPassword,
  });
  const AT = adminAuth.token;

  // 活动：报名窗口覆盖当前时刻；表单启用 3 个字段（昵称必填）
  const now = Date.now();
  const activity = await call('POST', `${pbUrl}/api/collections/activities/records`, {
    organization_id: org.id,
    activity_code: 'CC_E2E_01',
    title: FIXTURE.activityTitle,
    description: 'E2E 主链路测试活动（fixture 伪造数据）',
    location: '线上',
    start_time: pbTime(new Date(now + 3600_000)),
    end_time: pbTime(new Date(now + 3 * 3600_000)),
    status: 'draft',
    capacity_total: 10, capacity_speaker: 5, capacity_listener: 5,
    registration_open: true,
    registration_start_at: pbTime(new Date(now - 3600_000)),
    registration_end_at: pbTime(new Date(now + 6 * 3600_000)),
    group_tag: '',
    form_config_json: {
      fields: [
        { field_def_id: fieldDefs.nickname, enabled: true, required: true },
        { field_def_id: fieldDefs.age, enabled: true, required: false },
        { field_def_id: fieldDefs.wechat_id, enabled: true, required: false },
      ],
    },
  }, AT);
  // 签到二维码 token 由服务端创建时生成（checkin_qr_token，FR-CHK-001；客户端不可指定），
  // 创建响应带回；扫码落地页为 /checkin/:token
  if (!activity.checkin_qr_token) {
    throw new Error(`活动创建响应缺少服务端生成的 checkin_qr_token：${JSON.stringify(activity).slice(0, 300)}`);
  }

  // 直接发布（机构发布审核开关关，AC-04 双路径之一直发路径）
  const pub = await call('POST', `${pbUrl}/api/cc/activities/${activity.id}/publish`, {}, AT);
  if (pub.activity?.status !== 'published') {
    throw new Error(`活动发布失败：${JSON.stringify(pub).slice(0, 300)}`);
  }

  // ---------- 培训链路 fixture（training-flow.spec.ts） ----------
  // 第二活动：承载培训资格报名（与主链路活动隔离，主活动「已通过」列表断言不受影响）
  const qualActivity = await call('POST', `${pbUrl}/api/collections/activities/records`, {
    organization_id: org.id,
    activity_code: 'CC_E2E_02',
    title: FIXTURE.qualActivityTitle,
    description: 'E2E 培训资格报名承载活动（fixture 伪造数据）',
    location: '线上',
    start_time: pbTime(new Date(now + 3600_000)),
    end_time: pbTime(new Date(now + 3 * 3600_000)),
    status: 'draft',
    capacity_total: 10, capacity_speaker: 5, capacity_listener: 5,
    registration_open: true,
    registration_start_at: pbTime(new Date(now - 3600_000)),
    registration_end_at: pbTime(new Date(now + 6 * 3600_000)),
    group_tag: '',
    form_config_json: {
      fields: [
        { field_def_id: fieldDefs.nickname, enabled: true, required: true },
      ],
    },
  }, AT);
  const qualPub = await call('POST', `${pbUrl}/api/cc/activities/${qualActivity.id}/publish`, {}, AT);
  if (qualPub.activity?.status !== 'published') {
    throw new Error(`资格活动发布失败：${JSON.stringify(qualPub).slice(0, 300)}`);
  }

  // 先建存量用户名账号并经 T1 bind-phone 绑定测试手机号，既覆盖迁移链路，也保留固定
  // username 供管理端名单断言；测试页面随后只用手机号验证码登录。
  const createLegacyAndBind = async (username, password, phone) => {
    const auth = await call('POST', `${pbUrl}/api/cc/auth/participant`, { username, password });
    const sent = await call('POST', `${pbUrl}/api/cc/auth/participant/request-code`, {
      phone, purpose: 'bind_phone',
    }, auth.token);
    await call('POST', `${pbUrl}/api/cc/auth/participant/bind-phone`, {
      phone, challenge_id: sent.challenge_id, code: FIXTURE.phoneCode,
    }, auth.token);
    return auth;
  };

  const mainParticipant = await createLegacyAndBind(
    FIXTURE.participantUsername, FIXTURE.participantPassword, FIXTURE.participantPhone,
  );

  // 培训账号报名第二活动 → 管理员审核通过。聆听者获得培训签到资格（账号级，全平台通用）；
  // 倾诉者仅 approved 倾诉者报名，用于负向用例（listener_not_approved）。
  const registerAndApprove = async (username, password, phone, role, nickname) => {
    const auth = await createLegacyAndBind(username, password, phone);
    const reg = await call('POST', `${pbUrl}/api/cc/activities/${qualActivity.id}/register`, {
      activity_role: role,
      answers: [{ field_def_id: fieldDefs.nickname, value: nickname }],
    }, auth.token);
    await call('POST', `${pbUrl}/api/cc/registrations/${reg.registration.id}/transition`, {
      to: 'approved',
    }, AT);
    return auth.record.id;
  };
  await registerAndApprove(FIXTURE.listenerUsername, FIXTURE.listenerPassword, FIXTURE.listenerPhone, 'listener', FIXTURE.listenerNickname);
  await registerAndApprove(FIXTURE.outsiderUsername, FIXTURE.outsiderPassword, FIXTURE.outsiderPhone, 'speaker', FIXTURE.outsiderNickname);

  // 培训：集合 API 创建（status 服务端强制 draft；checkin_qr_token 由 hooks 生成并随响应带回）
  // → 发布为 published。开放签到留给 spec 经管理端 UI 操作（与主链路活动签到同模式）。
  const training = await call('POST', `${pbUrl}/api/collections/trainings/records`, {
    organization_id: org.id,
    title: FIXTURE.trainingTitle,
    training_code: 'TR_E2E_01',
    description: 'E2E 培训链路测试（fixture 伪造数据）',
    location: '线上',
    start_time: pbTime(new Date(now + 3600_000)),
    end_time: pbTime(new Date(now + 3 * 3600_000)),
    status: 'draft',
  }, AT);
  if (training.status !== 'draft' || !training.checkin_qr_token) {
    throw new Error(`培训创建响应异常（须强制 draft 且带回服务端生成 token）：${JSON.stringify(training).slice(0, 300)}`);
  }
  const tPub = await call('POST', `${pbUrl}/api/cc/trainings/${training.id}/publish`, {}, AT);
  if (tPub.training?.status !== 'published') {
    throw new Error(`培训发布失败：${JSON.stringify(tPub).slice(0, 300)}`);
  }

  return {
    orgId: org.id,
    activityId: activity.id,
    activityTitle: FIXTURE.activityTitle,
    surveyTitle: FIXTURE.surveyTitle,
    checkinQrToken: activity.checkin_qr_token,
    adminUsername: FIXTURE.adminUsername,
    adminPassword: FIXTURE.adminPassword,
    participantUsername: FIXTURE.participantUsername,
    participantPassword: FIXTURE.participantPassword,
    participantPhone: FIXTURE.participantPhone,
    participantId: mainParticipant.record.id,
    phoneCode: FIXTURE.phoneCode,
    trainingId: training.id,
    trainingTitle: FIXTURE.trainingTitle,
    trainingCheckinToken: training.checkin_qr_token,
    listenerUsername: FIXTURE.listenerUsername,
    listenerPassword: FIXTURE.listenerPassword,
    listenerPhone: FIXTURE.listenerPhone,
    outsiderUsername: FIXTURE.outsiderUsername,
    outsiderPassword: FIXTURE.outsiderPassword,
    outsiderPhone: FIXTURE.outsiderPhone,
    answers: FIXTURE.answers,
  };
}
