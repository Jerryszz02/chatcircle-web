import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 公开页渲染服务构建（产物 dist-public/server，node 直接运行，无运行时依赖）。
 * ssr.noExternal=true 全量 bundle（react/react-dom/react-markdown 一并打入）；
 * 图片 import 解析为 '/public-assets/assets/<name>-<hash>.<ext>' URL 字符串
 * （与 client 构建同内容同 hash，经实证核对一致），CSS import 在 SSR 构建中为空操作。
 */
export default defineConfig({
  base: '/public-assets/',
  plugins: [react()],
  // 服务端 bundle 不复制静态目录（静态资源由 client 构建产物提供）
  publicDir: false,
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-public/server',
    rollupOptions: {
      output: { format: 'es' },
    },
  },
  ssr: {
    noExternal: true,
  },
});
