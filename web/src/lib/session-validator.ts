/**
 * 登录态校验器：对"向服务端校验密钥"这一步做并发合并 + 短时缓存。
 *
 * 侧栏和每个页面的守卫都会各自校验一次登录态，原先每次路由切换都会打两遍 /auth/login，
 * 页面还要等它返回才开始渲染。这里让同一密钥在 TTL 内只校验一次，并发的调用共享同一个请求。
 * 密钥被吊销时，任意业务接口的 401 仍会立刻把用户踢回登录页（见 request.ts），所以不会因此放行失效密钥。
 *
 * 这个文件刻意不依赖 `@/` 别名和浏览器 API，便于直接用 node:test 做单元测试。
 */

export type SessionLike = {
  key: string;
  role: string;
  subjectId: string;
  name: string;
};

export type SessionValidatorDeps<S extends SessionLike> = {
  /** 读取本地保存的会话；没有则返回 null */
  readStored: () => Promise<S | null>;
  /** 向服务端校验并返回最新会话；校验失败应抛错 */
  validate: (stored: S) => Promise<S>;
  /** 校验成功后回写本地 */
  writeStored: (session: S) => Promise<void>;
  /** 校验失败后清理本地 */
  clearStored: () => Promise<void>;
  /** 校验结果的有效期 */
  ttlMs: number;
  /**
   * 本地登录态的"版本号"（登录/换号/登出时变化，应当同步读取且跨标签页共享）。
   * 缓存只在版本号未变时才有效：别的标签页换号或登出后，这里不会继续按旧结果放行。
   */
  readEpoch?: () => string;
  now?: () => number;
};

function sameSession(a: SessionLike, b: SessionLike) {
  return a.key === b.key && a.role === b.role && a.subjectId === b.subjectId && a.name === b.name;
}

export function createSessionValidator<S extends SessionLike>(deps: SessionValidatorDeps<S>) {
  const now = deps.now ?? Date.now;
  const currentEpoch = () => deps.readEpoch?.() ?? "";
  let validated: { session: S; at: number; epoch: string } | null = null;
  let inflight: { key: string; promise: Promise<S | null> } | null = null;

  const isFresh = (entry: { at: number; epoch: string }) =>
    now() - entry.at < deps.ttlMs && entry.epoch === currentEpoch();

  async function get(): Promise<S | null> {
    const stored = await deps.readStored();
    if (!stored) {
      validated = null;
      return null;
    }

    // 本地会话与最近一次校验通过的结果完全一致、且仍在有效期内：不再打网络请求。
    // 本地会话被别处改写（换了密钥、角色变化）时两者不一致，会自然走到下面重新校验。
    if (validated && isFresh(validated) && sameSession(validated.session, stored)) {
      return validated.session;
    }

    if (inflight && inflight.key === stored.key) {
      return inflight.promise;
    }

    const run = async (): Promise<S | null> => {
      try {
        const next = await deps.validate(stored);
        await deps.writeStored(next);
        // 版本号要在回写之后读：回写会话内容有变化时本身会更新版本号，这一次变化不算"别人改过"
        validated = { session: next, at: now(), epoch: currentEpoch() };
        return next;
      } catch {
        validated = null;
        await deps.clearStored();
        return null;
      }
    };
    const promise: Promise<S | null> = run().finally(() => {
      if (inflight?.promise === promise) {
        inflight = null;
      }
    });
    inflight = { key: stored.key, promise };
    return promise;
  }

  /** 同步读取"最近校验通过且未过期"的会话，用于路由切换时跳过加载态；没有则返回 null。 */
  function peek(): S | null {
    return validated && isFresh(validated) ? validated.session : null;
  }

  /** 登出或更换密钥后丢弃缓存。 */
  function invalidate() {
    validated = null;
    inflight = null;
  }

  return { get, peek, invalidate };
}
