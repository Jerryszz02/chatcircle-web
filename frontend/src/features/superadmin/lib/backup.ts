/**
 * 备份状态解析（PRD §12.3、AC-23）。
 *
 * 端点约定 GET /api/cc/super/backup-status 返回「最近备份结果与失败告警标记」。
 * 已实跑核对后端 super.pb.js 实际形态：{ last_backup: { action, result, created,
 * reason, metadata } | null, alert: boolean, message? }（尚无备份时 last_backup=null
 * 且 alert=true）。此处仍保留防御式归一化，兼容 alarm/failed 等历史命名：
 * - alarm：读取 alert / alarm / failed 字段，缺失时按最近一次备份结果推断（failure → 告警）；
 * - last_backup：最近一次备份的时间/结果/文件/失败原因，字段名兼容常见命名。
 */

/** 归一化后的备份状态（页面只依赖此结构）。 */
export interface BackupStatus {
  /** 是否应显示显著告警横幅（最近一次备份失败）。 */
  alarm: boolean;
  /** 最近一次备份信息；从未备份为 null。 */
  lastBackup: {
    at?: string;
    result?: 'success' | 'failure';
    file?: string;
    message?: string;
  } | null;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** 把端点原始响应归一化为 BackupStatus（容忍后端字段命名差异）。 */
export function normalizeBackupStatus(raw: unknown): BackupStatus {
  if (typeof raw !== 'object' || raw === null) {
    return { alarm: false, lastBackup: null };
  }
  const obj = raw as Record<string, unknown>;
  const last =
    (obj.last_backup as Record<string, unknown> | undefined) ??
    (obj.last as Record<string, unknown> | undefined) ??
    null;

  let result: 'success' | 'failure' | undefined;
  if (last) {
    const r = pickString(last, ['result', 'status']);
    if (r === 'success' || r === 'failure') result = r;
  }

  const alarmRaw = obj.alert ?? obj.alarm ?? obj.failed;
  const alarm = typeof alarmRaw === 'boolean' ? alarmRaw : result === 'failure';

  return {
    alarm,
    lastBackup: last
      ? {
          at: pickString(last, ['at', 'time', 'created', 'finished_at']),
          result,
          file: pickString(last, ['file', 'file_name', 'filename']),
          message: pickString(last, ['message', 'error', 'reason']),
        }
      : null,
  };
}
