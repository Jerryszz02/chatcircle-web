import type { MyPairingState } from '../../../shared/api/accountEvent';
import type { StatusTone } from './status';

/**
 * 参与者配对状态展示分支（PRD §5.3 状态表）。
 * 所有分支文案集中在此，卡片组件只消费本模块的 view 模型，便于单测覆盖全部分支。
 * 状态同时用文字 + 状态图标 + 颜色表达，不依赖单一颜色（WCAG 2.2 AA）。
 */

/** 状态图标名（MyPairingCard 内联 SVG 按名渲染，Lucide 线性风格）。 */
export type PairingStatusIcon = 'clock' | 'circles' | 'refresh' | 'alert';

export interface MyPairingStateMeta {
  /** 状态标签文字（cc-tag）。 */
  label: string;
  /** 状态标签色调（对应 .cc-tag-*）。 */
  tone: StatusTone;
  icon: PairingStatusIcon;
  /** 状态说明（向参与者展示的提示）。 */
  hint: string;
}

/**
 * 本人配对状态 → 展示元。not_checked_in 返回 null：三个展示入口都只覆盖
 * 已签到后的状态，未签到时不展示配对卡片（PRD §5.3 表格无此行）。
 */
export function myPairingStateMeta(state: MyPairingState): MyPairingStateMeta | null {
  switch (state) {
    case 'waiting_to_start':
      return {
        label: '等待开始配对',
        tone: 'info',
        icon: 'clock',
        hint: '配对尚未开始，请等待工作人员开始配对，结果会实时更新。',
      };
    case 'waiting_for_partner':
      return {
        label: '正在等待搭档',
        tone: 'info',
        icon: 'clock',
        hint: '配对已开始，暂时没有可配对的搭档，请稍候，结果会实时更新。',
      };
    case 'paired':
      return {
        label: '已配对',
        tone: 'success',
        icon: 'circles',
        hint: '配对成功，请按组号与现场编号找到你的搭档。',
      };
    case 'reassigned':
      return {
        label: '安排已更新',
        tone: 'warning',
        icon: 'refresh',
        hint: '你的配对安排已更新，请以最新的组号和搭档信息为准。',
      };
    case 'checkin_revoked':
      return {
        label: '签到已撤销',
        tone: 'danger',
        icon: 'alert',
        hint: '配对信息不可用。如有疑问，请联系现场工作人员。',
      };
    case 'not_checked_in':
      return null;
  }
}
