import { describe, expect, it } from 'vitest';
import { buildExportScope } from './exportScope';

/**
 * 导出范围组装单测（FR-EXP-004）。
 * 回归：type=organization 曾漏带 organization_id（且带噪声 activity_id: undefined），
 * 服务端校验「机构范围导出须指定 scope.organization_id」恒 400。
 */
describe('buildExportScope 导出范围组装', () => {
  it('机构范围：携带 organization_id，不含 activity_id 噪声字段', () => {
    const scope = buildExportScope('organization', 'org1', '');
    expect(scope).toEqual({ type: 'organization', organization_id: 'org1' });
    expect(scope).not.toHaveProperty('activity_id');
  });

  it('机构范围未选择机构：返回 null（由页面提示选择）', () => {
    expect(buildExportScope('organization', '', '')).toBeNull();
  });

  it('单活动范围：携带 activity_id', () => {
    expect(buildExportScope('activity', '', 'act1')).toEqual({
      type: 'activity',
      activity_id: 'act1',
    });
  });

  it('单活动范围未选择活动：返回 null', () => {
    expect(buildExportScope('activity', '', '')).toBeNull();
  });

  it('全平台范围：无需附加字段', () => {
    expect(buildExportScope('platform', '', '')).toEqual({ type: 'platform' });
  });
});
