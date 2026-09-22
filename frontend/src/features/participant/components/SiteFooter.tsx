import { Link } from 'react-router-dom';
import empactLogo from '../../../assets/brand/empact-logo-tagline-white.png';
import xiaohongshuIcon from '../../../assets/brand/xiaohongshu.svg';

/** 公开页共用 Empact 品牌页脚，保留 Chat Circles 的联系与导航入口。 */
export function SiteFooter() {
  return (
    <footer className="ccp-site-footer">
      <div className="ccp-site-footer-inner">
        <a className="ccp-footer-brand" href="https://empact.cn/" aria-label="返回 Empact 官网">
          <img
            src={empactLogo}
            alt="Empact · Empowering Greater Impact"
            width="1080"
            height="483"
          />
        </a>
        <div className="ccp-footer-office ccp-footer-china">
          <span className="ccp-footer-office-label">中国 · 上海</span>
          <span>上海市虹漕路88号越虹广场B座1609</span>
          <a href="mailto:empactsg@126.com">empactsg@126.com</a>
        </div>
        <div className="ccp-footer-office ccp-footer-singapore">
          <span className="ccp-footer-office-label">新加坡</span>
          <span>
            Enabling Village
            <br />
            20 Lengkok Bahru, <span className="ccp-footer-address-unit">Vista #04-02</span>
            <br />
            Singapore 159053
          </span>
          <a href="mailto:enquiries@empact.sg">enquiries@empact.sg</a>
        </div>
        <nav className="ccp-footer-socials" aria-label="社交媒体">
          <a href="https://xhslink.cn/o/A6Nv4ftO0Td" target="_blank" rel="noopener noreferrer">
            <img src={xiaohongshuIcon} alt="" width="24" height="24" />
            <span>小红书</span>
          </a>
          <a
            href="https://weixin.qq.com/r/mp/YBDv99XEyYi2rZGU90Vy"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M10 3C5.58 3 2 5.91 2 9.5c0 2.08 1.2 3.94 3.09 5.13L4.3 17l2.83-1.42c.91.27 1.87.42 2.87.42 4.42 0 8-2.91 8-6.5S14.42 3 10 3Z"
                fill="currentColor"
              />
              <circle cx="7" cy="8" r="1" fill="var(--ccp-footer-blue)" />
              <circle cx="12" cy="8" r="1" fill="var(--ccp-footer-blue)" />
              <path
                d="M16 10c-3.6 0-6.5 2.35-6.5 5.25S12.4 20.5 16 20.5c.8 0 1.58-.12 2.3-.33l2.3 1.13-.65-1.9c1.55-.96 2.55-2.48 2.55-4.15C22.5 12.35 19.6 10 16 10Z"
                fill="currentColor"
                stroke="var(--ccp-footer-blue)"
                strokeWidth="1"
              />
              <circle cx="13.5" cy="14" r=".85" fill="var(--ccp-footer-blue)" />
              <circle cx="18" cy="14" r=".85" fill="var(--ccp-footer-blue)" />
            </svg>
            <span>Empact中国</span>
          </a>
        </nav>
        <div className="ccp-footer-bottom">
          <nav className="ccp-footer-links" aria-label="页脚导航">
            <Link to="/about">关于我们</Link>
            <a href="mailto:maggie.yang@empact.sg">联系 Chat Circles</a>
            <Link to="/privacy">隐私政策</Link>
            <a href="https://empact.cn/">返回 Empact 官网</a>
            <Link to="/admin/login" rel="nofollow">
              后台管理
            </Link>
          </nav>
          <p className="ccp-footer-copy">© {new Date().getFullYear()} Empact · Chat Circles</p>
          <div className="ccp-footer-legal">
            <span>上海井畅企业管理咨询有限公司</span>
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
              沪ICP备2026002363号-2
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
