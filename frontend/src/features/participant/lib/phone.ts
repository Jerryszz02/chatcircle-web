/** T1 参与者手机号与隐私文案的前端体验层约束；服务端仍是最终校验边界。 */

export const PARTICIPANT_PRIVACY_NOTICE_VERSION = '2026-08-28.v1';

export const PARTICIPANT_PHONE_PRIVACY_NOTICE =
  '我们仅将你的姓名和手机号用于账号验证、活动报名、审核、现场联系、签到和必要的活动安排，不用于广告营销、商业画像或出售给第三方。统计分析仅使用去标识化数据，不展示姓名和手机号；未经另行同意，我们不会将联系方式与问卷中的敏感回答用于个体分析。';

/** 接受 11 位大陆手机号、+86 或 0086 前缀，去除空格/连字符后返回 E.164。 */
export function normalizeMainlandPhone(value: string): string | null {
  let local = value.trim().replace(/[\s-]/g, '');
  if (local.startsWith('+86')) local = local.slice(3);
  else if (local.startsWith('0086')) local = local.slice(4);
  if (!/^1[3-9]\d{9}$/.test(local)) return null;
  return `+86${local}`;
}

export function validateMainlandPhone(value: string): string | null {
  if (value.trim() === '') return '请输入手机号';
  if (!normalizeMainlandPhone(value)) return '请输入有效的中国大陆手机号';
  return null;
}

export function validatePhoneCode(value: string): string | null {
  if (value.trim() === '') return '请输入验证码';
  if (!/^\d{4,8}$/.test(value.trim())) return '验证码应为 4–8 位数字';
  return null;
}
