import type { BackupStatus } from '../lib/backup';
import { formatDateTime } from '../lib/format';

/**
 * 备份失败显著告警横幅（AC-23：模拟失败后超级管理后台可见告警）。
 * 挂载于 /super/system 状态卡与全局看板告警位（technical-design §5.8）。
 */
export function BackupAlarmBanner({ status }: { status: BackupStatus }) {
  if (!status.alarm) return null;
  const at = status.lastBackup?.at;
  const message = status.lastBackup?.message;
  return (
    <div className="sa-banner sa-banner-danger" role="alert">
      最近一次备份失败{at ? `（${formatDateTime(at)}）` : ''}
      {message ? `：${message}` : '。'}请立即检查备份任务与存储空间；每次备份结果已写入审计日志。
    </div>
  );
}
