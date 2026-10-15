"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { getValidatedAuthSession, peekValidatedAuthSession } from "@/lib/auth-session";
import {
  getDefaultRouteForRole,
  type AuthRole,
  type StoredAuthSession,
} from "@/store/auth";

type UseAuthGuardResult = {
  isCheckingAuth: boolean;
  session: StoredAuthSession | null;
};

export function useAuthGuard(allowedRoles?: AuthRole[]): UseAuthGuardResult {
  const router = useRouter();
  const allowedRolesKey = (allowedRoles || []).join(",");
  // 路由切换时如果刚校验过登录态，首帧就直接渲染页面，不再先闪一次加载态；
  // 首次加载（缓存为空）时仍与服务端预渲染的加载态保持一致，不会产生 hydration 差异。
  const [initialSession] = useState<StoredAuthSession | null>(() => {
    const cached = peekValidatedAuthSession();
    if (!cached) {
      return null;
    }
    const roleList = allowedRolesKey ? (allowedRolesKey.split(",") as AuthRole[]) : [];
    return roleList.length === 0 || roleList.includes(cached.role) ? cached : null;
  });
  const [session, setSession] = useState<StoredAuthSession | null>(initialSession);
  const [isCheckingAuth, setIsCheckingAuth] = useState(initialSession === null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const roleList = allowedRolesKey ? (allowedRolesKey.split(",") as AuthRole[]) : [];
      const storedSession = await getValidatedAuthSession();
      if (!active) {
        return;
      }

      if (!storedSession) {
        setSession(null);
        setIsCheckingAuth(false);
        router.replace("/login");
        return;
      }

      if (roleList.length > 0 && !roleList.includes(storedSession.role)) {
        setSession(storedSession);
        setIsCheckingAuth(false);
        router.replace(getDefaultRouteForRole(storedSession.role));
        return;
      }

      setSession(storedSession);
      setIsCheckingAuth(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, [allowedRolesKey, router]);

  return { isCheckingAuth, session };
}

export function useRedirectIfAuthenticated() {
  const router = useRouter();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const storedSession = await getValidatedAuthSession();
      if (!active) {
        return;
      }

      if (storedSession) {
        router.replace(getDefaultRouteForRole(storedSession.role));
        return;
      }

      setIsCheckingAuth(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, [router]);

  return { isCheckingAuth };
}
