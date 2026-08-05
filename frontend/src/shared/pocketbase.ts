import PocketBase from 'pocketbase';

/**
 * PocketBase 后端地址。
 * 生产部署时前端产物由 PocketBase 同源伺服（pb_public），通常无需设置；
 * 本地开发直连默认 8090 端口，跨环境直连用 VITE_PB_URL 覆盖（见 technical-design §5.7）。
 */
export const PB_URL: string = import.meta.env.VITE_PB_URL ?? 'http://127.0.0.1:8090';

export const pb = new PocketBase(PB_URL);
