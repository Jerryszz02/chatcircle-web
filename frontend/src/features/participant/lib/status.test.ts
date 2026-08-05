import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../shared/api/http';
import { bizCodeOf } from '../api';
import {
  activityRoleLabel,
  activityStatusLabel,
  checkinFailureCopy,
  formatDateTime,
  formatTimeRange,
  registrationClosedReasonCopy,
  registrationStatusMeta,
  surveyIneligibleCopy,
} from './status';

/**
 * 状态展示分支单测（PRD §4 状态机口径；test-plan §2「状态展示组件」）。
 * 覆盖：报名 4 态、报名未开放原因、问卷资格失败分因、签到失败分支、时间格式化。
 */

describe('registrationStatusMeta 报名 4 态（PRD §4.4）', () => {
  it('各状态标签与提示', () => {
    expect(registrationStatusMeta('pending').label).toBe('待审核');
    expect(registrationStatusMeta('approved').label).toBe('已通过');
    expect(registrationStatusMeta('rejected').label).toBe('已拒绝');
    expect(registrationStatusMeta('cancelled').label).toBe('已取消');
  });

  it('待审核提示联系管理员（FR-REG-004 提交后不可自行修改/取消）', () => {
    expect(registrationStatusMeta('pending').hint).toContain('联系机构管理员');
    expect(registrationStatusMeta('pending').hint).toContain('不能自行修改或取消');
  });
});

describe('registrationClosedReasonCopy 报名未开放原因（FR-ACT-005/007）', () => {
  it('四种原因各有文案，未知原因走兜底', () => {
    expect(registrationClosedReasonCopy('not_started').title).toBe('报名尚未开始');
    expect(registrationClosedReasonCopy('ended').title).toBe('报名已截止');
    expect(registrationClosedReasonCopy('full').title).toBe('名额已满');
    expect(registrationClosedReasonCopy('closed').title).toBe('报名未开放');
    expect(registrationClosedReasonCopy(null).title).toBe('报名未开放');
    expect(registrationClosedReasonCopy(undefined).title).toBe('报名未开放');
  });
});

describe('surveyIneligibleCopy 问卷资格失败分因（FR-SUR-006）', () => {
  it('五种原因分开展示', () => {
    expect(surveyIneligibleCopy('not_logged_in').title).toBe('请先登录');
    expect(surveyIneligibleCopy('not_approved').title).toBe('报名未通过审核');
    expect(surveyIneligibleCopy('role_mismatch').title).toContain('不适用于您的角色');
    expect(surveyIneligibleCopy('not_open').title).toBe('问卷尚未开放');
    expect(surveyIneligibleCopy('ended').title).toBe('问卷已结束');
  });

  it('未知原因兜底', () => {
    expect(surveyIneligibleCopy('something_new').title).toBe('暂不能填写');
  });
});

describe('checkinFailureCopy 签到失败分支（FR-CHK-002/003）', () => {
  const errWith = (code: string, status = 409) =>
    new ApiError('服务端文案', status, 'HTTP_ERROR', { code });

  it('按业务码分开展示', () => {
    expect(checkinFailureCopy(errWith('checkin_not_open')).title).toBe('签到未开放');
    expect(checkinFailureCopy(errWith('checkin_closed')).title).toBe('签到已结束');
    expect(checkinFailureCopy(errWith('registration_not_approved', 403)).title).toBe('报名未通过审核');
  });

  it('无业务码时用服务端 message 兜底', () => {
    const err = new ApiError('网络异常', 0, 'NETWORK_ERROR');
    const copy = checkinFailureCopy(err);
    expect(copy.title).toBe('签到失败');
    expect(copy.detail).toBe('网络异常');
  });

  it('bizCodeOf 从 details.code 提取业务码', () => {
    expect(bizCodeOf(errWith('checkin_not_open'))).toBe('checkin_not_open');
    expect(bizCodeOf(new ApiError('x', 400, 'HTTP_ERROR'))).toBeNull();
  });
});

describe('角色/活动状态标签', () => {
  it('activityRoleLabel / activityStatusLabel', () => {
    expect(activityRoleLabel('speaker')).toBe('倾诉者');
    expect(activityRoleLabel('listener')).toBe('聆听者');
    expect(activityStatusLabel('published')).toBe('已发布');
    expect(activityStatusLabel('closed')).toBe('已关闭');
    expect(activityStatusLabel('archived')).toBe('已归档');
  });
});

describe('时间格式化', () => {
  it('PocketBase 日期格式（空格分隔）转本地展示', () => {
    expect(formatDateTime('2026-08-05 02:31:55.930Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('空值与非法值兜底', () => {
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('formatTimeRange 展示起止', () => {
    const range = formatTimeRange('2026-08-05 02:00:00.000Z', '2026-08-05 04:00:00.000Z');
    expect(range).toContain('至');
  });
});
