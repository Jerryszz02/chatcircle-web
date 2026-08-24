import type { ExportScope } from '../../../shared/api/types';

/**
 * 组装导出范围 scope_json（FR-EXP-004，服务端按身份校验范围合法性）。
 * type=organization 必须携带 organization_id（后端 exports.pb.js 据此确定机构约束）；
 * 机构/活动范围未选定目标时返回 null，由页面提示先选择。
 */
export function buildExportScope(
  type: ExportScope['type'],
  organizationId: string,
  activityId: string,
): ExportScope | null {
  if (type === 'organization') {
    if (!organizationId) return null;
    return { type: 'organization', organization_id: organizationId };
  }
  if (type === 'activity') {
    if (!activityId) return null;
    return { type: 'activity', activity_id: activityId };
  }
  return { type: 'platform' };
}
