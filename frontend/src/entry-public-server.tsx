import { renderToString } from 'react-dom/server';
import { NotFoundView } from './features/participant/pages/NotFoundView';
import { CurrentPathProvider } from './public/nav';
import { PublicApp } from './public/PublicApp';
import type { PublicRouteMatch } from './public/routes';
import type { PublicPageData } from './public/types';

/**
 * 公开页服务端渲染入口（vite.public.server.config.ts 打包进 dist-public/server）。
 * 模块级不得访问 window/document/localStorage；图片/CSS 经 import 由构建解析。
 */

/** og:image 固定路径（public-assets-static 静态文件，不走 vite hash，便于服务端引用）。 */
export const OG_IMAGE_PATH = '/public-assets/og-share.jpg';

/** 渲染公开路由正文（#root 内 HTML）。 */
export function renderPublicBody(match: PublicRouteMatch, data: PublicPageData): string {
  return renderToString(<PublicApp match={match} data={data} />);
}

/**
 * 渲染 404 通用页正文（不泄露草稿/隐藏内容存在性，message 由服务端统一给定）。
 */
export function renderNotFoundBody(message: string, pathname = '/'): string {
  return renderToString(
    <CurrentPathProvider value={pathname}>
      <NotFoundView message={message} />
    </CurrentPathProvider>,
  );
}
