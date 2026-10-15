import * as React from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  /** 标题上方的全大写小标签，例如 ACCOUNT POOL */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 右侧操作区（刷新、导入、筛选等） */
  actions?: React.ReactNode;
  className?: string;
};

/**
 * 页面标题区：小标签 + 大标题 + 说明 + 右侧操作。所有页面统一使用，保证层级和间距一致。
 * 侧栏开关和当前页面名称在顶栏里，这里只负责内容区的标题。
 */
export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("flex shrink-0 flex-col gap-4 pb-2 lg:flex-row lg:items-end lg:justify-between", className)}>
      <div className="min-w-0 space-y-2.5">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-foreground sm:text-[30px]">{title}</h1>
        {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">{actions}</div> : null}
    </header>
  );
}
