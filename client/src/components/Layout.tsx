import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/** App shell: top navigation + routed page content. */
export function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="topbar">
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Agents
          </NavLink>
          <NavLink to="/files" className={({ isActive }) => (isActive ? 'active' : '')}>
            Files
          </NavLink>
          {user?.role === 'ADMIN' && (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
              Admin
            </NavLink>
          )}
        </nav>
        <div className="topbar-right">
          {user && (
            <div className="user-chip" title={user.email}>
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="avatar" referrerPolicy="no-referrer" />
              ) : (
                <span className="avatar avatar-fallback">{user.name.charAt(0).toUpperCase()}</span>
              )}
              <span className="user-name">{user.name}</span>
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
