"use client";

import * as React from "react";

import * as MotionTabs from "@/components/motion/tabs";
import { cn } from "@/lib/utils";

type TabsVariant = "segment" | "underline" | "pill";

const TabsVariantContext = React.createContext<TabsVariant>("segment");

/**
 * beUI 的 Tabs：选中指示器在选项之间弹簧滑动，选项过多时自带左右滚动按钮。
 * variant：segment（分段控件，默认）/ underline（下划线，适合标签很多的设置页）/ pill。
 */
function Tabs({ variant = "segment", className, ...props }: React.ComponentProps<typeof MotionTabs.Tabs>) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <MotionTabs.Tabs variant={variant} className={cn("flex flex-col gap-4", className)} {...props} />
    </TabsVariantContext.Provider>
  );
}

function TabsList({ className, wrapperClassName, ...props }: React.ComponentProps<typeof MotionTabs.TabsList>) {
  const variant = React.useContext(TabsVariantContext);
  return (
    <MotionTabs.TabsList
      wrapperClassName={cn(variant === "underline" && "border-b border-border", wrapperClassName)}
      className={cn(
        variant === "segment" && "gap-0.5 rounded-xl border border-border bg-field p-1",
        variant === "underline" && "gap-1 border-b-0",
        variant === "pill" && "border border-border bg-field",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, indicatorClassName, ...props }: React.ComponentProps<typeof MotionTabs.TabsTrigger>) {
  const variant = React.useContext(TabsVariantContext);
  return (
    <MotionTabs.TabsTrigger
      className={cn(
        "gap-1.5 text-[13px] [&_svg]:size-4 [&_svg]:shrink-0",
        variant === "segment" && "rounded-lg px-3.5 py-1.5",
        variant === "underline" && "min-h-11 px-3.5",
        className,
      )}
      indicatorClassName={cn(
        variant === "segment" && "rounded-lg",
        variant === "underline" && "h-0.5 rounded-full",
        indicatorClassName,
      )}
      {...props}
    />
  );
}

/** 未激活的面板默认卸载：设置页、调试页的每个面板都有自己的数据加载和轮询 */
function TabsContent({ className, keepMounted = false, ...props }: React.ComponentProps<typeof MotionTabs.TabsContent>) {
  return <MotionTabs.TabsContent keepMounted={keepMounted} className={cn("mt-0 min-h-0 flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
