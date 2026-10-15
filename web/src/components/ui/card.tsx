"use client";

import * as React from "react";

import { Card as MotionCard, type CardProps as MotionCardProps } from "@/components/motion/card";
import { cn } from "@/lib/utils";

/*
 * 卡片外壳用 beUI 的 Card（支持 interactive / selected），但间距沿用项目的写法：
 * 每个部件自己带 p-5，所以这里把 beUI 根节点的 gap / py 清零，避免和调用方的 padding 叠加。
 */
function Card({ className, ...props }: Omit<MotionCardProps, "variant" | "size">) {
  return <MotionCard className={cn("surface gap-0 bg-card py-0", className)} {...props} />;
}

/** 卡片头部：标题区与内容区之间有一条发丝分隔线（参考设计里的"用量走势"卡片） */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1.5 border-b border-border p-5", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-title" className={cn("text-[15px] leading-snug font-semibold tracking-tight text-foreground", className)} {...props} />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-[13px] leading-5 text-muted-foreground", className)} {...props} />;
}

/** 头部右侧的操作（"查看全部 ↗" 之类） */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-action" className={cn("flex shrink-0 items-center gap-2", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-5", className)} {...props} />;
}

export { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle };
