"use client";

import * as React from "react";
import { PanelLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toggleSidebar, useSidebarCollapsed } from "@/hooks/use-sidebar";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 右侧操作区（刷新、导入等） */
  actions?: React.ReactNode;
  className?: string;
};

/**
 * 页面顶栏：侧栏折叠按钮 + 标题 + 右侧操作。所有页面统一使用，保证标题位置和字号一致。
 * 折叠按钮只在桌面端出现（移动端有自己的顶栏菜单）。
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  const collapsed = useSidebarCollapsed();

  return (
    <header className={cn("flex min-h-10 shrink-0 items-center gap-3", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={toggleSidebar}
        title={collapsed ? "展开侧栏" : "收起侧栏"}
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        className="hidden text-muted-foreground sm:inline-flex"
      >
        <PanelLeft />
      </Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[17px] leading-tight font-semibold tracking-tight">{title}</h1>
        {description ? <p className="truncate text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
  );
}
