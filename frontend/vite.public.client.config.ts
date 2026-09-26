import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 公开页 hydrate 客户端 bundle 构建（产物 dist-public/client，由 server/ 经
 * /public-assets/* 伺服）。base 固定 '/public-assets/'；manifest 供服务端
 * 注入 entry js/css。publicDir 为 public-assets-static（og 图等固定路径静态资源）。
 */
export default defineConfig({
  base: '/public-assets/',
  plugins: [react()],
  publicDir: 'public-assets-static',
  build: {
    outDir: 'dist-public/client',
    manifest: true,
    rollupOptions: {
      input: 'src/entry-public-client.tsx',
    },
  },
});
