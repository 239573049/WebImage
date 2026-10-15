"use client";

import { Toaster } from "sonner";

import { useIsDark } from "@/hooks/use-is-dark";

/** 跟随应用主题（而不是系统主题）的 Toaster，外观走设计令牌。 */
export function ThemedToaster() {
  const dark = useIsDark();

  return (
    <Toaster
      position="top-center"
      offset={20}
      theme={dark ? "dark" : "light"}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-2xl !border !border-border !bg-popover !text-popover-foreground !shadow-[0_18px_50px_-18px_rgba(0,0,0,0.45)] !text-[13px]",
        },
      }}
    />
  );
}
