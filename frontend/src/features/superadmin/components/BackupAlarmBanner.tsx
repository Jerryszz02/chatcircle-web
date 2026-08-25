import type { BackupStatus } from '../lib/backup';
import { formatDateTime } from '../lib/format';

/**
 * 备份失败显著告警横幅（AC-23：模拟失败后超级管理后台可见告警）。
 * 挂载于 /super/system 状态卡与全局看板告警位（technical-design §5.8）。
 */
export function BackupAlarmBanner({ status }: { status: BackupStatus }) {
  if (!status.alarm) return null;
  // 区分「尚无备份记录」与「最近一次备份失败」：二者告警等级与处置动作不同，
  // 混用同一条「失败」文案会误导值班方向（2026-08 备份审计链路未接通期间常亮的就是前者）
  if (!status.lastBackup) {
    return (
      <div className="sa-banner sa-banner-danger" role="alert">
        尚未有任何备份记录。请确认每日自动备份任务已部署并正常运行；首次备份成功后此告警自动解除。
      </div>
    );
  }
  const at = status.lastBackup.at;
  const message = status.lastBackup.message;
  return (
    <div className="sa-banner sa-banner-danger" role="alert">
      最近一次备份失败{at ? `（${formatDateTime(at)}）` : ''}
      {message ? `：${message}` : '。'}请立即检查备份任务与存储空间；每次备份结果已写入审计日志。
    </div>
  );
}
