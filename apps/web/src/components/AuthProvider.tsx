"use client";

import { ApiError, type LoginInput, type RegisterInput, type User } from "@nova/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, readToken, setUnauthorizedHandler, TOKEN_KEY, USER_KEY } from "@/lib/api";

type Status = "loading" | "authed" | "anon";

type AuthContextValue = {
  status: Status;
  user: User | null;
  login: (input: LoginInput) => Promise<User>;
  register: (input: RegisterInput) => Promise<User>;
  logout: () => void;
  /** Replace the cached user (e.g. after PATCH /auth/me). */
  setUser: (user: User) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function persist(token: string | null, user: User | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
    if (user) window.localStorage.setItem(USER_KEY, JSON.stringify(user));
    else window.localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUserState] = useState<User | null>(null);

  const logout = useCallback(() => {
    persist(null, null);
    setUserState(null);
    setStatus("anon");
  }, []);

  // Restore the session on the client only (localStorage doesn't exist during SSR).
  useEffect(() => {
    setUnauthorizedHandler(logout);
    const token = readToken();
    if (!token) {
      setStatus("anon");
      return () => setUnauthorizedHandler(null);
    }
    let cached: User | null = null;
    try {
      const raw = window.localStorage.getItem(USER_KEY);
      cached = raw ? (JSON.parse(raw) as User) : null;
    } catch {
      cached = null;
    }
    if (cached) {
      setUserState(cached);
      setStatus("authed");
    }
    // Revalidate in the background; a 401 triggers logout via onUnauthorized.
    api.auth
      .me()
      .then(({ user }) => {
        persist(token, user);
        setUserState(user);
        setStatus("authed");
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) return logout();
        // API unreachable: keep the cached session if we have one.
        if (!cached) setStatus("anon");
      });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const login = useCallback(async (input: LoginInput) => {
    const res = await api.auth.login(input);
    persist(res.token, res.user);
    setUserState(res.user);
    setStatus("authed");
    return res.user;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const res = await api.auth.register(input);
    persist(res.token, res.user);
    setUserState(res.user);
    setStatus("authed");
    return res.user;
  }, []);

  const setUser = useCallback((u: User) => {
    persist(readToken(), u);
    setUserState(u);
  }, []);

  const value = useMemo(
    () => ({ status, user, login, register, logout, setUser }),
    [status, user, login, register, logout, setUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
