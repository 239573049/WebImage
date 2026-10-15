"use client";

import localforage from "localforage";

export type AuthRole = "admin" | "user";

export type StoredAuthSession = {
  key: string;
  role: AuthRole;
  subjectId: string;
  name: string;
};

export const AUTH_KEY_STORAGE_KEY = "chatgpt2api_auth_key";
export const AUTH_SESSION_STORAGE_KEY = "chatgpt2api_auth_session";
export const AUTH_EPOCH_STORAGE_KEY = "chatgpt2api_auth_epoch";

const authStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "auth",
});

/**
 * 登录态"版本号"：登录、换密钥、登出时才会变化。
 * 放在 localStorage（同步读取、跨标签页共享）里，调用方不用读异步的 IndexedDB，
 * 就能判断"别的标签页是否改过登录态"——校验结果的缓存靠它保证不会在换号/登出后继续被复用。
 */
export function getAuthEpoch() {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(AUTH_EPOCH_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function bumpAuthEpoch() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(AUTH_EPOCH_STORAGE_KEY, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  } catch {
    // localStorage 不可用时只是少了跨标签页保护，不影响功能
  }
}

function normalizeSession(value: unknown, fallbackKey = ""): StoredAuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredAuthSession>;
  const key = String(candidate.key || fallbackKey || "").trim();
  const role = candidate.role === "admin" || candidate.role === "user" ? candidate.role : null;
  if (!key || !role) {
    return null;
  }

  return {
    key,
    role,
    subjectId: String(candidate.subjectId || "").trim(),
    name: String(candidate.name || "").trim(),
  };
}

export function getDefaultRouteForRole(role: AuthRole) {
  return role === "admin" ? "/accounts" : "/image";
}

export async function getStoredAuthKey() {
  if (typeof window === "undefined") {
    return "";
  }
  const value = await authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY);
  return String(value || "").trim();
}

export async function getStoredAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const [storedKey, storedSession] = await Promise.all([
    authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY),
    authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY),
  ]);

  const normalizedSession = normalizeSession(storedSession, String(storedKey || ""));
  if (normalizedSession) {
    if (normalizedSession.key !== String(storedKey || "").trim()) {
      await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key);
    }
    return normalizedSession;
  }

  if (String(storedKey || "").trim()) {
    await clearStoredAuthSession();
  }
  return null;
}

export async function setStoredAuthSession(session: StoredAuthSession) {
  const normalizedSession = normalizeSession(session);
  if (!normalizedSession) {
    await clearStoredAuthSession();
    return;
  }

  // 内容没变（比如定期校验后回写同一份会话）就不写盘、不更新版本号，
  // 否则每次校验都会让其他标签页的校验缓存失效
  const [storedKey, storedSession] = await Promise.all([
    authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY),
    authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY),
  ]);
  const current = normalizeSession(storedSession, String(storedKey || ""));
  if (
    current &&
    current.key === normalizedSession.key &&
    current.role === normalizedSession.role &&
    current.subjectId === normalizedSession.subjectId &&
    current.name === normalizedSession.name &&
    String(storedKey || "").trim() === normalizedSession.key
  ) {
    return;
  }

  await Promise.all([
    authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key),
    authStorage.setItem(AUTH_SESSION_STORAGE_KEY, normalizedSession),
  ]);
  bumpAuthEpoch();
}

export async function setStoredAuthKey(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  if (!normalizedAuthKey) {
    await clearStoredAuthSession();
    return;
  }
  await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedAuthKey);
  bumpAuthEpoch();
}

export async function clearStoredAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  await Promise.all([
    authStorage.removeItem(AUTH_KEY_STORAGE_KEY),
    authStorage.removeItem(AUTH_SESSION_STORAGE_KEY),
  ]);
  bumpAuthEpoch();
}

export async function clearStoredAuthKey() {
  await clearStoredAuthSession();
}
