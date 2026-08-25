import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BackupStatus } from '../lib/backup';
import { BackupAlarmBanner } from './BackupAlarmBanner';

describe('备份告警横幅（BackupAlarmBanner）', () => {
  it('无告警时不渲染', () => {
    const { container } = render(
      <BackupAlarmBanner status={{ alarm: false, lastBackup: null }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('尚无备份记录时提示「尚未备份」而非「备份失败」', () => {
    render(<BackupAlarmBanner status={{ alarm: true, lastBackup: null }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('尚未有任何备份记录');
    expect(screen.getByRole('alert')).not.toHaveTextContent('备份失败');
  });

  it('最近一次备份失败时展示时间、失败原因与处置指引', () => {
    const status: BackupStatus = {
      alarm: true,
      lastBackup: {
        at: '2026-08-25T02:00:00Z',
        result: 'failure',
        message: '存储空间不足',
      },
    };
    render(<BackupAlarmBanner status={status} />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('最近一次备份失败');
    expect(banner).toHaveTextContent('存储空间不足');
    expect(banner).toHaveTextContent('请立即检查备份任务与存储空间');
  });

  it('失败但无时间与原因时兜底为句号', () => {
    render(
      <BackupAlarmBanner status={{ alarm: true, lastBackup: { result: 'failure' } }} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('最近一次备份失败。请立即检查');
  });
});
