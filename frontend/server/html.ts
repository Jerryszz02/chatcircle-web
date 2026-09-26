import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageMetadata } from '../src/public/metadata';
import type { PublicPageData } from '../src/public/types';

/**
 * 公开页 HTML 文档模板与客户端资源清单加载。
 *
 * 转义规则：文本/属性值经 escapeHtml；JSON-LD 与 __CC_PUBLIC_DATA__ 经
 * safeJsonForHtml（JSON.stringify 后替换 < > & 为 < > &，防 </script> 逃逸）。
 * __CC_PUBLIC_DATA__ 用 <script type="application/json">（非可执行脚本，
 * 不受 CSP script-src 限制，CSP 无需为此放行 inline script）。
 */

/** 客户端 bundle 资源（js/css 的 /public-assets/ 前缀路径）。 */
export interface ClientAssets {
  scripts: string[];
  styles: string[];
}

const ASSET_BASE = '/public-assets/';

/**
 * 启动时读取 dist-public/client/.vite/manifest.json 取 entry js 与 css 列表。
 * manifest 缺失或不含 entry 时抛错（启动失败并明确报错，不退化静默服务）。
 */
export function loadClientAssets(clientDir: string): ClientAssets {
  const manifestPath = join(clientDir, '.vite', 'manifest.json');
  let manifest: Record<string, { isEntry?: boolean; file?: string; css?: string[] }>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `公开页客户端资源清单缺失或不可读：${manifestPath}（先运行 npm run build:public:client）。${String(err)}`,
    );
  }
  const entry = Object.values(manifest).find((item) => item.isEntry && item.file);
  if (!entry?.file) {
    throw new Error(`公开页客户端资源清单缺少 entry 记录：${manifestPath}`);
  }
  return {
    scripts: [`${ASSET_BASE}${entry.file}`],
    styles: (entry.css ?? []).map((file) => `${ASSET_BASE}${file}`),
  };
}

/** 文本/属性值 HTML 转义。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 内嵌进 <script> 的 JSON 转义（防 </script> 逃逸与 HTML 解析歧义）。 */
export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function renderDocument({
  metadata,
  bodyHtml,
  data,
  assets,
}: {
  metadata: PageMetadata;
  /** renderToString 输出的 #root 内 HTML（React 已转义，原样嵌入）。 */
  bodyHtml: string;
  /** 内嵌首帧数据（404/503 页传 null，不产出 data script）。 */
  data: PublicPageData | null;
  assets: ClientAssets;
}): string {
  const { og } = metadata;
  const head = [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />',
    '<meta name="theme-color" content="#176b5b" />',
    `<title>${escapeHtml(metadata.title)}</title>`,
    `<meta name="description" content="${escapeHtml(metadata.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(metadata.canonical)}" />`,
    `<meta name="robots" content="${escapeHtml(metadata.robots)}" />`,
    `<meta property="og:title" content="${escapeHtml(og.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(og.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(og.url)}" />`,
    `<meta property="og:type" content="${escapeHtml(og.type)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(og.site_name)}" />`,
    `<meta property="og:locale" content="${escapeHtml(og.locale)}" />`,
    ...(og.image ? [`<meta property="og:image" content="${escapeHtml(og.image)}" />`] : []),
    ...assets.styles.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}" />`),
    ...metadata.jsonLd.map(
      (item) => `<script type="application/ld+json">${safeJsonForHtml(item)}</script>`,
    ),
  ].join('\n    ');

  const dataScript = data
    ? `<script type="application/json" id="__CC_PUBLIC_DATA__">${safeJsonForHtml(data)}</script>`
    : '';
  const scripts = assets.scripts
    .map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`)
    .join('\n    ');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    ${head}
  </head>
  <body>
    <div id="root">${bodyHtml}</div>
    ${dataScript}
    ${scripts}
  </body>
</html>
`;
}
