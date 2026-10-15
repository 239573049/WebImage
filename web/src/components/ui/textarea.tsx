import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "block min-h-24 w-full rounded-xl border border-input bg-field px-3.5 py-2.5 text-sm text-foreground outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted-foreground/70 hover:border-border-strong hover:bg-field-hover focus-visible:border-primary/70 focus-visible:ring-[3px] focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
