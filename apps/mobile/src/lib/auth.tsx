import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, type LoginInput, type RegisterInput, type UpdateMeInput, type User } from "@nova/shared";

import { api, setApiToken, setUnauthorizedHandler } from "./api";

const TOKEN_KEY = "nova.jwt";

type AuthStatus = "loading" | "signedOut" | "signedIn";

type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  signIn: (input: LoginInput) => Promise<void>;
  signUp: (input: RegisterInput) => Promise<void>;
  signOut: () => Promise<void>;
  updateMe: (input: UpdateMeInput) => Promise<User>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  const signOut = useCallback(async () => {
    setApiToken(null);
    setUser(null);
    setStatus("signedOut");
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
  }, []);

  // Any 401 from the API logs the user out.
  useEffect(() => {
    setUnauthorizedHandler(() => void signOut());
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  // Restore session on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
      if (!token) {
        if (!cancelled) setStatus("signedOut");
        return;
      }
      setApiToken(token);
      try {
        const { user } = await api.auth.me();
        if (cancelled) return;
        setUser(user);
        setStatus("signedIn");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          await signOut();
        } else {
          // API unreachable: keep the token and let the user retry from the login screen.
          setStatus("signedOut");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signOut]);

  const finishAuth = useCallback(async (token: string, u: User) => {
    setApiToken(token);
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    setUser(u);
    setStatus("signedIn");
  }, []);

  const signIn = useCallback(
    async (input: LoginInput) => {
      const res = await api.auth.login(input);
      await finishAuth(res.token, res.user);
    },
    [finishAuth],
  );

  const signUp = useCallback(
    async (input: RegisterInput) => {
      const res = await api.auth.register(input);
      await finishAuth(res.token, res.user);
    },
    [finishAuth],
  );

  const updateMe = useCallback(async (input: UpdateMeInput) => {
    const { user } = await api.auth.updateMe(input);
    setUser(user);
    return user;
  }, []);

  const refreshUser = useCallback(async () => {
    const { user } = await api.auth.me();
    setUser(user);
  }, []);

  const value = useMemo(
    () => ({ status, user, signIn, signUp, signOut, updateMe, refreshUser }),
    [status, user, signIn, signUp, signOut, updateMe, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
