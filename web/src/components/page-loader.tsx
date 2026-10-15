"use client";

import { Loader } from "@/components/motion/loader";
import { cn } from "@/lib/utils";

/** 页面级加载占位（鉴权校验、首屏数据），用 beUI 的点阵加载动画 */
export function PageLoader({ className, label = "加载中" }: { className?: string; label?: string }) {
  return (
    <div className={cn("flex min-h-[40vh] flex-1 items-center justify-center text-primary", className)}>
      <Loader variant="dot-matrix" size={28} label={label} />
    </div>
  );
}
