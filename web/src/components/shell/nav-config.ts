import { Bug, ImageIcon, Images, LayoutGrid, ScrollText, Settings, Users, type LucideIcon } from "lucide-react";

import type { AuthRole } from "@/store/auth";

export type NavLink = {
  kind: "link";
  href: string;
  label: string;
  icon: LucideIcon;
  /** ⌘K 搜索时额外匹配的关键词 */
  keywords?: string[];
};

export type NavGroup = {
  kind: "group";
  id: string;
  label: string;
  icon: LucideIcon;
  children: NavLink[];
};

export type NavEntry = NavLink | NavGroup;

const adminNav: NavEntry[] = [
  { kind: "link", href: "/image", label: "生图", icon: ImageIcon, keywords: ["画图", "图片生成", "image", "draw"] },
  {
    kind: "group",
    id: "manage",
    label: "资源管理",
    icon: LayoutGrid,
    children: [
      { kind: "link", href: "/accounts", label: "号池管理", icon: Users, keywords: ["账号", "账户", "token", "额度", "account"] },
      { kind: "link", href: "/image-manager", label: "图片管理", icon: Images, keywords: ["存储", "磁盘", "标签", "gallery"] },
      { kind: "link", href: "/logs", label: "日志管理", icon: ScrollText, keywords: ["调用", "RPM", "统计", "logs"] },
    ],
  },
  { kind: "link", href: "/debug", label: "调试", icon: Bug, keywords: ["skills", "搜索", "PPT", "PSD", "对话", "debug"] },
  {
    kind: "link",
    href: "/settings",
    label: "设置",
    icon: Settings,
    keywords: ["配置", "备份", "密钥", "代理", "CPA", "Sub2API", "FlareSolverr", "settings"],
  },
];

const userNav: NavEntry[] = [{ kind: "link", href: "/image", label: "画图", icon: ImageIcon, keywords: ["生图", "image"] }];

export function getNav(role: AuthRole): NavEntry[] {
  return role === "admin" ? adminNav : userNav;
}

export function flattenNav(entries: NavEntry[]): NavLink[] {
  return entries.flatMap((entry) => (entry.kind === "group" ? entry.children : [entry]));
}

/** 导出为静态站点时路径带尾斜杠（/image/），统一去掉再比较 */
export function normalizePath(pathname: string) {
  return pathname.replace(/\/$/, "") || "/";
}

export function findNavLink(entries: NavEntry[], pathname: string) {
  const path = normalizePath(pathname);
  return flattenNav(entries).find((item) => item.href === path);
}
