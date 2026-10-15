"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Frame, LogOut, Moon, PanelLeft, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { CommandPalette, type CommandItem } from "@/components/motion/command-palette";
import { AnimatedSidebarInset, AnimatedSidebarProvider } from "@/components/motion/animated-sidebar";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { GITHUB_URL } from "@/components/shell/brand";
import { flattenNav, getNav } from "@/components/shell/nav-config";
import { TopBar } from "@/components/shell/top-bar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import webConfig from "@/constants/common-env";
import { setSidebarCollapsed, toggleSidebar, useSidebarCollapsed } from "@/hooks/use-sidebar";
import { fetchThirdPartyApps, type ThirdPartyAppsSettings } from "@/lib/api";
import { getValidatedAuthSession, invalidateValidatedAuthSession } from "@/lib/auth-session";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

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

/** ⌘K 里的"切换主题"：没有按钮坐标可做扩散动画，直接切换 */
function toggleThemeInstantly() {
  const root = document.documentElement;
  const dark = !root.classList.contains("dark");
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  try {
    localStorage.setItem("chatgpt2api-theme", dark ? "dark" : "light");
  } catch {
    // 隐私模式下写入失败时只保留本次会话的状态
  }
}

/**
 * 应用外壳：beUI 侧栏 + 顶栏 + ⌘K 命令面板。
 * 未登录（/login 或会话尚未校验完）时只渲染页面本身；
 * 外壳元素以兄弟节点的形式按需出现，页面在树里的位置不变，切换时不会被重新挂载。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const collapsed = useSidebarCollapsed();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);
  const [thirdPartyApps, setThirdPartyApps] = useState<ThirdPartyAppsSettings | null>(null);
  const [isCanvasDialogOpen, setIsCanvasDialogOpen] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (active) {
          setSession(null);
        }
        return;
      }

      const storedSession = await getValidatedAuthSession();
      if (active) {
        setSession(storedSession);
      }
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

  const showChrome = pathname !== "/login" && Boolean(session);
  const nav = useMemo(() => (session ? getNav(session.role) : []), [session]);
  const baseUrl = typeof window === "undefined" ? "" : webConfig.apiUrl.replace(/\/$/, "") || window.location.origin;
  const canvas = thirdPartyApps?.infinite_canvas;
  const canvasHref =
    session && canvas?.enabled && canvas.url.trim() ? buildThirdPartyHref(canvas.url, baseUrl, session.key) : "";

  const handleLogout = useCallback(async () => {
    await clearStoredAuthSession();
    invalidateValidatedAuthSession();
    router.replace("/login");
  }, [router]);

  const openCanvas = canvasHref ? () => setIsCanvasDialogOpen(true) : undefined;

  const confirmCanvasOpen = () => {
    if (canvasHref) {
      window.open(canvasHref, "_blank", "noopener,noreferrer");
    }
    setIsCanvasDialogOpen(false);
  };

  const commandItems = useMemo<CommandItem[]>(() => {
    const action = (id: string, label: string, icon: LucideIcon, onSelect: () => void, keywords?: string[]): CommandItem => ({
      id,
      label,
      group: "操作",
      icon,
      keywords,
      onSelect,
    });
    const pages: CommandItem[] = flattenNav(nav).map((item) => ({
      id: item.href,
      label: item.label,
      group: "页面",
      icon: item.icon,
      keywords: item.keywords,
      onSelect: () => router.push(item.href),
    }));
    return [
      ...pages,
      ...(canvasHref ? [action("canvas", "打开无限画布", Frame, () => setIsCanvasDialogOpen(true), ["canvas"])] : []),
      action("sidebar", "展开 / 收起侧栏", PanelLeft, toggleSidebar, ["sidebar"]),
      action("theme", "切换深色 / 浅色主题", Moon, toggleThemeInstantly, ["theme", "dark", "light"]),
      action("github", "打开 GitHub 仓库", ExternalLink, () => window.open(GITHUB_URL, "_blank", "noopener,noreferrer")),
      action("logout", "退出登录", LogOut, () => void handleLogout(), ["logout"]),
    ];
  }, [nav, canvasHref, router, handleLogout]);

  return (
    <AnimatedSidebarProvider
      open={!collapsed}
      onOpenChange={(open) => setSidebarCollapsed(!open)}
      className="h-dvh min-h-0 overflow-hidden"
      style={{ "--sidebar-width": "15.5rem", "--sidebar-width-icon": "4.75rem", "--sidebar-width-mobile": "17rem" }}
    >
      {showChrome && session ? (
        <AppSidebar
          nav={nav}
          pathname={pathname}
          session={session}
          baseUrl={baseUrl}
          onOpenCanvas={openCanvas}
          onLogout={() => void handleLogout()}
        />
      ) : null}

      <AnimatedSidebarInset className="h-dvh min-h-0 bg-transparent pt-[env(safe-area-inset-top)]">
        {showChrome && session ? (
          <TopBar nav={nav} pathname={pathname} onOpenSearch={() => setIsPaletteOpen(true)} />
        ) : null}
        {/* 外层负责留白，内层负责滚动；避免 padding + h-full 叠出多余滚动条 */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [&>*]:min-h-0",
            showChrome && "px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:px-6 md:pt-6 md:pr-7 md:pl-6",
          )}
        >
          {children}
        </div>
      </AnimatedSidebarInset>

      {showChrome ? (
        <CommandPalette
          items={commandItems}
          open={isPaletteOpen}
          onOpenChange={setIsPaletteOpen}
          placeholder="搜索页面或操作…"
          emptyMessage="没有匹配的页面或操作"
        />
      ) : null}

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
              {canvasHref ? decodeURIComponent(canvasHref) : ""}
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
    </AnimatedSidebarProvider>
  );
}
