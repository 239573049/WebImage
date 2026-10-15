"use client";

import { Search } from "lucide-react";

import { Input } from "@/components/motion/input";
import { cn } from "@/lib/utils";

type SearchInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** default 与其他表单控件（h-10）对齐；sm 用在紧凑工具栏（h-8） */
  size?: "default" | "sm";
  "aria-label"?: string;
};

/** 列表筛选用的搜索框：beUI Input + 左侧放大镜 */
export function SearchInput({
  value,
  onValueChange,
  placeholder,
  className,
  size = "default",
  "aria-label": ariaLabel,
}: SearchInputProps) {
  const compact = size === "sm";

  return (
    <Input
      type="search"
      value={value}
      onChange={onValueChange}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      leftIcon={<Search />}
      className={cn("min-w-0", className)}
      classNames={{
        field: cn(
          "border-input bg-field hover:border-border-strong",
          compact ? "h-8 rounded-lg" : "h-10 rounded-xl",
        ),
        leftIcon: compact ? "left-2.5 [&_svg]:h-3.5 [&_svg]:w-3.5" : undefined,
        input: cn("[&::-webkit-search-cancel-button]:hidden", compact ? "pl-8 text-[13px]" : "text-sm"),
      }}
    />
  );
}
