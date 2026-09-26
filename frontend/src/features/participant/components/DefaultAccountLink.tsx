/**
 * 站点头部默认账号入口：纯 <a>「登录」链接。
 *
 * 双用途（必须保持同一份 markup，SSR 输出与客户端占位才逐字节一致）：
 * 1. 服务端渲染 / hydrate 首帧：作为 AccountActions 的 ClientOnly placeholder；
 * 2. 未挂载兜底：PublicPageLayout 未传 actions 时的默认账号区。
 */
export function DefaultAccountLink() {
  return (
    <a className="cc-btn cc-btn-secondary" href="/login">
      登录
    </a>
  );
}
