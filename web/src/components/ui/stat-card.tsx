import * as React from "react";

import { cn } from "@/lib/utils";

type StatCardProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  /** 数值的强调色；默认跟随前景色 */
  tone?: "default" | "success" | "warning" | "danger" | "info" | "primary";
  className?: string;
};

const toneClass: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-info",
  primary: "text-primary",
};

/** 指标卡：小标题 + 大数字 + 说明。 */
export function StatCard({ label, value, hint, icon, tone = "default", className }: StatCardProps) {
  return (
    <div className={cn("glass flex flex-col justify-center gap-1.5 rounded-[20px] p-4", className)}>
      <div className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {icon ? <span className="shrink-0 [&_svg]:size-4">{icon}</span> : null}
      </div>
      <div className={cn("text-2xl leading-tight font-semibold tracking-tight tabular-nums", toneClass[tone])}>
        {value}
      </div>
      {hint ? <div className="text-xs text-muted-foreground/80">{hint}</div> : null}
    </div>
  );
}
