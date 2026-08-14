/**
 * Whether authentication is configured, bypassed, or enforced — as a pure
 * function of the environment.
 *
 * Spec: `project-docs/specs/platform_control_plane.md` CP-0 ·
 * `project-docs/specs/saas_operations_doctrine.md` §4 findings 1–2 · D33.1.
 *
 * ## Why this is its own module
 *
 * These three booleans decide whether anonymous callers get in. They are a pure
 * function of `process.env` and nothing else — but they used to live in
 * `auth.ts`, behind NextAuth's import graph, which drags in `next/server` and so
 * cannot be loaded in a plain node test. A security predicate that is awkward to
 * test is a security predicate that goes untested, and this one was: the
 * fail-open path (D33.1) shipped and survived because no test could reach it
 * without standing up the framework.
 *
 * `auth.ts` re-exports all three, so every call site keeps importing `@/auth`
 * and nothing else moves.
 */

/** The environment fields the posture depends on. Nothing else is read. */
export interface AuthEnv {
  AUTH_MICROSOFT_ENTRA_ID_ID?: string;
  AUTH_GOOGLE_ID?: string;
  NODE_ENV?: string;
}

export interface AuthPosture {
  /** A real identity provider is configured. */
  isAuthConfigured: boolean;
  /**
   * The laptop case — no provider AND not production — and the **only** case
   * permitted to serve anonymous callers.
   */
  isDevBypass: boolean;
  /**
   * **Authentication is enforced.** What call sites should branch on.
   *
   * Deliberately `!isDevBypass` rather than `isAuthConfigured`: an unconfigured
   * *production* deployment must enforce, even though it has no provider to
   * enforce with. That combination is a misconfiguration — a bad deploy, a lost
   * secret — and the honest answer to it is a refusal (`proxy.ts` returns 503),
   * not the open door the old `Boolean(client_id)` gate produced.
   */
  isAuthEnabled: boolean;
}

/**
 * Derive the posture from an environment.
 *
 * Keyed on `NODE_ENV !== "production"` rather than an opt-in bypass flag: a flag
 * that defaults to open is the same defect wearing a different name, and
 * `next build && next start` already sets production for every real deployment.
 */
export function authPosture(env: AuthEnv): AuthPosture {
  const isAuthConfigured = Boolean(
    env.AUTH_MICROSOFT_ENTRA_ID_ID || env.AUTH_GOOGLE_ID,
  );
  const isDevBypass = !isAuthConfigured && env.NODE_ENV !== "production";
  return { isAuthConfigured, isDevBypass, isAuthEnabled: !isDevBypass };
}

const posture = authPosture(process.env as AuthEnv);

export const isAuthConfigured = posture.isAuthConfigured;
export const isDevBypass = posture.isDevBypass;
export const isAuthEnabled = posture.isAuthEnabled;
