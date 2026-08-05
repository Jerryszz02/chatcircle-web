/** 状态标签：统一的枚举状态展示样式（颜色语义轻量区分）。 */
export function StatusTag({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  return <span className={`cc-tag cc-tag-${tone}`}>{label}</span>;
}

export type StatusTone =
  | 'neutral' // 草稿/未开放等中性态
  | 'info' // 进行中（待审核/已发布/开放中）
  | 'success' // 正向完成态（已通过/已签到/已完成）
  | 'warning' // 需注意（已驳回/已关闭/已结束）
  | 'danger'; // 负向态（已拒绝/已撤销/失败）
