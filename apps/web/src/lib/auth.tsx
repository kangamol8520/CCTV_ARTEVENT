import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "./api";
import type { AuthUser, Role } from "../types";

interface AuthCtx { user: AuthUser | null; loading: boolean; login: (u: string, p: string) => Promise<void>; logout: () => void; can: (min: Role) => boolean }
const Ctx = createContext<AuthCtx>(null!);
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api<AuthUser>("/api/auth/me").then(setUser).catch(() => setToken(null)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const h = () => setUser(null);
    window.addEventListener("cctv:unauthorized", h);
    return () => window.removeEventListener("cctv:unauthorized", h);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ token: string; user: AuthUser }>("/api/auth/login", { method: "POST", json: { username, password } });
    setToken(r.token);
    setUser(r.user);
  }, []);
  const logout = useCallback(() => { setToken(null); setUser(null); }, []);
  const can = useCallback((min: Role) => !!user && RANK[user.role] >= RANK[min], [user]);

  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
