"use client";

import { Search } from "lucide-react";

import { Input } from "@/components/motion/input";
import { cn } from "@/lib/utils";

type SearchInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
};

/** 列表筛选用的搜索框：beUI Input + 左侧放大镜，尺寸与其他表单控件（h-10）对齐 */
export function SearchInput({ value, onValueChange, placeholder, className, "aria-label": ariaLabel }: SearchInputProps) {
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
        field: "h-10 rounded-xl border-input bg-field hover:border-border-strong",
        input: "text-sm [&::-webkit-search-cancel-button]:hidden",
      }}
    />
  );
}
