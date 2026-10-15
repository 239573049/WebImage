"use client";

import { ThemeToggle } from "@/components/theme-toggle";
import { VersionReleaseDialog } from "@/components/version-release-dialog";
import { cn } from "@/lib/utils";

export function HeaderActions({ className, showGithubText = true }: { className?: string; showGithubText?: boolean }) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <ThemeToggle />
      <a
        href="https://github.com/basketikun/chatgpt2api"
        target="_blank"
        rel="noreferrer"
        className={cn(
          "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl text-sm text-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring/40",
          showGithubText ? "px-2.5" : "w-9",
        )}
        aria-label="GitHub repository"
        title="GitHub"
      >
        {/* github.svg 是黑色图标，深色主题下反相成白色 */}
        <img src="/github.svg" alt="" className="size-4 dark:invert" />
        {showGithubText ? <span className="hidden sm:inline">GitHub</span> : null}
      </a>
      <VersionReleaseDialog />
    </div>
  );
}
