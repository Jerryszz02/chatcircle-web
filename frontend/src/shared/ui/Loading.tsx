/** 加载指示：整页或局部加载态（role="status" 供辅助技术识别）。 */
export function Loading({
  label = '加载中…',
  fullscreen = false,
}: {
  label?: string;
  fullscreen?: boolean;
}) {
  if (fullscreen) {
    return (
      <div className="cc-loading-fullscreen" role="status" aria-label={label}>
        <span className="cc-spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <span className="cc-loading" role="status" aria-label={label}>
      <span className="cc-spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
