"use client";

import localforage from "localforage";

import { createImageConversationStore } from "./image-conversation-store";

// 数据模型、规范化与持久化引擎见 image-conversation-store.ts；这里只负责接上浏览器里的 IndexedDB。
export type {
  ImageConversation,
  ImageConversationMode,
  ImageConversationStats,
  ImageTurn,
  ImageTurnStatus,
  StoredImage,
  StoredReferenceImage,
} from "./image-conversation-store";
export { getImageConversationStats, hasPersistentConversationChanges } from "./image-conversation-store";

const imageConversationStore = createImageConversationStore(
  localforage.createInstance({
    name: "chatgpt2api",
    storeName: "image_conversations",
  }),
);

export const listImageConversations = imageConversationStore.list;
export const saveImageConversations = imageConversationStore.saveMany;
export const saveImageConversation = imageConversationStore.save;
export const renameImageConversation = imageConversationStore.rename;
export const deleteImageConversation = imageConversationStore.remove;
export const clearImageConversations = imageConversationStore.clear;
