"use client";

/**
 * A real link that hands the plain left-click back to the app.
 *
 * Spec: `project-docs/specs/project_management_app.md` §9.4.2 · ticket WS-27al(1).
 *
 * The problem it solves, stated plainly: a surface whose rows are `onClick`
 * handlers is a surface where cmd-click, ctrl-click, shift-click and
 * middle-click all do nothing. Every other application on the machine opens a
 * second tab. `/projects` measured **zero** `<a href>` before this component,
 * so it was that surface everywhere.
 *
 * So the element is an anchor with a genuine `href` — the browser's own
 * "open in new tab", "copy link address" and status-bar preview come free and
 * are not re-implemented — and the *plain* click is intercepted so the docked
 * panel still opens in place. {@link shouldIntercept} owns which clicks those
 * are, and is unit-tested; this file is composition only.
 *
 * ## Two rules that are easy to get wrong
 *
 * **It is a plain `<a>`, never `next/link`.** The deep link is
 * `/projects?task=<id>` — the same route the reader is already on. A `<Link>`
 * would prefetch the current page once per row (1,200 rows on a big board) to
 * serve a navigation that only ever happens in a *new tab*, where the prefetch
 * is worthless.
 *
 * **It stops propagation, always.** The anchor lives in a `<tr onClick>` (an
 * `<a>` cannot wrap a `<tr>`, so it lands in the title cell and the row keeps
 * its own handler). Without this, a plain click would open the panel twice and
 * a cmd-click would open a new tab *and* the panel — the modifier would be
 * half-honoured, which is worse than not honouring it. The link owns its click.
 */

import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

import { shouldIntercept } from "@/lib/controlLink";

export interface ControlLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> {
  /** Where a modified click goes. Must be a URL that really opens this thing. */
  href: string;
  /** What a plain left-click does instead of navigating. */
  onActivate: (event: MouseEvent<HTMLAnchorElement>) => void;
  children?: ReactNode;
}

export const ControlLink = forwardRef<HTMLAnchorElement, ControlLinkProps>(
  function ControlLink({ href, onActivate, children, className, ...rest }, ref) {
    return (
      <a
        {...rest}
        ref={ref}
        href={href}
        // `cc-link` is the themed keyboard focus ring (globals.css, sharing one
        // declaration with `.cc-control`). Without it every one of these — ~200
        // new focus stops on a long table — would draw Chrome's default outline
        // instead of the theme's, which the conformance suite's seven regexes
        // cannot see because nothing here tests focus appearance.
        //
        // `draggable={false}` because an <a href> is natively draggable, and
        // that steals click-drag text selection: before this component the title
        // was a <span> you could drag-select to copy, and a link would silently
        // take that away.
        className={className ? `cc-link ${className}` : "cc-link"}
        draggable={false}
        onClick={(event) => {
          // See the header note: the link owns the click, whichever way it goes.
          event.stopPropagation();
          if (!shouldIntercept(event)) return;
          event.preventDefault();
          onActivate(event);
        }}
      >
        {children}
      </a>
    );
  },
);
