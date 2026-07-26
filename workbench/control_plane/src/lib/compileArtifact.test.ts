import { describe, expect, it } from "vitest";

import { compileArtifact } from "./compileArtifact";

const COMPONENT = `
import { useState } from "react";

export default function Artifact() {
  const [n, setN] = useState(3);
  return <div className="cc-report"><h1>{n}</h1>
    <button onClick={() => setN(n + 1)}>inc</button></div>;
}
`;

describe("compileArtifact", () => {
  it("compiles a React component with hooks into a self-contained bundle", async () => {
    const res = await compileArtifact(COMPONENT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Self-contained: the runtime is inlined, so nothing is left to import.
    expect(res.js).not.toMatch(/\bimport\s|\brequire\(/);
    expect(res.js).toContain("#root".slice(1)); // mounts into the root element
    expect(res.bytes).toBeGreaterThan(5_000);
  });

  it("keeps the bundle small by aliasing react to preact/compat", async () => {
    const res = await compileArtifact(COMPONENT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Real react+react-dom lands near 194 KB; preact/compat near 19 KB. Guard the
    // 10x win so an accidental de-aliasing shows up as a failing test, not a
    // silently heavier chat.
    expect(res.bytes).toBeLessThan(60_000);
  });

  it("accepts TypeScript syntax", async () => {
    const res = await compileArtifact(
      "export default function A(): unknown { const x: number = 1; return <p>{x}</p>; }",
    );
    expect(res.ok).toBe(true);
  });

  // ── The allowlist is a security boundary, not a convenience ──────────────
  // This compiles untrusted model output on the server. Unrestricted resolution
  // would let an artifact inline arbitrary file contents into output we hand
  // back to the client.

  // NOTE: each case must *use* the imported binding. The tsx loader applies
  // TypeScript import elision, so an unused import is stripped before it is ever
  // resolved — harmless (nothing is read) but it would silently no-op the test.
  it.each([
    ["node builtin", "fs", '"fs"'],
    ["absolute path", "x", '"/etc/passwd"'],
    ["relative escape", "x", '"../../../../etc/hosts"'],
    ["sibling source", "x", '"./compileArtifact"'],
    ["third-party package", "x", '"lodash"'],
  ])("refuses to resolve %s", async (_label, binding, spec) => {
    const res = await compileArtifact(
      `import ${binding} from ${spec};\n` +
        `export default function A(){ return <p>{String(${binding})}</p>; }`,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Cannot import/);
  });

  it("elides an unused disallowed import rather than reading it", async () => {
    // Documents the elision above: nothing is resolved, so nothing is read.
    const res = await compileArtifact(
      'import unused from "/etc/passwd";\nexport default function A(){ return <p/>; }',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.js).not.toMatch(/root:|\/bin\/(ba)?sh/);
  });

  it("does not leak file contents when an import is refused", async () => {
    const res = await compileArtifact(
      'import x from "/etc/hostname";\n' +
        "export default function A(){ return <p>{String(x)}</p>; }",
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The refusal names the specifier but never the file's bytes.
    expect(res.error).toContain("/etc/hostname");
  });

  it("allows the React runtime imports an artifact legitimately needs", async () => {
    const res = await compileArtifact(
      'import { useEffect, useMemo } from "react";\n' +
        "export default function A(){ useEffect(()=>{},[]); " +
        "const v = useMemo(()=>2,[]); return <p>{v}</p>; }",
    );
    expect(res.ok).toBe(true);
  });

  // ── Input hygiene ────────────────────────────────────────────────────────

  it("rejects empty source", async () => {
    expect((await compileArtifact("")).ok).toBe(false);
    expect((await compileArtifact("   ")).ok).toBe(false);
  });

  it("rejects oversized source instead of bundling it", async () => {
    const res = await compileArtifact("//" + "x".repeat(300 * 1024));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/larger than/);
  });

  it("reports syntax errors with a line number the agent can act on", async () => {
    const res = await compileArtifact("export default function A(){ return <div>unclosed; }");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/line \d+/);
  });
});
