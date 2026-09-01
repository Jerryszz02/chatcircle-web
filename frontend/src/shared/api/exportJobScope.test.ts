import { describe, expect, it } from 'vitest';

import { readExportJobScope } from './exportJobScope';

/**
 * export_jobs.scope_json 兼容读取（T6）：v2 StoredExportSelectionV2（scope 内嵌）
 * 与历史 v1 扁平 ExportScope 归一为同一视图，页面展示一律经此函数。
 */
describe('readExportJobScope', () => {
  it('v2 形状：取内嵌 scope、format 与时区无关地派生文件格式', () => {
    const view = readExportJobScope({
      schema_version: 2,
      source_schema_version: 2,
      scope: { type: 'activity', activity_id: 'act_1' },
      format: 'xlsx',
      datasets: ['registrations'],
    });
    expect(view).toEqual({
      type: 'activity',
      organization_id: undefined,
      activity_id: 'act_1',
      date_range: undefined,
      format: 'xlsx',
      schema_version: 2,
    });
  });

  it('v2 形状：无 format（旧任务补存储）时回退 csv_zip，缺失字段保持 undefined', () => {
    const view = readExportJobScope({
      schema_version: 2,
      scope: { type: 'organization' },
    });
    expect(view.type).toBe('organization');
    expect(view.format).toBe('csv_zip');
    expect(view.schema_version).toBe(2);
  });

  it('v1 扁平形状：直接透传并标记 schema_version=1', () => {
    const view = readExportJobScope({
      type: 'activity',
      activity_id: 'act_9',
      date_range: { from: '2026-08-01', to: '2026-08-31' },
    });
    expect(view).toEqual({
      type: 'activity',
      organization_id: undefined,
      activity_id: 'act_9',
      date_range: { from: '2026-08-01', to: '2026-08-31' },
      format: 'csv_zip',
      schema_version: 1,
    });
  });

  it('空 / null：按 v1 处理且 type 为 undefined，不抛错', () => {
    const view = readExportJobScope(null);
    expect(view.type).toBeUndefined();
    expect(view.schema_version).toBe(1);
    expect(view.format).toBe('csv_zip');
  });

  it('异常形状：schema_version=2 但无内嵌 scope 时不崩溃，回退 v1 解读', () => {
    const view = readExportJobScope({ schema_version: 2, format: 'xlsx' } as never);
    expect(view?.type).toBeUndefined();
    expect(view?.schema_version).not.toBe(2);
  });
});
