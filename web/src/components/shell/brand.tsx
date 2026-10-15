import { Aperture } from "lucide-react";

import { cn } from "@/lib/utils";

export const BRAND_NAME = "WebImage";
export const GITHUB_URL = "https://github.com/239573049/WebImage";

/** 方形标识：深色底 + 反色图形，浅色/深色主题下都保持高对比 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-8 shrink-0 place-items-center rounded-[10px] bg-foreground text-background", className)}
    >
      <Aperture className="size-[18px]" strokeWidth={2.25} />
    </span>
  );
}

/** 标识 + 字标 + CONSOLE 角标（与参考设计的控制台头部一致） */
export function BrandMark({ className, hideText = false }: { className?: string; hideText?: boolean }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandLogo />
      {hideText ? null : (
        <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
          <span className="truncate text-[16px] font-semibold tracking-tight text-foreground">
            {BRAND_NAME}
            <span className="text-primary">.</span>
          </span>
          <span className="eyebrow shrink-0 text-[9.5px] tracking-[0.16em]">Console</span>
        </span>
      )}
    </span>
  );
}
