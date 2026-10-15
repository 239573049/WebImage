"use client";

import { useSyncExternalStore } from "react";
import { PanelLeft, Search } from "lucide-react";

import { AnimatedSidebarTrigger } from "@/components/motion/animated-sidebar";
import { Tooltip } from "@/components/motion/tooltip";
import { GITHUB_URL } from "@/components/shell/brand";
import { findNavLink, type NavEntry } from "@/components/shell/nav-config";
import { ThemeToggle } from "@/components/theme-toggle";
import { VersionReleaseDialog } from "@/components/version-release-dialog";
import { cn } from "@/lib/utils";

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

function useShortcutLabel() {
  return useSyncExternalStore(
    () => () => {},
    () => (isMac() ? "⌘K" : "Ctrl K"),
    () => "⌘K",
  );
}

const iconButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

type TopBarProps = {
  nav: NavEntry[];
  pathname: string;
  onOpenSearch: () => void;
};

/** 悬浮顶栏：侧栏开关 + 当前页面 + 搜索（⌘K）+ 主题 / GitHub / 版本 */
export function TopBar({ nav, pathname, onOpenSearch }: TopBarProps) {
  const current = findNavLink(nav, pathname);
  const shortcut = useShortcutLabel();

  return (
    <div className="shrink-0 px-3 pt-3 md:pr-4 md:pl-3">
      <header className="surface-chrome flex h-14 items-center gap-2 rounded-[18px] pr-2 pl-2.5 sm:gap-3">
        <AnimatedSidebarTrigger
          aria-label="展开或收起侧栏"
          title="展开或收起侧栏（⌘B）"
          className="size-9 rounded-xl border border-border bg-field text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </AnimatedSidebarTrigger>
        <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:block" />
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-foreground">
          {current?.label ?? ""}
        </div>

        <button
          type="button"
          onClick={onOpenSearch}
          className="hidden h-9 w-64 items-center gap-2 rounded-full border border-border bg-field pr-1.5 pl-3 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:border-border-strong hover:bg-field-hover focus-visible:ring-2 focus-visible:ring-ring md:flex lg:w-80"
        >
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">搜索页面或操作…</span>
          <kbd className="rounded-md border border-border bg-background/60 px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground">
            {shortcut}
          </kbd>
        </button>

        <div className="flex items-center gap-0.5 rounded-full border border-border bg-field p-0.5">
          <Tooltip content="搜索" side="bottom">
            <button type="button" onClick={onOpenSearch} aria-label="搜索" className={cn(iconButtonClass, "md:hidden")}>
              <Search />
            </button>
          </Tooltip>
          <Tooltip content="切换主题" side="bottom">
            <span className="inline-flex">
              <ThemeToggle className={iconButtonClass} />
            </span>
          </Tooltip>
          <Tooltip content="GitHub 仓库" side="bottom">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub 仓库" className={iconButtonClass}>
              {/* github.svg 是黑色图标，深色主题下反相成白色 */}
              <img src="/github.svg" alt="" className="size-4 opacity-70 dark:invert" />
            </a>
          </Tooltip>
          <VersionReleaseDialog className="h-8 rounded-full px-2.5 text-[11px]" />
        </div>
      </header>
    </div>
  );
}
