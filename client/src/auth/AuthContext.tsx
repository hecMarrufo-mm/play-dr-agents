import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: () => void;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [iap, setIap] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { user, iap } = await api.auth.me();
      setUser(user);
      setIap(iap);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(() => {
    window.location.href = api.auth.loginUrl();
  }, []);

  const logout = useCallback(async () => {
    if (iap) {
      // IAP owns the edge session — clear its cookie (lands on Google's signed-out page).
      window.location.href = '/?gcp-iap-mode=CLEAR_LOGIN_COOKIE';
      return;
    }
    await api.auth.logout().catch(() => undefined);
    setUser(null);
    window.location.href = '/login';
  }, [iap]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, refresh, login, logout }),
    [user, loading, refresh, login, logout],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
