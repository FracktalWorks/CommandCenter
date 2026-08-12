"use client";

/**
 * Input, Textarea and Select — the shared field primitives.
 *
 * Same reason as Button: the focus treatment is a theme decision (Fluent's
 * tight 2px ring vs Material's 3px) and cannot come from a copied class list.
 *
 *     <Input value={q} onChange={…} placeholder="Search" />
 *     <Input icon="Search" value={q} onChange={…} />
 *     <Textarea rows={4} value={body} onChange={…} />
 *     <Select value={statusId} onChange={…}>{…<option>}</Select>
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
  /**
   * Forwarded to the underlying `<input>`. Declared rather than inherited
   * because `InputHTMLAttributes` does not carry `ref`: on React 19 a function
   * component receives it as an ordinary prop, so the spread below is all the
   * plumbing needed — no `forwardRef` wrapper.
   *
   * Added for WS-27r's search palette, which has to focus its field the moment
   * it opens; a palette you have to click into is a palette you stop using.
   */
  ref?: React.Ref<HTMLInputElement>;
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
  /**
   * Forwarded to the underlying `<textarea>` — declared for the same reason
   * `InputProps.ref` is: the HTML-attribute types do not carry `ref`, and on
   * React 19 a function component receives it as an ordinary prop, so the
   * spread below is the whole plumbing. Projects' comment box needs it to
   * restore the caret after inserting an @mention.
   */
  ref?: React.Ref<HTMLTextAreaElement>;
};

export function Textarea({ inputSize = "md", className = "", ...rest }: TextareaProps) {
  return <textarea {...rest} className={`${BASE} ${SIZES[inputSize]} resize-y ${className}`} />;
}

export type SelectProps = Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  "size" | "className"
> & {
  inputSize?: InputSize;
  className?: string;
  ref?: React.Ref<HTMLSelectElement>;
};

/**
 * Select — the single-choice field primitive (S5).
 *
 * Added because the tree had **no** themed select and every app hand-rolled
 * one: `app/projects/components/{FilterBar,CustomFieldValues,TableView,…}` and
 * `app/tasks/components/{TaskToolbar,TaskSettingsModal,…}` each carry a private
 * `const SELECT = "cc-control rounded-lg border border-border …"` string, and
 * `TaskPanel`'s status control had not even got that far — it was a bare
 * `<select>` with the browser's own chrome, which is what an owner comparing
 * `/projects` and `/tasks` side by side actually saw.
 *
 * Two things a class string cannot do, which is why this is a component:
 *
 * * `appearance-none` + our own `<Icon name="ChevronDown">` puts the disclosure
 *   glyph on the active **pack** — the native triangle is drawn by the OS and
 *   follows neither the theme nor the icon pack;
 * * `cc-control` carries the theme's label transform, tracking and focus ring
 *   (Graphite uppercases, Material's ring is wider), and a copied string goes
 *   stale the moment those tokens change.
 *
 * One honest limit, shared with every `<select>` on the web: the **popup list**
 * is rendered by the browser, so the option rows do not take our tokens. The
 * closed control — which is the part that sits on the surface all the time —
 * does.
 */
export function Select({
  inputSize = "md",
  className = "",
  children,
  ...rest
}: SelectProps) {
  return (
    <div className="relative w-full">
      <select
        {...rest}
        className={`${BASE} ${SIZES[inputSize]} cursor-pointer appearance-none pr-7 disabled:cursor-not-allowed ${className}`}
      >
        {children}
      </select>
      <Icon
        name="ChevronDown"
        size={14}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export type DateInputProps = Omit<InputProps, "type" | "icon"> & {
  /** `date` for a day, `datetime-local` when the time of day matters. */
  precision?: "date" | "datetime";
};

/**
 * A themed date field (WS-27bh).
 *
 * The tree carries raw `<input type="date">` in 12 files, each with its own
 * class string. This is `Input` with the type set and one CSS rule the plain
 * component cannot carry.
 *
 * ## Why a native date input and not a calendar popover
 *
 * The mock's date fields are all *single dates on a form* — expected resume,
 * due date, target date. The native control already gives keyboard entry,
 * locale-correct ordering, the platform's own calendar, mobile's date wheel,
 * and validation, for nothing. A hand-built popover would have to re-earn all
 * of that, and `@base-ui/react` has no date picker to lean on. **If a range
 * picker or an inline month grid is ever needed, that is a different component
 * and a different slice** — do not grow this one into it.
 *
 * The one thing the native control gets wrong for us: WebKit and Blink render
 * the calendar glyph in the UA's own colour, which is near-black on a dark
 * theme and effectively invisible. `dark:[color-scheme:dark]` tells the browser
 * to draw its internal widgets for a dark surface, which fixes the glyph, the
 * clear button and the spin controls in one declaration and stays correct on
 * every theme because it keys off the mode rather than a palette.
 */
export function DateInput({
  precision = "date",
  className = "",
  ...rest
}: DateInputProps) {
  return (
    <Input
      {...rest}
      type={precision === "datetime" ? "datetime-local" : "date"}
      className={`dark:[color-scheme:dark] ${className}`}
    />
  );
}

export default Input;
