"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { pageFadeUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

type PageEnterProps = {
  children: ReactNode;
  className?: string;
};

/** 页面主内容入场动画；尊重 prefers-reduced-motion */
export function PageEnter({ children, className }: PageEnterProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <div className={cn("min-h-0", className)}>{children}</div>;
  }

  return (
    <motion.div
      className={cn("min-h-0", className)}
      initial="hidden"
      animate="show"
      variants={pageFadeUp}
      // 避免入场动画期间把滚动容器撑出短暂滚动条
      style={{ willChange: "opacity" }}
    >
      {children}
    </motion.div>
  );
}
