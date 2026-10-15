/**
 * 生图会话的数据模型与持久化引擎。
 *
 * 这个文件刻意不依赖 localforage 和浏览器 API（存储实现由调用方注入），
 * 这样可以直接用 node:test 配合内存存储做单元测试；浏览器里的实际存储见 image-conversations.ts。
 */
import type { ImageModel } from "@/lib/api";

export type ImageConversationMode = "generate" | "edit";

export type StoredReferenceImage = {
  name: string;
  type: string;
  dataUrl: string;
};

export type StoredImage = {
  id: string;
  taskId?: string;
  status?: "loading" | "success" | "error";
  taskStatus?: "queued" | "running";
  progress?: string;
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  error?: string;
  startTime?: number;
  elapsedSecs?: number;
  elapsedUpdatedAt?: number;
  durationMs?: number;
};

export type ImageTurnStatus = "queued" | "generating" | "success" | "error";

export type ImageTurn = {
  id: string;
  prompt: string;
  model: ImageModel;
  mode: ImageConversationMode;
  referenceImages: StoredReferenceImage[];
  count: number;
  size: string;
  ratio: string;
  tier: string;
  quality: string;
  images: StoredImage[];
  createdAt: string;
  status: ImageTurnStatus;
  error?: string;
  promptDeleted?: boolean;
  resultsDeleted?: boolean;
};

export type ImageConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ImageTurn[];
};

export type ImageConversationStats = {
  queued: number;
  running: number;
};

/** 存储层依赖的最小接口：localforage 实例天然满足，测试里可以换成内存实现。 */
export type ConversationStorage = {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  iterate<T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U): Promise<U>;
};

// 旧版本把所有会话放在这一个 key 里：每次保存都要把整库（含全部 base64 图片）读出来再整体写回，
// 轮询期间每 2 秒一次，主线程会被反复阻塞。现在每个会话单独一条记录，保存只读写被修改的那一个。
const LEGACY_ITEMS_KEY = "items";
const CONVERSATION_KEY_PREFIX = "conversation:";
const conversationKey = (id: string) => `${CONVERSATION_KEY_PREFIX}${id}`;

function normalizeStoredImage(image: StoredImage): StoredImage {
  const normalized = {
    ...image,
    taskId: typeof image.taskId === "string" && image.taskId ? image.taskId : undefined,
    taskStatus: image.taskStatus === "queued" || image.taskStatus === "running" ? image.taskStatus : undefined,
    url: typeof image.url === "string" && image.url ? image.url : undefined,
    revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
    startTime: typeof image.startTime === "number" ? image.startTime : undefined,
    elapsedSecs: typeof image.elapsedSecs === "number" ? image.elapsedSecs : undefined,
    elapsedUpdatedAt: typeof image.elapsedUpdatedAt === "number" ? image.elapsedUpdatedAt : undefined,
    durationMs: typeof image.durationMs === "number" ? image.durationMs : undefined,
  };
  if (image.status === "loading" || image.status === "error" || image.status === "success") {
    return normalized;
  }
  return {
    ...normalized,
    status: image.b64_json || image.url ? "success" : "loading",
  };
}

function normalizeReferenceImage(image: StoredReferenceImage): StoredReferenceImage {
  return {
    name: image.name || "reference.png",
    type: image.type || "image/png",
    dataUrl: image.dataUrl,
  };
}

function dataUrlMimeType(dataUrl: string) {
  const match = dataUrl.match(/^data:(.*?);base64,/);
  return match?.[1] || "image/png";
}

function getLegacyReferenceImages(source: Record<string, unknown>): StoredReferenceImage[] {
  if (Array.isArray(source.referenceImages)) {
    return source.referenceImages
      .filter((image): image is StoredReferenceImage => {
        if (!image || typeof image !== "object") {
          return false;
        }
        const candidate = image as StoredReferenceImage;
        return typeof candidate.dataUrl === "string" && candidate.dataUrl.length > 0;
      })
      .map(normalizeReferenceImage);
  }

  if (source.sourceImage && typeof source.sourceImage === "object") {
    const image = source.sourceImage as { dataUrl?: unknown; fileName?: unknown };
    if (typeof image.dataUrl === "string" && image.dataUrl) {
      return [
        {
          name: typeof image.fileName === "string" && image.fileName ? image.fileName : "reference.png",
          type: dataUrlMimeType(image.dataUrl),
          dataUrl: image.dataUrl,
        },
      ];
    }
  }

  return [];
}

function normalizeTurn(turn: ImageTurn & Record<string, unknown>): ImageTurn {
  const normalizedImages = Array.isArray(turn.images) ? turn.images.map(normalizeStoredImage) : [];
  const derivedStatus: ImageTurnStatus =
    normalizedImages.some((image) => image.status === "loading")
      ? "generating"
      : normalizedImages.some((image) => image.status === "error")
        ? "error"
        : "success";

  return {
    id: String(turn.id || `${Date.now()}`),
    prompt: String(turn.prompt || ""),
    model: (turn.model as ImageModel) || "gpt-image-2",
    mode: turn.mode === "edit" ? "edit" : "generate",
    referenceImages: getLegacyReferenceImages(turn),
    count: Math.max(1, Number(turn.count || normalizedImages.length || 1)),
    size: typeof turn.size === "string" ? turn.size : "",
    ratio: typeof turn.ratio === "string" && turn.ratio ? turn.ratio : "1:1",
    tier: typeof turn.tier === "string" && turn.tier ? turn.tier : "1k",
    quality: typeof turn.quality === "string" && turn.quality ? turn.quality : "auto",
    images: normalizedImages,
    createdAt: String(turn.createdAt || new Date().toISOString()),
    status:
      turn.status === "queued" ||
      turn.status === "generating" ||
      turn.status === "success" ||
      turn.status === "error"
        ? turn.status
        : derivedStatus,
    error: typeof turn.error === "string" ? turn.error : undefined,
    promptDeleted: turn.promptDeleted === true,
    resultsDeleted: turn.resultsDeleted === true,
  };
}

function normalizeConversation(conversation: ImageConversation & Record<string, unknown>): ImageConversation {
  const turns = Array.isArray(conversation.turns)
    ? conversation.turns.map((turn) => normalizeTurn(turn as ImageTurn & Record<string, unknown>))
    : [
        normalizeTurn({
          id: String(conversation.id || `${Date.now()}`),
          prompt: String(conversation.prompt || ""),
          model: (conversation.model as ImageModel) || "gpt-image-2",
          mode: conversation.mode === "edit" ? "edit" : "generate",
          referenceImages: getLegacyReferenceImages(conversation),
          count: Number(conversation.count || 1),
          size: typeof conversation.size === "string" ? conversation.size : "",
          ratio: typeof conversation.ratio === "string" && conversation.ratio ? conversation.ratio : "1:1",
          tier: typeof conversation.tier === "string" && conversation.tier ? conversation.tier : "1k",
          quality: typeof conversation.quality === "string" && conversation.quality ? conversation.quality : "auto",
          images: Array.isArray(conversation.images) ? (conversation.images as StoredImage[]) : [],
          createdAt: String(conversation.createdAt || new Date().toISOString()),
          status:
            conversation.status === "generating" || conversation.status === "success" || conversation.status === "error"
              ? conversation.status
              : "success",
          error: typeof conversation.error === "string" ? conversation.error : undefined,
        }),
      ];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return {
    id: String(conversation.id || `${Date.now()}`),
    title: String(conversation.title || ""),
    createdAt: String(conversation.createdAt || lastTurn?.createdAt || new Date().toISOString()),
    updatedAt: String(conversation.updatedAt || lastTurn?.createdAt || new Date().toISOString()),
    turns,
  };
}

function sortImageConversations(conversations: ImageConversation[]): ImageConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getTimestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function pickLatestConversation(current: ImageConversation, next: ImageConversation) {
  return getTimestamp(next.updatedAt) >= getTimestamp(current.updatedAt) ? next : current;
}

/**
 * 判断两个版本的会话之间是否存在"值得写盘"的变化。
 *
 * 轮询期间每个 tick 都会更新 taskStatus / progress / elapsedSecs 等纯展示用的运行进度，
 * 这些字段页面刷新后会由下一次轮询重新得到，不需要落盘；只有结果、错误、状态流转等才需要持久化。
 * 拿不准时一律返回 true（宁可多写，不可漏写）。
 */
const VOLATILE_IMAGE_KEYS = new Set<string>(["taskStatus", "progress", "startTime", "elapsedSecs", "elapsedUpdatedAt"]);

function sameIgnoring(a: object, b: object, ignored: ReadonlySet<string>) {
  if (a === b) {
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!ignored.has(key) && left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

export function hasPersistentConversationChanges(
  previous: ImageConversation | null,
  next: ImageConversation,
): boolean {
  if (!previous) {
    return true;
  }
  if (previous === next) {
    return false;
  }
  // turns 单独比较；updatedAt 每个 tick 都会刷新，不参与判断
  if (!sameIgnoring(previous, next, new Set(["turns", "updatedAt"]))) {
    return true;
  }
  if (previous.turns.length !== next.turns.length) {
    return true;
  }
  const ignoredTurnKeys = new Set(["images"]);
  for (let index = 0; index < next.turns.length; index += 1) {
    const before = previous.turns[index];
    const after = next.turns[index];
    if (before === after) {
      continue;
    }
    if (!sameIgnoring(before, after, ignoredTurnKeys)) {
      return true;
    }
    if (before.images.length !== after.images.length) {
      return true;
    }
    for (let imageIndex = 0; imageIndex < after.images.length; imageIndex += 1) {
      if (!sameIgnoring(before.images[imageIndex], after.images[imageIndex], VOLATILE_IMAGE_KEYS)) {
        return true;
      }
    }
  }
  return false;
}

type StoredConversationRecord = ImageConversation & Record<string, unknown>;

/**
 * 会话持久化引擎。每个会话一条记录（`conversation:<id>`），所有写操作串行执行。
 * 启动后的第一次访问会把旧版单 key 数据（`items`）迁移成新格式。
 */
export function createImageConversationStore(storage: ConversationStorage) {
  let writeQueue: Promise<unknown> = Promise.resolve();
  let migration: Promise<void> | null = null;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 其他标签页可能已经写入了更新的版本：只在当前版本不比已存的旧时才写。 */
  async function writeConversation(conversation: ImageConversation) {
    const next = normalizeConversation(conversation);
    const key = conversationKey(next.id);
    const current = await storage.getItem<StoredConversationRecord>(key);
    if (current && pickLatestConversation(normalizeConversation(current), next) !== next) {
      return;
    }
    await storage.setItem(key, next);
  }

  async function migrateLegacyItems() {
    const legacy = await storage.getItem<StoredConversationRecord[]>(LEGACY_ITEMS_KEY);
    if (!Array.isArray(legacy)) {
      // 没有旧数据（新用户或已迁移）；格式异常的数据不动它，避免误删
      return;
    }
    for (const raw of legacy) {
      const conversation = normalizeConversation(raw);
      const key = conversationKey(conversation.id);
      const existing = await storage.getItem<StoredConversationRecord>(key);
      // 同一个会话两边都有时保留更新的那份（例如迁移中途被打断后重试）
      if (existing && pickLatestConversation(normalizeConversation(existing), conversation) !== conversation) {
        continue;
      }
      await storage.setItem(key, conversation);
    }
    // 全部写入成功后才删除旧数据；中途失败则下次启动会幂等地重试
    await storage.removeItem(LEGACY_ITEMS_KEY);
  }

  function ensureMigrated(): Promise<void> {
    if (!migration) {
      migration = enqueue(migrateLegacyItems).catch((error) => {
        migration = null;
        throw error;
      });
    }
    return migration;
  }

  async function list(): Promise<ImageConversation[]> {
    await ensureMigrated();
    const items: ImageConversation[] = [];
    await storage.iterate<StoredConversationRecord, void>((value, key) => {
      if (key.startsWith(CONVERSATION_KEY_PREFIX)) {
        items.push(normalizeConversation(value));
      }
    });
    return sortImageConversations(items);
  }

  async function saveMany(conversations: ImageConversation[]): Promise<void> {
    if (conversations.length === 0) {
      return;
    }
    await ensureMigrated();
    await enqueue(async () => {
      for (const conversation of conversations) {
        await writeConversation(conversation);
      }
    });
  }

  async function save(conversation: ImageConversation): Promise<void> {
    await ensureMigrated();
    await enqueue(() => writeConversation(conversation));
  }

  async function rename(id: string, title: string): Promise<void> {
    await ensureMigrated();
    await enqueue(async () => {
      const key = conversationKey(id);
      const current = await storage.getItem<StoredConversationRecord>(key);
      if (!current) {
        return;
      }
      await storage.setItem(key, {
        ...normalizeConversation(current),
        title,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async function remove(id: string): Promise<void> {
    await ensureMigrated();
    await enqueue(() => storage.removeItem(conversationKey(id)));
  }

  async function clear(): Promise<void> {
    await enqueue(() => storage.clear());
  }

  return { list, save, saveMany, rename, remove, clear };
}

export function getImageConversationStats(conversation: ImageConversation | null): ImageConversationStats {
  if (!conversation) {
    return { queued: 0, running: 0 };
  }

  return conversation.turns.reduce(
    (acc, turn) => {
      if (turn.resultsDeleted) {
        return acc;
      }
      if (turn.status === "queued") {
        acc.queued += 1;
      } else if (turn.status === "generating") {
        acc.running += 1;
      }
      return acc;
    },
    { queued: 0, running: 0 },
  );
}
