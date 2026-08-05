/**
 * 参与者用户名/密码规则（FR-AUTH-005、security-privacy §6）。
 * 与服务端 participant_accounts.username pattern（^[a-z0-9_]{4,20}$，迁移 1785888180）
 * 保持一致；服务端小写归一化后存储与比较，前端先归一化再提交，所见即所存。
 * 前端校验仅作体验层提示，最终校验以服务端为准（technical-design §5.5）。
 */

export const USERNAME_MIN = 4;
export const USERNAME_MAX = 20;
/** PocketBase auth 集合默认密码最小长度（迁移未自定义，服务端为准）。 */
export const PASSWORD_MIN = 8;

/** 服务端字段 pattern（小写形态）；校验前先经 normalizeUsername 归一化。 */
export const USERNAME_PATTERN = /^[a-z0-9_]{4,20}$/;

export const USERNAME_RULE_HINT = '4–20 位，仅字母、数字、下划线；大写字母将自动转为小写';

/**
 * 用户名隐私提示（PRD §11.1 推荐提示语原文，注册/报名链路必须展示，
 * security-privacy §6；平台不是完全匿名系统，禁止宣称「完全匿名」）。
 */
export const USERNAME_PRIVACY_NOTICE =
  '请创建一个不包含真实姓名、手机号或常用社交账号的用户名。' +
  '系统使用该账号关联您在不同活动中的记录；普通分析和对外报告不展示姓名或联系方式。';

/** 用户名归一化：去首尾空白 + 小写（FR-AUTH-005 大小写不敏感唯一）。 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 校验用户名（基于归一化后的值）。返回 null 表示合法，否则为可读错误文案。
 * 唯一性只能由服务端判定（错误密码不得建号，AC-06），此处不查重。
 */
export function validateUsername(raw: string): string | null {
  const normalized = normalizeUsername(raw);
  if (normalized === '') return '请输入用户名';
  if (normalized.length < USERNAME_MIN || normalized.length > USERNAME_MAX) {
    return `用户名需为 ${USERNAME_MIN}–${USERNAME_MAX} 位`;
  }
  if (!USERNAME_PATTERN.test(normalized)) return '用户名仅允许字母、数字、下划线';
  return null;
}

/** 校验密码（体验层最小长度提示；强度与正确性以服务端为准）。 */
export function validatePassword(password: string): string | null {
  if (password === '') return '请输入密码';
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  return null;
}
