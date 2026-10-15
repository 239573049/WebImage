"use client";

import { Fragment, useState } from "react";
import { Check, ChevronsUpDown, Copy, Frame, LogOut, X } from "lucide-react";
import { toast } from "sonner";

import {
  AnimatedSidebar,
  AnimatedSidebarClose,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarHeader,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarMenuSub,
  AnimatedSidebarMenuSubButton,
  AnimatedSidebarMenuSubItem,
  AnimatedSidebarRail,
  useAnimatedSidebar,
} from "@/components/motion/animated-sidebar";
import { Tooltip } from "@/components/motion/tooltip";
import { BrandMark } from "@/components/shell/brand";
import { normalizePath, type NavEntry } from "@/components/shell/nav-config";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { StoredAuthSession } from "@/store/auth";

// beUI 的激活态是一块灰色滑块（菜单项的第一个子元素），这里换成主色淡底 + 主色图标
const activeItemClass =
  "text-foreground [&>span:first-child]:bg-primary/14 [&>span:first-child]:ring-1 [&>span:first-child]:ring-inset [&>span:first-child]:ring-primary/20 [&_svg]:text-primary";

type AppSidebarProps = {
  nav: NavEntry[];
  pathname: string;
  session: StoredAuthSession;
  baseUrl: string;
  onOpenCanvas?: () => void;
  onLogout: () => void;
};

function initialOf(text: string) {
  return (text.trim()[0] || "?").toUpperCase();
}

export function AppSidebar({ nav, pathname, session, baseUrl, onOpenCanvas, onLogout }: AppSidebarProps) {
  const { isMobile, state } = useAnimatedSidebar();
  const collapsed = !isMobile && state === "collapsed";
  const currentPath = normalizePath(pathname);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(nav.filter((entry) => entry.kind === "group").map((entry) => entry.id)),
  );

  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  const displayName = session.name.trim() || roleLabel;
  const host = baseUrl.replace(/^https?:\/\//, "") || "本地服务";

  const toggleGroup = (id: string) =>
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  return (
    <AnimatedSidebar
      ariaLabel="主导航"
      collapsible="icon"
      // 桌面端是悬浮的圆角面板；移动端由 beUI 渲染成抽屉，className 作用在抽屉面板上
      className={isMobile ? "bg-sidebar" : "h-dvh py-3 pl-3"}
      panelClassName="h-full rounded-[20px] border border-sidebar-border bg-(--chrome-bg) surface-chrome"
    >
      <AnimatedSidebarHeader className="gap-4 px-3 pt-4 pb-2">
        <div className="flex h-9 items-center gap-2 px-1.5">
          <BrandMark hideText={collapsed} className="flex-1" />
          <AnimatedSidebarClose aria-label="关闭导航" className="size-8 text-muted-foreground hover:bg-accent md:hidden">
            <X aria-hidden="true" className="size-4" />
          </AnimatedSidebarClose>
        </div>
        <WorkspaceCard collapsed={collapsed} host={host} baseUrl={baseUrl} roleLabel={roleLabel} />
      </AnimatedSidebarHeader>

      <AnimatedSidebarContent className="px-3 pt-1">
        <AnimatedSidebarGroup className="px-0">
          <AnimatedSidebarGroupLabel>导航</AnimatedSidebarGroupLabel>
          <AnimatedSidebarMenu>
            {nav.map((entry, index) => {
              if (entry.kind === "link") {
                const Icon = entry.icon;
                const active = currentPath === entry.href;
                return (
                  <Fragment key={entry.href}>
                    <AnimatedSidebarMenuItem>
                      <AnimatedSidebarMenuButton
                        href={entry.href}
                        isActive={active}
                        icon={<Icon className="size-[18px]" />}
                        className={cn(active && activeItemClass)}
                      >
                        {entry.label}
                      </AnimatedSidebarMenuButton>
                    </AnimatedSidebarMenuItem>
                    {/* 无限画布入口紧跟在第一项（生图）后面，和原来的位置一致 */}
                    {index === 0 && onOpenCanvas ? (
                      <AnimatedSidebarMenuItem>
                        <AnimatedSidebarMenuButton icon={<Frame className="size-[18px]" />} onSelect={onOpenCanvas}>
                          无限画布
                        </AnimatedSidebarMenuButton>
                      </AnimatedSidebarMenuItem>
                    ) : null}
                  </Fragment>
                );
              }

              const Icon = entry.icon;
              const open = openGroups.has(entry.id);
              const childActive = entry.children.some((child) => child.href === currentPath);
              // 展开着的分组由子项自己高亮；折叠成图标栏或分组收起时，由分组本身承接"当前位置"
              const groupActive = childActive && (collapsed || !open);
              return (
                <AnimatedSidebarMenuItem key={entry.id}>
                  <AnimatedSidebarMenuButton
                    isActive={groupActive}
                    ariaExpanded={open}
                    icon={<Icon className="size-[18px]" />}
                    onSelect={() => {
                      // 图标栏里点分组时 beUI 会先展开侧栏，此时保持分组展开即可
                      if (collapsed) {
                        setOpenGroups((current) => new Set(current).add(entry.id));
                        return;
                      }
                      toggleGroup(entry.id);
                    }}
                    className={cn(groupActive && activeItemClass)}
                  >
                    {entry.label}
                  </AnimatedSidebarMenuButton>
                  <AnimatedSidebarMenuSub open={open} className="ml-[21px] gap-1 border-sidebar-border pl-2.5">
                    {entry.children.map((child) => {
                      const ChildIcon = child.icon;
                      const active = currentPath === child.href;
                      return (
                        <AnimatedSidebarMenuSubItem key={child.href}>
                          <AnimatedSidebarMenuSubButton
                            href={child.href}
                            isActive={active}
                            icon={<ChildIcon className="size-4" />}
                            className={cn(
                              "min-h-8 rounded-[10px] text-[13px]",
                              active && "bg-primary/14 text-foreground hover:bg-primary/18 [&_svg]:text-primary",
                            )}
                          >
                            {child.label}
                          </AnimatedSidebarMenuSubButton>
                        </AnimatedSidebarMenuSubItem>
                      );
                    })}
                  </AnimatedSidebarMenuSub>
                </AnimatedSidebarMenuItem>
              );
            })}
          </AnimatedSidebarMenu>
        </AnimatedSidebarGroup>
      </AnimatedSidebarContent>

      <AnimatedSidebarFooter className="border-sidebar-border p-3">
        <div className={cn("flex items-center gap-2.5 rounded-xl p-1.5", collapsed && "flex-col")}>
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-violet text-sm font-semibold text-white">
            {initialOf(displayName)}
          </span>
          {collapsed ? null : (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">{displayName}</span>
              <span className="block truncate text-xs text-muted-foreground">{roleLabel} · 密钥登录</span>
            </span>
          )}
          <Tooltip content="退出登录" side={collapsed ? "right" : "top"}>
            <button
              type="button"
              onClick={onLogout}
              aria-label="退出登录"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut className="size-4" />
            </button>
          </Tooltip>
        </div>
      </AnimatedSidebarFooter>

      <AnimatedSidebarRail />
    </AnimatedSidebar>
  );
}

/** 头部的"工作区"卡片：显示当前接入的服务地址，点开可复制 API 地址 */
function WorkspaceCard({
  collapsed,
  host,
  baseUrl,
  roleLabel,
}: {
  collapsed: boolean;
  host: string;
  baseUrl: string;
  roleLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopied(true);
      toast.success("接口地址已复制");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={collapsed ? host : undefined}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl border border-transparent text-left outline-none transition-colors hover:border-sidebar-border hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            collapsed ? "justify-center p-1" : "px-2 py-1.5",
          )}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-[13px] font-semibold text-primary">
            {initialOf(host)}
          </span>
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-foreground">{host}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{roleLabel} · API 服务</span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side={collapsed ? "right" : "bottom"} className="w-72 space-y-3">
        <div className="eyebrow">接口地址</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-field px-2.5 py-1.5 font-mono text-xs text-foreground/85">
            {baseUrl}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="复制接口地址"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
          </button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">在第三方客户端里接入时，填写这个地址并配合你的密钥使用。</p>
      </PopoverContent>
    </Popover>
  );
}
