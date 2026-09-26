import { ClientOnly } from '../../../public/ClientOnly';
import { DefaultAccountLink } from './DefaultAccountLink';
import { HeaderActions } from './HeaderActions';

/**
 * 站点头部账号区（SPA / hydrate 客户端专用）。
 *
 * HeaderActions 依赖 localStorage 会话，不能进入服务端渲染图：
 * 挂载前渲染 DefaultAccountLink（与服务端输出逐字节一致），
 * 挂载后按当前会话角色切换为「我的中心 / 管理面板 / 登录菜单」。
 */
export function AccountActions() {
  return (
    <ClientOnly placeholder={<DefaultAccountLink />}>
      <HeaderActions />
    </ClientOnly>
  );
}
