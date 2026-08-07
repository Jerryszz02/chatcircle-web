import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { currentRole } from '../../../shared/auth';

/**
 * 参与者端公开页（首页 / 活动与问卷页）右上角入口：
 * 按当前有效会话角色指向对应面板（单会话互斥，见 shared/auth.ts）；
 * 未登录时展示聚合参与者/机构管理员/超级管理员三类登录入口的「登录」菜单。
 */
export function HeaderActions() {
  const role = currentRole();
  if (role === 'participant') {
    return (
      <Link to="/me" className="cc-btn cc-btn-secondary">
        我的中心
      </Link>
    );
  }
  if (role === 'admin') {
    return (
      <Link to="/admin/activities" className="cc-btn cc-btn-secondary">
        机构管理面板
      </Link>
    );
  }
  if (role === 'super') {
    return (
      <Link to="/super/dashboard" className="cc-btn cc-btn-secondary">
        超级管理面板
      </Link>
    );
  }
  return <LoginMenu />;
}

/**
 * 顶部「登录」入口：聚合参与者/机构管理员/超级管理员三类登录。
 * 点击展开菜单，点击外部或按 Escape 收起。
 */
function LoginMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="ccp-login-menu" ref={rootRef}>
      <button
        type="button"
        className="cc-btn cc-btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        登录
      </button>
      {open ? (
        <div className="ccp-login-menu-list" role="menu" aria-label="选择登录身份">
          <Link role="menuitem" to="/login" onClick={() => setOpen(false)}>
            参与者登录
          </Link>
          <Link role="menuitem" to="/admin/login" onClick={() => setOpen(false)}>
            机构管理员登录
          </Link>
          <Link role="menuitem" to="/super/login" onClick={() => setOpen(false)}>
            超级管理员登录
          </Link>
        </div>
      ) : null}
    </div>
  );
}
