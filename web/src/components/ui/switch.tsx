"use client";

import { Switch as MotionSwitch } from "@/components/motion/switch";

type SwitchProps = {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

/** beUI 的开关：滑块带弹簧和按压形变，禁用时按下会轻微抖动提示。 */
function Switch({ checked = false, onCheckedChange, disabled, className, "aria-label": ariaLabel }: SwitchProps) {
  return (
    <MotionSwitch
      checked={checked}
      onCheckedChange={(next) => onCheckedChange?.(next)}
      disabled={disabled}
      ariaLabel={ariaLabel}
      className={className}
    />
  );
}

export { Switch };
