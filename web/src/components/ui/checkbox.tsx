"use client";

import { Checkbox as MotionCheckbox } from "@/components/motion/checkbox";

type CheckboxProps = {
  checked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
};

/** beUI 的复选框：勾选时对勾逐笔画出，兼容原来 checked="indeterminate" 的写法。 */
function Checkbox({ checked = false, onCheckedChange, ...props }: CheckboxProps) {
  return (
    <MotionCheckbox
      checked={checked === true}
      indeterminate={checked === "indeterminate"}
      onCheckedChange={(next) => onCheckedChange?.(next)}
      {...props}
    />
  );
}

export { Checkbox };
