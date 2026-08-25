/**
 * 参与者端公开页站点页脚（C 端品牌官网化，2026-08 UI 重构）。
 * Empact 作为运营方仅在页脚与 About 页体现；联系方式只放邮箱，不放私人微信。
 */
export function SiteFooter() {
  return (
    <footer className="ccp-site-footer">
      <div className="ccp-site-footer-inner">
        <p className="ccp-site-footer-brand">Chat Circles</p>
        <p className="ccp-site-footer-line">青年心理健康公益项目 · 由社会企业 Empact 发起与运营</p>
        <p className="ccp-site-footer-line">
          联系我们：
          <a href="mailto:maggie.yang@empact.sg">maggie.yang@empact.sg</a>
        </p>
        <p className="ccp-site-footer-copy">© 2026 Empact · Chat Circles</p>
      </div>
    </footer>
  );
}
