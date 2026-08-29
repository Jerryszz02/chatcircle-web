import { myPairingStateMeta } from './pairingStatus';
import type { MyPairingState } from '../../../shared/api/accountEvent';

/**
 * 配对状态展示分支（PRD §5.3 状态表）：每个已签到状态都有文字标签、
 * 状态图标与提示文案（不只依赖颜色）；未签到不展示卡片。
 */
describe('myPairingStateMeta 配对状态展示', () => {
  it('已签到且配对未开始：提示等待工作人员开始配对', () => {
    const meta = myPairingStateMeta('waiting_to_start');
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('等待开始配对');
    expect(meta!.tone).toBe('info');
    expect(meta!.hint).toContain('等待工作人员开始配对');
  });

  it('配对已开始且对侧暂无人：提示正在等待搭档', () => {
    const meta = myPairingStateMeta('waiting_for_partner');
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('正在等待搭档');
    expect(meta!.tone).toBe('info');
    expect(meta!.hint).toContain('搭档');
  });

  it('已配对：成功色调与找搭档提示', () => {
    const meta = myPairingStateMeta('paired');
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('已配对');
    expect(meta!.tone).toBe('success');
    expect(meta!.icon).toBe('circles');
  });

  it('已调整：明确提示安排已更新', () => {
    const meta = myPairingStateMeta('reassigned');
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('安排已更新');
    expect(meta!.tone).toBe('warning');
    expect(meta!.hint).toContain('配对安排已更新');
  });

  it('签到已撤销：配对信息不可用并提示联系现场工作人员', () => {
    const meta = myPairingStateMeta('checkin_revoked');
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('签到已撤销');
    expect(meta!.tone).toBe('danger');
    expect(meta!.hint).toContain('联系现场工作人员');
  });

  it('未签到：不展示配对卡片（返回 null）', () => {
    expect(myPairingStateMeta('not_checked_in')).toBeNull();
  });

  it('全部已签到状态都同时具备文字、图标与色调（不只依赖颜色）', () => {
    const states: MyPairingState[] = [
      'waiting_to_start',
      'waiting_for_partner',
      'paired',
      'reassigned',
      'checkin_revoked',
    ];
    for (const state of states) {
      const meta = myPairingStateMeta(state);
      expect(meta, state).not.toBeNull();
      expect(meta!.label.length).toBeGreaterThan(0);
      expect(meta!.hint.length).toBeGreaterThan(0);
      expect(['clock', 'circles', 'refresh', 'alert']).toContain(meta!.icon);
    }
  });
});
