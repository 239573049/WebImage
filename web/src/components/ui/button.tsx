"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { Button as MotionButton, type ButtonProps as MotionButtonProps, type ButtonVariant } from "@/components/motion/button";
import { cn } from "@/lib/utils";

/*
 * 按钮底层是 beUI 的 Button（弹簧按压 + 悬停微放大），这里保留项目原有的 variant / size 命名，
 * 调用方不用改。每个 variant 都显式写出文字色和悬停色，盖掉 beUI 自带 variant 的残留类。
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl text-sm font-medium whitespace-nowrap outline-none select-none transition-[background-color,color,border-color,box-shadow,opacity] duration-150 focus-visible:ring-4 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-45 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(0_0_0/0.12)] hover:bg-primary/90 hover:text-primary-foreground",
        destructive:
          "bg-destructive text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.16)] hover:bg-destructive/90 hover:text-white focus-visible:ring-destructive/30",
        outline: "border border-border bg-field text-foreground hover:border-border-strong hover:bg-accent hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70 hover:text-secondary-foreground",
        tinted: "bg-primary/12 text-primary hover:bg-primary/20 hover:text-primary",
        "tinted-destructive":
          "bg-destructive/12 text-destructive hover:bg-destructive/20 hover:text-destructive focus-visible:ring-destructive/30",
        ghost: "text-foreground/75 hover:bg-accent hover:text-foreground",
        link: "h-auto rounded-md px-0 text-primary underline-offset-4 hover:bg-transparent hover:text-primary hover:underline",
      },
      size: {
        default: "h-10 px-4 has-[>svg]:px-3.5",
        sm: "h-8 gap-1.5 rounded-lg px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-11 px-6 text-[15px] has-[>svg]:px-5",
        icon: "size-9 px-0",
        "icon-sm": "size-8 rounded-lg px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type Variant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

// 选 beUI 里最接近的 variant 当底子，减少需要覆盖的类
const motionVariant: Record<Variant, ButtonVariant> = {
  default: "primary",
  destructive: "primary",
  outline: "outline",
  secondary: "ghost",
  tinted: "ghost",
  "tinted-destructive": "ghost",
  ghost: "ghost",
  link: "ghost",
};

type ButtonProps = Omit<MotionButtonProps, "variant" | "size"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);

  if (asChild) {
    return <Slot data-slot="button" className={classes} {...(props as React.ComponentProps<typeof Slot>)} />;
  }

  return (
    <MotionButton
      data-slot="button"
      variant={motionVariant[variant ?? "default"]}
      pressScale={variant === "link" ? 1 : 0.96}
      className={classes}
      {...props}
    />
  );
}

export { Button, buttonVariants };
