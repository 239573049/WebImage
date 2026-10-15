import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createImageConversationStore,
  hasPersistentConversationChanges,
  type ConversationStorage,
  type ImageConversation,
  type ImageTurn,
  type StoredImage,
} from "./image-conversation-store.ts";

/** 内存版存储：行为对齐 localforage（读写都做结构化克隆），并记录每次访问了哪些 key。 */
function createMemoryStorage() {
  const data = new Map<string, unknown>();
  const accessLog: Array<{ op: "get" | "set" | "remove" | "iterate" | "clear"; key?: string }> = [];
  const failures = { getLegacyOnce: false };

  const storage: ConversationStorage = {
    async getItem<T>(key: string) {
      accessLog.push({ op: "get", key });
      if (key === "items" && failures.getLegacyOnce) {
        failures.getLegacyOnce = false;
        throw new Error("idb unavailable");
      }
      return (data.has(key) ? structuredClone(data.get(key)) : null) as T | null;
    },
    async setItem<T>(key: string, value: T) {
      accessLog.push({ op: "set", key });
      data.set(key, structuredClone(value));
      return value;
    },
    async removeItem(key: string) {
      accessLog.push({ op: "remove", key });
      data.delete(key);
    },
    async clear() {
      accessLog.push({ op: "clear" });
      data.clear();
    },
    async iterate<T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U) {
      accessLog.push({ op: "iterate" });
      let index = 0;
      for (const [key, value] of [...data]) {
        index += 1;
        const result = iteratee(structuredClone(value) as T, key, index);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined as U;
    },
  };

  return { storage, data, accessLog, failures };
}

function image(id: string, overrides: Partial<StoredImage> = {}): StoredImage {
  return { id, taskId: id, status: "loading", ...overrides };
}

function turn(id: string, images: StoredImage[], overrides: Partial<ImageTurn> = {}): ImageTurn {
  return {
    id,
    prompt: `prompt-${id}`,
    model: "gpt-image-2",
    mode: "generate",
    referenceImages: [],
    count: images.length,
    size: "1024x1024",
    ratio: "1:1",
    tier: "1k",
    quality: "auto",
    images,
    createdAt: "2026-10-01T00:00:00.000Z",
    status: "generating",
    ...overrides,
  };
}

function conversation(id: string, updatedAt: string, overrides: Partial<ImageConversation> = {}): ImageConversation {
  return {
    id,
    title: `title-${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    turns: [turn(`${id}-t1`, [image(`${id}-i1`)])],
    ...overrides,
  };
}

const T1 = "2026-10-01T00:00:01.000Z";
const T2 = "2026-10-01T00:00:02.000Z";
const T3 = "2026-10-01T00:00:03.000Z";

// ---------------------------------------------------------------------------
// 持久化引擎
// ---------------------------------------------------------------------------

test("保存后能读回，并按 updatedAt 倒序排列", async () => {
  const { storage } = createMemoryStorage();
  const store = createImageConversationStore(storage);

  await store.save(conversation("a", T1));
  await store.save(conversation("b", T3));
  await store.save(conversation("c", T2));

  const items = await store.list();
  assert.deepEqual(
    items.map((item) => item.id),
    ["b", "c", "a"],
  );
});

test("保存一个会话只读写它自己那条记录，不碰其他会话（修复整库读写）", async () => {
  const { storage, accessLog } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  await store.save(conversation("a", T1));
  await store.save(conversation("b", T1));
  await store.list(); // 触发迁移检查，之后只关心保存路径
  accessLog.length = 0;

  await store.save(conversation("a", T2));

  const touched = accessLog.filter((entry) => entry.op !== "iterate").map((entry) => `${entry.op}:${entry.key}`);
  assert.deepEqual(touched, ["get:conversation:a", "set:conversation:a"]);
});

test("每个会话各存一条 conversation:<id>，不再写旧的 items 大数组", async () => {
  const { storage, data } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  await store.save(conversation("a", T1));
  await store.save(conversation("b", T2));

  assert.deepEqual([...data.keys()].sort(), ["conversation:a", "conversation:b"]);
});

test("较旧的版本不会覆盖已存的较新版本（多标签页并发写）", async () => {
  const { storage, data } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  await store.save(conversation("a", T3, { title: "newer" }));

  await store.save(conversation("a", T1, { title: "stale" }));

  assert.equal((data.get("conversation:a") as ImageConversation).title, "newer");
});

test("saveMany 只写入传入的会话", async () => {
  const { storage, accessLog } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  await store.save(conversation("a", T1));
  await store.save(conversation("b", T1));
  await store.save(conversation("c", T1));
  accessLog.length = 0;

  await store.saveMany([conversation("a", T2), conversation("c", T2)]);

  const written = accessLog.filter((entry) => entry.op === "set").map((entry) => entry.key);
  assert.deepEqual(written, ["conversation:a", "conversation:c"]);
});

test("重命名：更新标题并刷新 updatedAt；会话不存在时什么都不做", async () => {
  const { storage, data } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  await store.save(conversation("a", T1));

  await store.rename("a", "新标题");
  const renamed = data.get("conversation:a") as ImageConversation;
  assert.equal(renamed.title, "新标题");
  assert.ok(renamed.updatedAt > T1, "重命名应刷新 updatedAt");

  await store.rename("missing", "x");
  assert.equal(data.has("conversation:missing"), false);
});

test("删除与清空", async () => {
  const { storage, data } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  await store.save(conversation("a", T1));
  await store.save(conversation("b", T1));

  await store.remove("a");
  assert.deepEqual(
    (await store.list()).map((item) => item.id),
    ["b"],
  );

  await store.clear();
  assert.equal(data.size, 0);
  assert.deepEqual(await store.list(), []);
});

// ---------------------------------------------------------------------------
// 旧数据迁移
// ---------------------------------------------------------------------------

test("首次读取会把旧的 items 大数组迁移成按会话存储，并删除旧 key", async () => {
  const { storage, data } = createMemoryStorage();
  data.set("items", [
    conversation("a", T1),
    // 更早版本的扁平结构（没有 turns）也要能被规范化后迁移
    { id: "legacy-flat", title: "old", prompt: "p", images: [{ id: "x", b64_json: "AAAA" }], createdAt: T1, updatedAt: T2 },
  ]);
  const store = createImageConversationStore(storage);

  const items = await store.list();

  assert.deepEqual(items.map((item) => item.id).sort(), ["a", "legacy-flat"]);
  assert.equal(data.has("items"), false, "迁移完成后应移除旧 key");
  assert.deepEqual([...data.keys()].sort(), ["conversation:a", "conversation:legacy-flat"]);
  const flat = items.find((item) => item.id === "legacy-flat")!;
  assert.equal(flat.turns.length, 1);
  assert.equal(flat.turns[0].images[0].status, "success", "有 b64_json 的旧图片应被识别为成功");
});

test("迁移发生在任何写入之前：先保存新会话不会丢掉旧数据", async () => {
  const { storage, data } = createMemoryStorage();
  data.set("items", [conversation("old", T1)]);
  const store = createImageConversationStore(storage);

  await store.save(conversation("new", T2));

  assert.deepEqual(
    (await store.list()).map((item) => item.id),
    ["new", "old"],
  );
});

test("迁移之后删除的会话不会因为旧数据被复活", async () => {
  const { storage, data } = createMemoryStorage();
  data.set("items", [conversation("a", T1), conversation("b", T2)]);
  const store = createImageConversationStore(storage);

  await store.remove("a");

  assert.deepEqual(
    (await store.list()).map((item) => item.id),
    ["b"],
  );
});

test("迁移是幂等的：新旧两边都有同一个会话时保留更新的那份", async () => {
  const { storage, data } = createMemoryStorage();
  // 模拟上次迁移被打断：a 已经有了新格式且更新，b 的新格式比旧数据更旧
  data.set("conversation:a", conversation("a", T3, { title: "a-newer-new-format" }));
  data.set("conversation:b", conversation("b", T1, { title: "b-older-new-format" }));
  data.set("items", [conversation("a", T1, { title: "a-legacy" }), conversation("b", T2, { title: "b-legacy-newer" })]);
  const store = createImageConversationStore(storage);

  const items = await store.list();

  const byId = Object.fromEntries(items.map((item) => [item.id, item.title]));
  assert.equal(byId.a, "a-newer-new-format");
  assert.equal(byId.b, "b-legacy-newer");
  assert.equal(data.has("items"), false);
});

test("迁移失败时不丢数据，下次访问会重试", async () => {
  const { storage, data, failures } = createMemoryStorage();
  data.set("items", [conversation("a", T1)]);
  failures.getLegacyOnce = true;
  const store = createImageConversationStore(storage);

  await assert.rejects(store.list(), /idb unavailable/);
  assert.equal(data.has("items"), true, "失败时旧数据必须保留");

  const items = await store.list();
  assert.deepEqual(
    items.map((item) => item.id),
    ["a"],
  );
  assert.equal(data.has("items"), false);
});

test("迁移只做一次：之后的读写不再访问旧 key", async () => {
  const { storage, accessLog } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  await store.list();
  accessLog.length = 0;

  await store.save(conversation("a", T1));
  await store.list();
  await store.rename("a", "x");

  assert.equal(
    accessLog.some((entry) => entry.key === "items"),
    false,
  );
});

test("没有旧数据（新用户）时迁移是空操作", async () => {
  const { storage, data } = createMemoryStorage();
  const store = createImageConversationStore(storage);
  assert.deepEqual(await store.list(), []);
  assert.equal(data.size, 0);
});

test("旧 key 的内容格式异常时不删除它", async () => {
  const { storage, data } = createMemoryStorage();
  data.set("items", { not: "an array" });
  const store = createImageConversationStore(storage);

  assert.deepEqual(await store.list(), []);
  assert.deepEqual(data.get("items"), { not: "an array" });
});

// ---------------------------------------------------------------------------
// hasPersistentConversationChanges：轮询的纯进度变化不落盘
// ---------------------------------------------------------------------------

function withImages(base: ImageConversation, images: StoredImage[], turnOverrides: Partial<ImageTurn> = {}) {
  return {
    ...base,
    turns: [{ ...base.turns[0], ...turnOverrides, images }, ...base.turns.slice(1)],
  };
}

test("只有进度/耗时/updatedAt 变化时不需要写盘", () => {
  const before = conversation("a", T1);
  const after: ImageConversation = {
    ...withImages(before, [
      image("a-i1", { taskStatus: "running", progress: "generating", startTime: 1, elapsedSecs: 4.2, elapsedUpdatedAt: 99 }),
    ]),
    updatedAt: T3,
  };
  assert.equal(hasPersistentConversationChanges(before, after), false);
});

test("没有变化（同一个对象）时不需要写盘；首次保存（previous 为空）需要", () => {
  const same = conversation("a", T1);
  assert.equal(hasPersistentConversationChanges(same, same), false);
  assert.equal(hasPersistentConversationChanges(null, same), true);
});

test("图片出结果 / 失败 / 状态流转 / 新增轮次 / 改标题都必须写盘", () => {
  const before = conversation("a", T1);

  const succeeded = withImages(before, [image("a-i1", { status: "success", b64_json: "AAAA", durationMs: 9000 })]);
  assert.equal(hasPersistentConversationChanges(before, succeeded), true, "出结果");

  const failed = withImages(before, [image("a-i1", { status: "error", error: "超时" })]);
  assert.equal(hasPersistentConversationChanges(before, failed), true, "失败");

  const flipped = withImages(before, before.turns[0].images, { status: "success" });
  assert.equal(hasPersistentConversationChanges(before, flipped), true, "整轮状态变化");

  const extraTurn: ImageConversation = { ...before, turns: [...before.turns, turn("a-t2", [image("a-i2")])] };
  assert.equal(hasPersistentConversationChanges(before, extraTurn), true, "新增轮次");

  assert.equal(hasPersistentConversationChanges(before, { ...before, title: "renamed" }), true, "改标题");

  const fewerImages = withImages(before, []);
  assert.equal(hasPersistentConversationChanges(before, fewerImages), true, "图片数量变化");
});

test("纯进度变化与真实变化混在一起时仍然判定需要写盘", () => {
  const before: ImageConversation = {
    ...conversation("a", T1),
    turns: [turn("a-t1", [image("i1"), image("i2")])],
  };
  const after = withImages(before, [
    image("i1", { taskStatus: "running", elapsedSecs: 3 }),
    image("i2", { status: "success", b64_json: "AAAA" }),
  ]);
  assert.equal(hasPersistentConversationChanges(before, after), true);
});
