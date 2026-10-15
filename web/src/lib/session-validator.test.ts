import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionValidator, type SessionLike } from "./session-validator.ts";

type Session = SessionLike;

const adminSession: Session = { key: "k1", role: "admin", subjectId: "s1", name: "Admin" };

/** 搭一个可控的校验器：本地存储、服务端校验次数、时钟、登录态版本号都在测试里可见。 */
function setup(
  options: {
    ttlMs?: number;
    validate?: (stored: Session) => Promise<Session>;
    /** 回写会话时是否像真实实现那样更新版本号（会话内容有变化才更新） */
    bumpEpochOnWrite?: boolean;
  } = {},
) {
  let stored: Session | null = adminSession;
  let clock = 1_000;
  let epoch = "e0";
  const calls = { validate: 0, write: 0, clear: 0 };

  const validator = createSessionValidator<Session>({
    ttlMs: options.ttlMs ?? 60_000,
    now: () => clock,
    readEpoch: () => epoch,
    readStored: async () => stored,
    validate: async (s) => {
      calls.validate += 1;
      return options.validate ? options.validate(s) : { ...s };
    },
    writeStored: async (s) => {
      calls.write += 1;
      if (options.bumpEpochOnWrite) {
        epoch = `${epoch}+`;
      }
      stored = s;
    },
    clearStored: async () => {
      calls.clear += 1;
      stored = null;
    },
  });

  return {
    validator,
    calls,
    setStored: (next: Session | null) => {
      stored = next;
    },
    /** 模拟别的标签页登录 / 换号 / 登出：本地登录态版本号变化 */
    bumpEpoch: () => {
      epoch = `${epoch}!`;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("没有本地会话时直接返回 null，不请求服务端", async () => {
  const { validator, calls, setStored } = setup();
  setStored(null);
  assert.equal(await validator.get(), null);
  assert.equal(calls.validate, 0);
});

test("并发调用共享同一次校验（侧栏 + 页面守卫同时触发）", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { validator, calls } = setup({
    validate: async (s) => {
      await gate;
      return { ...s };
    },
  });

  const first = validator.get();
  const second = validator.get();
  // 两个调用都先读完本地存储，再并入同一个在途请求
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.validate, 1);
  assert.equal(a, b);
  assert.equal(a?.role, "admin");
});

test("TTL 内复用校验结果，过期后重新校验", async () => {
  const { validator, calls, advance } = setup({ ttlMs: 60_000 });

  await validator.get();
  assert.equal(calls.validate, 1);

  advance(59_000);
  await validator.get();
  assert.equal(calls.validate, 1, "未过期时不应再请求");

  advance(2_000);
  await validator.get();
  assert.equal(calls.validate, 2, "过期后应重新校验");
});

test("TTL 内返回同一个对象引用，避免下游 effect 因引用变化重复执行", async () => {
  const { validator, advance } = setup();
  const first = await validator.get();
  advance(1_000);
  const second = await validator.get();
  assert.equal(first, second);
});

test("本地会话被改写（换密钥 / 角色变化）时立即重新校验", async () => {
  const { validator, calls, setStored } = setup();
  await validator.get();
  assert.equal(calls.validate, 1);

  setStored({ ...adminSession, key: "k2" });
  await validator.get();
  assert.equal(calls.validate, 2, "换密钥后必须重新校验");

  setStored({ key: "k2", role: "user", subjectId: "s1", name: "Admin" });
  await validator.get();
  assert.equal(calls.validate, 3, "角色变化后必须重新校验");
});

test("校验失败：清理本地并返回 null，且失败结果不会被缓存", async () => {
  let shouldFail = true;
  const { validator, calls, setStored } = setup({
    validate: async (s) => {
      if (shouldFail) throw new Error("401");
      return { ...s };
    },
  });

  assert.equal(await validator.get(), null);
  assert.equal(calls.clear, 1);
  assert.equal(validator.peek(), null);

  // 用户重新登录（本地又有了会话）后应能重新校验成功
  shouldFail = false;
  setStored(adminSession);
  const session = await validator.get();
  assert.equal(session?.key, "k1");
  assert.equal(calls.validate, 2);
});

test("校验成功会把服务端返回的最新会话回写本地", async () => {
  const { validator, calls } = setup({
    validate: async (s) => ({ ...s, role: "user", name: "Renamed" }),
  });
  const session = await validator.get();
  assert.equal(calls.write, 1);
  assert.equal(session?.role, "user");
  assert.equal(session?.name, "Renamed");
});

test("peek 只返回未过期的校验结果；invalidate 后立即失效", async () => {
  const { validator, advance } = setup({ ttlMs: 10_000 });
  assert.equal(validator.peek(), null, "从未校验过");

  await validator.get();
  assert.equal(validator.peek()?.key, "k1");

  advance(10_001);
  assert.equal(validator.peek(), null, "过期后不应再被乐观使用");

  advance(-10_001);
  assert.ok(validator.peek());
  validator.invalidate();
  assert.equal(validator.peek(), null);
});

test("本地会话被清空（登出）后缓存同步失效", async () => {
  const { validator, calls, setStored } = setup();
  await validator.get();
  setStored(null);
  assert.equal(await validator.get(), null);
  assert.equal(validator.peek(), null);

  setStored(adminSession);
  await validator.get();
  assert.equal(calls.validate, 2, "登出后再登录同一个密钥也应重新校验一次");
});

test("别的标签页登录 / 换号 / 登出（版本号变化）后，缓存立即失效：get 重新校验，peek 不再乐观放行", async () => {
  const { validator, calls, bumpEpoch } = setup();
  await validator.get();
  assert.equal(calls.validate, 1);
  assert.ok(validator.peek());

  bumpEpoch();

  assert.equal(validator.peek(), null, "版本号变了，不能再按旧结果乐观渲染");
  await validator.get();
  assert.equal(calls.validate, 2, "版本号变了，必须重新向服务端校验");
});

test("校验结果回写本地时引起的版本号变化，不会让这一次刚校验好的缓存立刻失效", async () => {
  // 例如服务端返回了新的角色/名称：回写会改动本地会话并更新版本号
  const { validator, calls } = setup({
    bumpEpochOnWrite: true,
    validate: async (s) => ({ ...s, name: "Renamed" }),
  });

  await validator.get();
  assert.equal(calls.validate, 1);
  assert.ok(validator.peek(), "刚校验完的结果应当可以直接复用");

  await validator.get();
  assert.equal(calls.validate, 1, "TTL 内不应因为自己的回写而重复校验");
});
