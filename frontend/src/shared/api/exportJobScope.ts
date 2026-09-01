import type { ExportJobScopeJson, ExportScope } from './types';

/**
 * 读取导出任务范围的兼容视图（T6）。
 *
 * T6 起服务端把 scope_json 统一存为 StoredExportSelectionV2（scope 内嵌，
 * api-design §6.3）；历史任务与内存中旧响应可能是扁平 ExportScope。
 * 本函数归一两种形状，页面展示一律经此读取。
 */
export interface ExportJobScopeView {
  type: ExportScope['type'];
  organization_id?: string;
  activity_id?: string;
  date_range?: { from?: string; to?: string };
  /** v2 任务的文件格式（v1 恒为 csv_zip）。 */
  format?: 'xlsx' | 'csv_zip';
  /** 存储 schema 版本（1=旧扁平形状，2=StoredExportSelectionV2）。 */
  schema_version: 1 | 2;
}

export function readExportJobScope(scopeJson: ExportJobScopeJson | null | undefined): ExportJobScopeView {
  const raw = (scopeJson ?? {}) as Record<string, unknown>;
  if (raw.schema_version === 2 && raw.scope && typeof raw.scope === 'object') {
    const scope = raw.scope as ExportScope;
    return {
      type: scope.type,
      organization_id: scope.organization_id,
      activity_id: scope.activity_id,
      date_range: scope.date_range,
      format: raw.format === 'xlsx' ? 'xlsx' : 'csv_zip',
      schema_version: 2,
    };
  }
  const legacy = raw as unknown as ExportScope;
  return {
    type: legacy.type,
    organization_id: legacy.organization_id,
    activity_id: legacy.activity_id,
    date_range: legacy.date_range,
    format: 'csv_zip',
    schema_version: 1,
  };
}
