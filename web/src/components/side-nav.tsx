"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Bug, Frame, ImageIcon, Images, LogOut, Menu, PanelLeftClose, PanelLeftOpen, ScrollText, Settings, Users } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { HeaderActions } from "@/components/header-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import webConfig from "@/constants/common-env";
import { fetchThirdPartyApps, type ThirdPartyAppsSettings } from "@/lib/api";
import { getValidatedAuthSession } from "@/lib/auth-session";
import { navItemVariants, navListVariants, springSoft } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

const SIDEBAR_STORAGE_KEY = "chatgpt2api-sidebar";

const adminNavItems = [
  { href: "/image", label: "生图", icon: ImageIcon },
  { href: "/accounts", label: "号池管理", icon: Users },
  { href: "/image-manager", label: "图片管理", icon: Images },
  { href: "/logs", label: "日志管理", icon: ScrollText },
  { href: "/debug", label: "调试", icon: Bug },
  { href: "/settings", label: "设置", icon: Settings },
];

const userNavItems = [{ href: "/image", label: "画图", icon: ImageIcon }];

function buildThirdPartyHref(appUrl: string, baseUrl: string, apiKey: string) {
  const url = appUrl.trim();
  try {
    const target = new URL(url);
    target.searchParams.set("apiKey", apiKey);
    target.searchParams.set("baseUrl", baseUrl);
    return target.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}&baseUrl=${encodeURIComponent(baseUrl)}`;
  }
}

export function SideNav() {
  const pathname = usePathname();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);
  const [thirdPartyApps, setThirdPartyApps] = useState<ThirdPartyAppsSettings | null>(null);
  const [isCanvasDialogOpen, setIsCanvasDialogOpen] = useState(false);
  // 与 theme-script 预写入的 data-sidebar 对齐，避免折叠态首屏闪一下展开
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.dataset.sidebar === "collapsed";
  });

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (!active) {
          return;
        }
        setSession(null);
        return;
      }

      const storedSession = await getValidatedAuthSession();
      if (!active) {
        return;
      }
      setSession(storedSession);
    };

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    if (!session) {
      setThirdPartyApps(null);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const data = await fetchThirdPartyApps();
        if (active) {
          setThirdPartyApps(data.third_party_apps);
        }
      } catch {
        if (active) {
          setThirdPartyApps(null);
        }
      }
    };
    const reload = () => void load();

    void load();
    window.addEventListener("third-party-apps-updated", reload);
    return () => {
      active = false;
      window.removeEventListener("third-party-apps-updated", reload);
    };
  }, [session]);

  const handleLogout = async () => {
    await clearStoredAuthSession();
    router.replace("/login");
  };

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "collapsed" : "expanded");
      } catch {
        // 隐私模式下写入失败时保持内存状态即可
      }
      return next;
    });
  };

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  const displayName = session.name.trim() || roleLabel;
  const baseUrl = webConfig.apiUrl.replace(/\/$/, "") || window.location.origin;
  const canvas = thirdPartyApps?.infinite_canvas;
  const canvasHref = canvas?.enabled && canvas.url.trim() ? buildThirdPartyHref(canvas.url, baseUrl, session.key) : "";
  const canvasDisplayHref = canvasHref ? decodeURIComponent(canvasHref) : "";

  const handleCanvasOpen = () => {
    if (!canvasHref) {
      return;
    }
    setIsCanvasDialogOpen(true);
  };

  const confirmCanvasOpen = () => {
    if (canvasHref) {
      window.open(canvasHref, "_blank", "noopener,noreferrer");
    }
    setIsCanvasDialogOpen(false);
  };

  const itemClass = (active: boolean) =>
    cn(
      "relative flex h-10 items-center gap-3 rounded-xl text-sm font-medium transition-colors",
      collapsed ? "justify-center px-0" : "px-3",
      active
        ? "text-white dark:text-stone-950"
        : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
    );

  const activePill = !reduceMotion ? (
    <motion.span
      layoutId="side-nav-active"
      className="absolute inset-0 -z-10 rounded-xl bg-stone-950 dark:bg-white"
      transition={springSoft}
    />
  ) : (
    <span className="absolute inset-0 -z-10 rounded-xl bg-stone-950 dark:bg-white" />
  );

  return (
    <>
      <motion.aside
        className="hidden h-full min-h-0 shrink-0 flex-col border-r border-stone-100/60 py-3 sm:flex dark:border-white/10"
        initial={false}
        animate={{ width: collapsed ? "3.75rem" : "14rem" }}
        transition={reduceMotion ? { duration: 0 } : springSoft}
      >
        <div className={cn("flex items-center gap-2 px-3", collapsed && "justify-center px-0")}>
          <AnimatePresence initial={false} mode="popLayout">
            {!collapsed ? (
              <motion.div
                key="brand"
                initial={reduceMotion ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: -8 }}
                transition={{ duration: 0.18 }}
                className="min-w-0 flex-1"
              >
                <Link
                  href="/image"
                  className="block truncate text-[15px] font-bold tracking-tight text-stone-950 transition hover:text-stone-700 dark:text-stone-50 dark:hover:text-white"
                >
                  chatgpt2api
                </Link>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <motion.button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "展开菜单" : "收起菜单"}
            whileTap={reduceMotion ? undefined : { scale: 0.92 }}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <motion.span
              key={collapsed ? "open" : "close"}
              initial={reduceMotion ? false : { rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="inline-flex"
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </motion.span>
            <span className="sr-only">{collapsed ? "展开菜单" : "收起菜单"}</span>
          </motion.button>
        </div>

        <LayoutGroup id="side-nav">
          <motion.nav
            className="mt-6 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2"
            initial="hidden"
            animate="show"
            variants={reduceMotion ? undefined : navListVariants}
          >
            {canvasHref ? (
              <motion.button
                type="button"
                onClick={handleCanvasOpen}
                title="无限画布"
                variants={reduceMotion ? undefined : navItemVariants}
                whileHover={reduceMotion ? undefined : { x: collapsed ? 0 : 2 }}
                whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                className={itemClass(false)}
              >
                <Frame className="size-4 shrink-0" />
                <AnimatePresence initial={false}>
                  {!collapsed ? (
                    <motion.span
                      initial={reduceMotion ? false : { opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: "auto" }}
                      exit={reduceMotion ? undefined : { opacity: 0, width: 0 }}
                      className="truncate overflow-hidden"
                    >
                      无限画布
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </motion.button>
            ) : null}
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <motion.div key={item.href} variants={reduceMotion ? undefined : navItemVariants} className="relative">
                  <Link href={item.href} title={item.label} className={itemClass(active)}>
                    {active ? activePill : null}
                    <Icon className="relative size-4 shrink-0" />
                    <AnimatePresence initial={false}>
                      {!collapsed ? (
                        <motion.span
                          initial={reduceMotion ? false : { opacity: 0, width: 0 }}
                          animate={{ opacity: 1, width: "auto" }}
                          exit={reduceMotion ? undefined : { opacity: 0, width: 0 }}
                          className="relative truncate overflow-hidden"
                        >
                          {item.label}
                        </motion.span>
                      ) : null}
                    </AnimatePresence>
                  </Link>
                </motion.div>
              );
            })}
          </motion.nav>
        </LayoutGroup>

        <div className={cn("mt-3 space-y-2 border-t border-stone-100/60 px-2 pt-3 dark:border-white/10", collapsed && "px-1")}>
          <AnimatePresence initial={false}>
            {!collapsed ? (
              <motion.div
                key="role"
                initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="truncate px-1 text-[11px] text-stone-400" title={`${roleLabel} · ${displayName}`}>
                  {roleLabel} · {displayName}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <HeaderActions className={cn(collapsed && "flex-col gap-2 sm:gap-2")} showGithubText={!collapsed} />
          <motion.button
            type="button"
            onClick={() => void handleLogout()}
            title="退出"
            whileHover={reduceMotion ? undefined : { x: collapsed ? 0 : 2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.98 }}
            className={cn(
              "flex h-9 w-full items-center gap-3 rounded-xl text-sm text-stone-400 transition hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-white/10 dark:hover:text-white",
              collapsed ? "justify-center px-0" : "px-3",
            )}
          >
            <LogOut className="size-4 shrink-0" />
            <AnimatePresence initial={false}>
              {!collapsed ? (
                <motion.span
                  initial={reduceMotion ? false : { opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={reduceMotion ? undefined : { opacity: 0, width: 0 }}
                  className="overflow-hidden"
                >
                  退出
                </motion.span>
              ) : null}
            </AnimatePresence>
          </motion.button>
        </div>
      </motion.aside>

      <header className="z-30 flex h-12 shrink-0 items-center justify-between gap-2 border-b border-stone-100/50 bg-transparent px-3 backdrop-blur sm:hidden dark:border-white/10">
        <Sheet>
          <SheetTrigger className="inline-flex size-8 items-center justify-center text-stone-700 transition hover:text-stone-950 dark:text-stone-200 dark:hover:text-white">
            <Menu className="size-4" />
            <span className="sr-only">打开导航</span>
          </SheetTrigger>
          <SheetContent side="left">
            <SheetHeader>
              <SheetTitle>chatgpt2api</SheetTitle>
              <span className="text-xs text-stone-500 dark:text-stone-400">{roleLabel} · {displayName}</span>
            </SheetHeader>
            <nav className="mt-8 flex flex-col gap-1 px-2">
              {canvasHref ? (
                <SheetClose asChild>
                  <button type="button" className={itemClass(false)} onClick={handleCanvasOpen}>
                    <Frame className="size-4 shrink-0" />
                    无限画布
                  </button>
                </SheetClose>
              ) : null}
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <SheetClose asChild key={item.href}>
                    <Link href={item.href} className={itemClass(active)}>
                      {active ? <span className="absolute inset-0 -z-10 rounded-xl bg-stone-950 dark:bg-white" /> : null}
                      <Icon className="relative size-4 shrink-0" />
                      <span className="relative">{item.label}</span>
                    </Link>
                  </SheetClose>
                );
              })}
            </nav>
            <SheetFooter>
              <button
                type="button"
                className="rounded-xl border border-stone-200 px-3 py-2.5 text-left text-sm font-medium text-stone-500 transition hover:text-stone-950 dark:border-white/10 dark:text-stone-300 dark:hover:text-white"
                onClick={() => void handleLogout()}
              >
                退出
              </button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
        <Link href="/image" className="text-[15px] font-bold tracking-tight text-stone-950 dark:text-stone-50">
          chatgpt2api
        </Link>
        <HeaderActions showGithubText={false} />
      </header>

      <Dialog open={isCanvasDialogOpen} onOpenChange={setIsCanvasDialogOpen}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>跳转到三方应用</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              该入口仅供个人测试使用，建议自行本机部署后再长期使用。跳转地址会默认带上本项目地址和当前密钥，用于自动填充连接信息；如果不放心，可以取消后手动前往应用并自行输入。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-xs font-medium text-stone-500">完整跳转地址</div>
            <div className="max-h-28 overflow-auto break-all rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-xs leading-5 text-stone-700">
              {canvasDisplayHref}
            </div>
          </div>
          <DialogFooter className="pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" className="rounded-xl border-stone-200 bg-white text-stone-700">
                取消
              </Button>
            </DialogClose>
            <Button type="button" className="rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={confirmCanvasOpen}>
              继续跳转
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
