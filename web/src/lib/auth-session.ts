"use client";

import { login } from "@/lib/api";
import { createSessionValidator } from "@/lib/session-validator";
import { clearStoredAuthSession, getAuthEpoch, getStoredAuthSession, setStoredAuthSession, type StoredAuthSession } from "@/store/auth";

// 同一密钥在这个窗口内只向服务端校验一次，路由切换不再每次都等一个 /auth/login 往返。
const VALIDATION_TTL_MS = 60_000;

const validator = createSessionValidator<StoredAuthSession>({
  readStored: getStoredAuthSession,
  validate: async (stored) => {
    const data = await login(stored.key);
    return {
      key: stored.key,
      role: data.role,
      subjectId: data.subject_id,
      name: data.name,
    };
  },
  writeStored: setStoredAuthSession,
  clearStored: clearStoredAuthSession,
  readEpoch: getAuthEpoch,
  ttlMs: VALIDATION_TTL_MS,
});

export const getValidatedAuthSession = validator.get;
export const peekValidatedAuthSession = validator.peek;
export const invalidateValidatedAuthSession = validator.invalidate;
