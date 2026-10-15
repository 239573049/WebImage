"use client";

import { useSyncExternalStore } from "react";

const SIDEBAR_STORAGE_KEY = "chatgpt2api-sidebar";

function isCollapsed() {
  return document.documentElement.dataset.sidebar === "collapsed";
}

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-sidebar"] });
  return () => observer.disconnect();
}

/** 侧栏是否折叠。状态存在 <html data-sidebar>（theme-script 首屏前就写好了），所以不会出现展开→折叠的闪烁。 */
export function useSidebarCollapsed() {
  return useSyncExternalStore(subscribe, isCollapsed, () => false);
}

export function setSidebarCollapsed(collapsed: boolean) {
  document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // 隐私模式下写入失败时，只保留内存里（<html> 上）的状态即可
  }
}

export function toggleSidebar() {
  setSidebarCollapsed(!isCollapsed());
}
