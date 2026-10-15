"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bug, Frame, ImageIcon, Images, LogOut, Menu, ScrollText, Settings, Sparkles, Users, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { HeaderActions } from "@/components/header-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import webConfig from "@/constants/common-env";
import { useSidebarCollapsed } from "@/hooks/use-sidebar";
import { fetchThirdPartyApps, type ThirdPartyAppsSettings } from "@/lib/api";
import { getValidatedAuthSession, invalidateValidatedAuthSession } from "@/lib/auth-session";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

type NavItem = { href: string; label: string; icon: LucideIcon };

// 分组之间用细分隔线隔开（与参考设计一致：内容 / 运维 / 设置）
const adminNavGroups: NavItem[][] = [
  [
    { href: "/image", label: "生图", icon: ImageIcon },
    { href: "/accounts", label: "号池管理", icon: Users },
    { href: "/image-manager", label: "图片管理", icon: Images },
  ],
  [
    { href: "/logs", label: "日志管理", icon: ScrollText },
    { href: "/debug", label: "调试", icon: Bug },
  ],
  [{ href: "/settings", label: "设置", icon: Settings }],
];

const userNavGroups: NavItem[][] = [[{ href: "/image", label: "画图", icon: ImageIcon }]];

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
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);
  const [thirdPartyApps, setThirdPartyApps] = useState<ThirdPartyAppsSettings | null>(null);
  const [isCanvasDialogOpen, setIsCanvasDialogOpen] = useState(false);
  const collapsed = useSidebarCollapsed();

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

  // 只在密钥真正变化时才重新拉取：校验结果的对象引用刷新（TTL 到期）不应触发额外请求
  const sessionKey = session?.key ?? null;
  useEffect(() => {
    if (!sessionKey) {
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
  }, [sessionKey]);

  const handleLogout = async () => {
    await clearStoredAuthSession();
    invalidateValidatedAuthSession();
    router.replace("/login");
  };

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const navGroups = session.role === "admin" ? adminNavGroups : userNavGroups;
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  const displayName = session.name.trim() || roleLabel;
  const baseUrl = webConfig.apiUrl.replace(/\/$/, "") || window.location.origin;
  const canvas = thirdPartyApps?.infinite_canvas;
  const canvasHref = canvas?.enabled && canvas.url.trim() ? buildThirdPartyHref(canvas.url, baseUrl, session.key) : "";
  const canvasDisplayHref = canvasHref ? decodeURIComponent(canvasHref) : "";
  // 导出为静态站点时路径带尾斜杠（/image/），统一去掉再比较
  const currentPath = pathname.replace(/\/$/, "");

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

  const itemClass = (active: boolean, compact: boolean) =>
    cn(
      "relative flex h-10 w-full items-center gap-3 rounded-2xl text-sm font-medium outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-4 focus-visible:ring-ring/40",
      compact ? "justify-center px-0" : "px-3",
      active
        ? "bg-primary text-primary-foreground shadow-[0_8px_18px_-8px_rgb(10_132_255/0.75),inset_0_1px_0_rgb(255_255_255/0.25)]"
        : "text-sidebar-foreground/70 hover:bg-accent hover:text-sidebar-foreground",
    );

  const renderNavLink = (item: NavItem, compact: boolean) => {
    const Icon = item.icon;
    const active = currentPath === item.href;
    return (
      <Link key={item.href} href={item.href} title={item.label} aria-current={active ? "page" : undefined} className={itemClass(active, compact)}>
        <Icon className="size-[18px] shrink-0" />
        {compact ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
      </Link>
    );
  };

  const canvasButton = (compact: boolean) =>
    canvasHref ? (
      <button type="button" onClick={handleCanvasOpen} title="无限画布" className={itemClass(false, compact)}>
        <Frame className="size-[18px] shrink-0" />
        {compact ? <span className="sr-only">无限画布</span> : <span className="truncate">无限画布</span>}
      </button>
    ) : null;

  return (
    <>
      {/* 桌面端：悬浮的圆角侧栏，折叠时只剩图标 */}
      <aside
        className="glass-chrome relative z-20 my-3 ml-3 hidden shrink-0 flex-col overflow-hidden rounded-[30px] py-3 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] sm:flex"
        style={{ width: "var(--sidebar-w)" }}
      >
        <Link
          href="/image"
          title="chatgpt2api"
          className={cn(
            "mx-3 flex h-11 items-center gap-3 rounded-2xl text-sidebar-foreground outline-none focus-visible:ring-4 focus-visible:ring-ring/40",
            collapsed ? "justify-center" : "px-1.5",
          )}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet text-white shadow-[0_6px_16px_-6px_rgb(10_132_255/0.8)]">
            <Sparkles className="size-[18px]" />
          </span>
          {collapsed ? null : <span className="truncate text-[15px] font-semibold tracking-tight">chatgpt2api</span>}
        </Link>

        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3">
          {navGroups.map((group, index) => (
            <div key={index} className={cn("flex flex-col gap-1", index > 0 && "mt-1 border-t border-sidebar-border pt-2")}>
              {index === 0 ? canvasButton(collapsed) : null}
              {group.map((item) => renderNavLink(item, collapsed))}
            </div>
          ))}
        </nav>

        <div className="mt-2 flex flex-col gap-1.5 border-t border-sidebar-border px-3 pt-3">
          {collapsed ? null : (
            <div className="truncate px-2 text-[11px] text-muted-foreground" title={`${roleLabel} · ${displayName}`}>
              {roleLabel} · {displayName}
            </div>
          )}
          <HeaderActions className={cn(collapsed ? "flex-col" : "justify-between px-1")} showGithubText={false} />
          <button
            type="button"
            onClick={() => void handleLogout()}
            title="退出"
            className={cn(
              "flex h-9 w-full items-center gap-3 rounded-xl text-sm text-sidebar-foreground/60 outline-none transition-colors hover:bg-accent hover:text-sidebar-foreground focus-visible:ring-4 focus-visible:ring-ring/40",
              collapsed ? "justify-center px-0" : "px-3",
            )}
          >
            <LogOut className="size-4 shrink-0" />
            {collapsed ? <span className="sr-only">退出</span> : <span>退出</span>}
          </button>
        </div>
      </aside>

      {/* 移动端：顶部悬浮条 + 抽屉导航 */}
      <header className="glass-chrome z-30 mx-3 mt-3 flex h-12 shrink-0 items-center justify-between gap-2 rounded-2xl px-2 sm:hidden">
        <Sheet>
          <SheetTrigger className="inline-flex size-9 items-center justify-center rounded-xl text-foreground/80 outline-none transition-colors hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/40">
            <Menu className="size-[18px]" />
            <span className="sr-only">打开导航</span>
          </SheetTrigger>
          <SheetContent side="left">
            <SheetHeader className="pt-6">
              <SheetTitle className="flex items-center gap-2.5 text-base">
                <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet text-white">
                  <Sparkles className="size-4" />
                </span>
                chatgpt2api
              </SheetTitle>
              <span className="text-xs text-muted-foreground">{roleLabel} · {displayName}</span>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-3">
              {canvasHref ? (
                <SheetClose asChild>
                  <button type="button" className={itemClass(false, false)} onClick={handleCanvasOpen}>
                    <Frame className="size-[18px] shrink-0" />
                    无限画布
                  </button>
                </SheetClose>
              ) : null}
              {navGroups.map((group, index) => (
                <div key={index} className={cn("flex flex-col gap-1", index > 0 && "mt-1 border-t border-border pt-2")}>
                  {group.map((item) => {
                    const Icon = item.icon;
                    return (
                      <SheetClose asChild key={item.href}>
                        <Link href={item.href} className={itemClass(currentPath === item.href, false)}>
                          <Icon className="size-[18px] shrink-0" />
                          <span>{item.label}</span>
                        </Link>
                      </SheetClose>
                    );
                  })}
                </div>
              ))}
            </nav>
            <SheetFooter>
              <button
                type="button"
                className="flex h-10 items-center gap-3 rounded-2xl border border-border px-3 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring/40"
                onClick={() => void handleLogout()}
              >
                <LogOut className="size-4" />
                退出
              </button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
        <Link href="/image" className="text-[15px] font-semibold tracking-tight">
          chatgpt2api
        </Link>
        <HeaderActions showGithubText={false} />
      </header>

      <Dialog open={isCanvasDialogOpen} onOpenChange={setIsCanvasDialogOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>跳转到三方应用</DialogTitle>
            <DialogDescription className="leading-6">
              该入口仅供个人测试使用，建议自行本机部署后再长期使用。跳转地址会默认带上本项目地址和当前密钥，用于自动填充连接信息；如果不放心，可以取消后手动前往应用并自行输入。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">完整跳转地址</div>
            <div className="max-h-28 overflow-auto rounded-xl border border-border bg-field px-3 py-2 font-mono text-xs leading-5 break-all text-foreground/80">
              {canvasDisplayHref}
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                取消
              </Button>
            </DialogClose>
            <Button type="button" onClick={confirmCanvasOpen}>
              继续跳转
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
