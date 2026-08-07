"use client";

/**
 * Input and Textarea — the shared text-entry primitives.
 *
 * Same reason as Button: the focus treatment is a theme decision (Fluent's
 * tight 2px ring vs Material's 3px) and cannot come from a copied class list.
 *
 *     <Input value={q} onChange={…} placeholder="Search" />
 *     <Input icon="Search" value={q} onChange={…} />
 *     <Textarea rows={4} value={body} onChange={…} />
 *
 * Mobile font size stays pinned at 16px on the `lg` size because anything
 * smaller makes iOS zoom the viewport on focus — the reason the app avoids
 * viewport-level zoom restrictions in the first place.
 */

import Icon from "@/components/Icon";

export type InputSize = "sm" | "md" | "lg";

const SIZES: Record<InputSize, string> = {
  sm: "px-2 py-1 text-[11px]",
  md: "px-2.5 py-1.5 text-xs",
  lg: "px-3 py-2 text-sm",
};

const BASE =
  "cc-control w-full rounded-lg border border-border bg-background text-foreground " +
  "placeholder:text-muted-foreground outline-none focus:border-primary/50 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "className"> & {
  inputSize?: InputSize;
  /** Lucide icon name shown inside the field's leading edge. */
  icon?: string;
  className?: string;
};

export function Input({ inputSize = "md", icon, className = "", ...rest }: InputProps) {
  const field = (
    <input
      {...rest}
      className={`${BASE} ${SIZES[inputSize]} ${icon ? "pl-8" : ""} ${className}`}
    />
  );
  if (!icon) return field;
  return (
    <div className="relative w-full">
      <Icon
        name={icon}
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      {field}
    </div>
  );
}

export type TextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "className"
> & {
  inputSize?: InputSize;
  className?: string;
};

export function Textarea({ inputSize = "md", className = "", ...rest }: TextareaProps) {
  return <textarea {...rest} className={`${BASE} ${SIZES[inputSize]} resize-y ${className}`} />;
}

export default Input;
