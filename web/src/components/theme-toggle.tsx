"use client";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  return (
    <AnimatedThemeToggler
      aria-label="切换主题"
      variant="circle"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring/40 [&_svg]:size-4",
        className,
      )}
    />
  );
}
