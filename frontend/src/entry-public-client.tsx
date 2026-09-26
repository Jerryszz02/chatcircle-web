import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { PublicClientApp } from './public/clientPages';
import { matchPublicRoute } from './public/routes';
import type { PublicPageData } from './public/types';
import './shared/styles/global.css';
import './features/participant/participant.css';
import './features/participant/site.css';

/**
 * 公开页 hydrate 入口（vite.public.client.config.ts 打包进 dist-public/client）。
 *
 * 首帧数据来自 __CC_PUBLIC_DATA__（服务端内嵌，不 refetch），保证与 SSR HTML
 * 逐字节一致；页面间导航一律 document navigation，无客户端路由。
 * 404/503 等无内嵌数据的页面不 hydrate（保持静态）。
 */

const DATA_ELEMENT_ID = '__CC_PUBLIC_DATA__';

function readInitialData(): PublicPageData | null {
  const el = document.getElementById(DATA_ELEMENT_ID);
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as PublicPageData;
  } catch {
    return null;
  }
}

const container = document.getElementById('root');
const data = readInitialData();
const match = matchPublicRoute(window.location.pathname);

if (container && data && match) {
  hydrateRoot(
    container,
    <StrictMode>
      <PublicClientApp data={data} match={match} />
    </StrictMode>,
  );
}
