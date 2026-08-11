"use client";

/**
 * The per-layout error boundary (WS-27am item 3).
 *
 * Before this file there was **no error boundary anywhere in the tree** — no
 * `componentDidCatch`, no `ErrorBoundary`, no Next.js `error.tsx`. So one
 * malformed group shape thrown out of one card in one column took React's whole
 * root down and the user got a white page: no chrome, no nav, no way back
 * except a reload, and nothing on screen saying which of the two happened.
 *
 * A boundary per **layout** rather than one per app is the point. The canvases
 * are the untrusted part — they are the code that walks server-shaped data — and
 * scoping the boundary to them keeps the tree, the toolbar, the filter bar and
 * the task panel alive while one canvas is broken. The user can switch view,
 * clear a filter or pick another project, all of which are plausible ways out.
 *
 * ## Retry bumps a key
 *
 * `state.attempt` is the guarded subtree's `key`, and `lib/layoutBoundary.retry`
 * only ever increments it.
 *
 * ⚠️ **Corrected 2026-08-11 — the first version of this paragraph overstated the
 * mechanism, and a wrong explanation in the file everyone reads is worse than
 * none.** It claimed that clearing a flag "hands React the same element identity
 * it was already reconciling, so anything that survived below the boundary is
 * still there". That is not how error boundaries work: React unmounts the entire
 * subtree below the boundary *before* it renders the fallback, so nothing
 * survives either way. The key bump is belt-and-braces against a child that
 * holds identity some other way (a portal, a ref-held instance, a memo keyed on
 * something stale), not the thing that makes Retry work.
 *
 * The bump that genuinely earns its place is `page.tsx`'s `canvasKey`: it
 * changes when the layout or project changes, so a fallback stuck on a broken
 * board clears the moment the user navigates away from it — the "plausible way
 * out" above, made real rather than merely offered.
 *
 * ⚠️ **What Retry cannot do, and does not claim.** The children come from the
 * parent's last render, so if the fault is in the *data* — a group shape the
 * server sent — a re-mount renders the same data and lands back in this
 * fallback. That is still the intended behaviour: a named, themed, dismissible
 * failure on one canvas beats a blank document. Recovering the data is the
 * parent's job (switch layout, reload the project), and switching layout is
 * exactly what remounts this boundary, because `page.tsx` keys it by layout.
 *
 * ## What is fenced and what is not
 *
 * Fenced by `lib/layoutBoundary.test.ts`: the reset arithmetic, that `caught()`
 * cannot reset the key, that this component consumes that arithmetic instead of
 * re-deriving it, and — structurally — that every canvas `app/projects/page.tsx`
 * renders sits inside this component.
 *
 * **Review-only, and deliberately so:** "a malformed group shape must not blank
 * the app" and "Retry re-mounts rather than re-crashing" need a render with a
 * throwing child. This runner is `environment: "node"` with no jsdom and no
 * testing-library, and `include` skips `.tsx` tests entirely. Adding a DOM
 * substrate to fence one component is a bigger decision than this ticket, so
 * those two claims are checked by a human throwing from a canvas, not by CI.
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import {
  type BoundaryState,
  caught,
  clean,
  describeError,
  retry,
} from "@/lib/layoutBoundary";

export interface LayoutBoundaryProps {
  /**
   * The layout being guarded, in the user's words ("board", "timeline", "My
   * work"). Named in the fallback and in the console line, so a report says
   * WHICH canvas died rather than "Projects broke".
   */
  layout: string;
  children: ReactNode;
}

export class LayoutBoundary extends Component<LayoutBoundaryProps, BoundaryState> {
  state: BoundaryState = clean();

  /** React merges this patch; it carries no `attempt` on purpose. */
  static getDerivedStateFromError(error: unknown) {
    return caught(error);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The only place the stack survives — the fallback shows the message, and a
    // component stack is what makes the difference between "the board broke"
    // and "the due-date chip broke on the board".
    console.error(
      `[LayoutBoundary] the ${this.props.layout} view threw`,
      error,
      info.componentStack,
    );
  }

  private handleRetry = () => {
    this.setState((current) => retry(current));
  };

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
        >
          <Icon name="TriangleAlert" className="h-8 w-8 text-destructive/70" aria-hidden />
          <p className="text-sm text-foreground">
            Something went wrong rendering the {this.props.layout} view.
          </p>
          <p className="max-w-xs text-xs text-muted-foreground">
            {describeError(error)}
          </p>
          <p className="max-w-xs text-xs text-muted-foreground/80">
            The rest of the app is still working — switch view or pick another
            project if this keeps happening.
          </p>
          <Button variant="secondary" size="sm" icon="RefreshCw" onClick={this.handleRetry}>
            Retry
          </Button>
        </div>
      );
    }
    // The key IS the retry. See the header, and `lib/layoutBoundary.ts`.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
