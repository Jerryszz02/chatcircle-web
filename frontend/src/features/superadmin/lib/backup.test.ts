import { describe, expect, it } from 'vitest';
import { normalizeBackupStatus } from './backup';

describe('normalizeBackupStatus', () => {
  it('原始输入非对象时返回无告警', () => {
    expect(normalizeBackupStatus(null)).toEqual({ alarm: false, stale: false, lastBackup: null });
    expect(normalizeBackupStatus('x').alarm).toBe(false);
  });

  it('尚无备份记录：alert=true 且 last_backup=null', () => {
    const s = normalizeBackupStatus({ last_backup: null, alert: true, message: '尚无备份记录' });
    expect(s.alarm).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.lastBackup).toBeNull();
  });

  it('最近一次成功且新鲜：不告警', () => {
    const s = normalizeBackupStatus({
      alert: false,
      stale: false,
      last_backup: {
        action: 'backup.success',
        result: 'success',
        created: '2026-08-25T02:00:00.000Z',
        reason: '',
        file: 'cc_daily_a.zip',
        metadata: null,
      },
    });
    expect(s.alarm).toBe(false);
    expect(s.stale).toBe(false);
    expect(s.lastBackup?.result).toBe('success');
    expect(s.lastBackup?.file).toBe('cc_daily_a.zip');
  });

  it('最近一次失败：告警并透出失败原因', () => {
    const s = normalizeBackupStatus({
      alert: true,
      stale: false,
      last_backup: {
        action: 'backup.failed',
        result: 'failure',
        created: '2026-08-25T02:00:00.000Z',
        reason: '存储空间不足',
        file: null,
        metadata: null,
      },
    });
    expect(s.alarm).toBe(true);
    expect(s.lastBackup?.message).toBe('存储空间不足');
  });

  it('最近一次成功但已陈旧：告警且顶层 message 作为兜底说明', () => {
    const s = normalizeBackupStatus({
      alert: true,
      stale: true,
      message: '最近一次成功备份已超过 36 小时，自动备份疑似中断',
      last_backup: {
        action: 'backup.success',
        result: 'success',
        created: '2026-08-20T02:00:00.000Z',
        reason: '',
        file: 'cc_daily_old.zip',
        metadata: null,
      },
    });
    expect(s.alarm).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.lastBackup?.result).toBe('success');
    expect(s.lastBackup?.message).toBe('最近一次成功备份已超过 36 小时，自动备份疑似中断');
  });
});
