import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl text-sm font-medium whitespace-nowrap outline-none select-none transition-[background-color,color,border-color,box-shadow,transform,opacity] duration-150 focus-visible:ring-4 focus-visible:ring-ring/40 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // 主操作：系统蓝实心
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] hover:bg-destructive/90 focus-visible:ring-destructive/30",
        // 描边：半透明面板 + 1px 边框
        outline: "border border-border bg-card text-foreground hover:bg-accent",
        // 灰色填充
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        // 淡色底 + 彩色字（Apple 的 tinted 按钮）
        tinted: "bg-primary/15 text-primary hover:bg-primary/25",
        "tinted-destructive":
          "bg-destructive/15 text-destructive hover:bg-destructive/25 focus-visible:ring-destructive/30",
        ghost: "text-foreground/75 hover:bg-accent hover:text-foreground",
        link: "h-auto rounded-md px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 has-[>svg]:px-3.5",
        sm: "h-8 gap-1.5 rounded-lg px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-11 px-6 text-[15px] has-[>svg]:px-5",
        icon: "size-9",
        "icon-sm": "size-8 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
