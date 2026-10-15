"use client";

import { useSyncExternalStore } from "react";

function isDark() {
  return document.documentElement.classList.contains("dark");
}

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** 当前是否为深色主题（读取 <html class="dark">，随主题切换实时更新）。 */
export function useIsDark() {
  return useSyncExternalStore(subscribe, isDark, () => false);
}
