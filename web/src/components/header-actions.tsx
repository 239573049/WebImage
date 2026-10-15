"use client";

import { Tooltip } from "@/components/motion/tooltip";
import { GITHUB_URL } from "@/components/shell/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { VersionReleaseDialog } from "@/components/version-release-dialog";
import { cn } from "@/lib/utils";

const iconButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

/** 主题 / GitHub / 版本的胶囊按钮组（登录页右上角；登录后由顶栏承担） */
export function HeaderActions({ className }: { className?: string }) {
  return (
    <div className={cn("surface-chrome flex items-center gap-0.5 rounded-full p-0.5", className)}>
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
  );
}
