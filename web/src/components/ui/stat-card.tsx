"use client";

import * as React from "react";

import { AnimatedNumber } from "@/components/motion/animated-number";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "danger" | "info" | "primary";

type StatCardProps = {
  label: React.ReactNode;
  /** 数字会用 beUI 的 AnimatedNumber 滚动到目标值；其他内容原样显示 */
  value: React.ReactNode;
  /** value 为数字时的格式化 */
  format?: (value: number) => string;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  /** 图标底色的语义色；数值本身始终用正文色 */
  tone?: Tone;
  /** 标题行右侧的补充信息（例如峰值、环比） */
  aside?: React.ReactNode;
  /** 迷你趋势线 */
  trend?: number[];
  className?: string;
};

const toneClass: Record<Tone, string> = {
  default: "border-border text-muted-foreground",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
  info: "border-info/25 bg-info/10 text-info",
  primary: "border-primary/25 bg-primary/10 text-primary",
};

/** 指标卡：图标 + 小标题 + 大数字 + 说明，可选迷你趋势线。 */
export function StatCard({ label, value, format, hint, icon, tone = "default", aside, trend, className }: StatCardProps) {
  return (
    <Card className={cn("min-w-0 gap-3 overflow-hidden rounded-2xl p-4 sm:p-5", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? (
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border [&_svg]:size-3.5", toneClass[tone])}>
              {icon}
            </span>
          ) : null}
          <span className="truncate text-[12px] font-medium text-muted-foreground">{label}</span>
        </div>
        {aside ? <div className="shrink-0 text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      <div className="truncate text-[26px] leading-none font-semibold tracking-tight text-foreground">
        {typeof value === "number" ? <AnimatedNumber value={value} format={format} duration={0.9} /> : value}
      </div>
      {hint ? <div className="truncate text-xs text-muted-foreground">{hint}</div> : null}
      {trend && trend.length > 1 ? <Sparkline values={trend} className="-mx-1 mt-auto h-9" /> : null}
    </Card>
  );
}

/** 单序列迷你趋势：2px 主色线 + 10% 面积，不画坐标轴（数值见卡片正文） */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const width = 200;
  const height = 40;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(height - 2 - (value / max) * (height - 6)).toFixed(2)}`);
  const line = `M${points.join("L")}`;
  const area = `${line}L${width},${height}L0,${height}Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" className={cn("block w-full", className)}>
      <path d={area} className="fill-primary/10" />
      <path
        d={line}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="stroke-primary"
      />
    </svg>
  );
}
