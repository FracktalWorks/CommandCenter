# draw.io Integration — Technical Contracts & Interfaces

> **Type:** Technical design / interface contract
> **Date:** 2026-06-29
> **Status:** Proposed — freeze before ST-DRW-03 starts
> **Companion doc:** [`drawio_integration.md`](./drawio_integration.md) (architecture rationale, components, tickets ST-DRW-01…13, sequencing)
> **Purpose:** Pin the wire contracts so backend (`diagram-svc` + `create_diagram`)
> and frontend (`DrawioEditor` + viewer) can be built in parallel against frozen
> interfaces. **Field names from the draw.io embed protocol marked _(verify @
> ST-DRW-02)_ are confirmed during the spike and may need minor adjustment.**

---

## 0. System context

```
 ┌── agents (MAF + Copilot) ──┐        ┌──────── diagram-svc (headless) ────────┐      ┌── control_plane (Next.js) ──┐
 │ create_diagram(spec, …) ───┼──HTTP─►│ POST /render   POST /validate  /health │      │ DrawioEditor  ◄─postMessage─┼─┐
 │   → write_artifact          │        │  ▲ Playwright page ── postMessage ──┐  │      │   (embed iframe)            │ │
 └─────────────────────────────┘        │  └──────────► self-hosted draw.io ◄─┘  │      └────────────┬────────────────┘ │
                                         └────────────────────┬───────────────────┘                   │ PUT save          │
                                                              │                                        ▼                   │
                              self-hosted draw.io (jgraph/drawio) ◄──────────── same origin, two consumers ────────────────┘
```

Two consumers share **one** self-hosted draw.io deployment: `diagram-svc` drives it
headless (server-side conversion); `DrawioEditor` embeds it in the browser (operator
editing). Same engine → identical layout/routing.

---

## 1. `diagram-svc` — HTTP API

Internal service. **Not** public; reachable only from the gateway/control-plane
network. JSON over HTTP. All responses include `Content-Type: application/json`
except where noted.

### 1.1 Deployment / config

| Aspect | Value |
|---|---|
| Image | `apps/diagram-svc/` (Node 20 + Playwright/Chromium). Joins compose `diagrams` profile. |
| Listen | `DIAGRAM_SVC_PORT` (default `8090`), bound to the internal network only |
| draw.io origin | `DRAWIO_EMBED_URL` (e.g. `http://drawio:8080/?embed=1&proto=json&noSaveBtn=1&noExitBtn=1`) |
| Browser pool | `DIAGRAM_SVC_POOL` warm pages (default `2`); requests beyond the pool queue |
| Limits | `DIAGRAM_SVC_RENDER_TIMEOUT_MS` (default `15000`); max spec bytes `DIAGRAM_SVC_MAX_SPEC` (default `256 KB`) |
| Converter mode | `DIAGRAM_SVC_MODE = "oracle" | "mvp"` — `oracle` = headless draw.io (default); `mvp` = `mmd2drawio` + `mmdc`. **Same API either way.** |

### 1.2 `POST /render`

Convert an authoring spec into a laid-out `.drawio` plus raster/vector previews.

**Request**
```jsonc
{
  "spec": "graph TD\n  A[Client] --> B[API]\n  B --> C[(DB)]",  // required, ≤ MAX_SPEC
  "format": "mermaid",          // required: "mermaid" | "xml" | "csv"
  "layout": "verticalFlow",     // optional; applied for format=xml/csv, and as a
                                //   re-layout for mermaid if `relayout:true`.
                                //   one of §5.1; omit to use draw.io's default
  "outputs": ["drawio", "svg"], // optional, default ["drawio","svg"]; subset of
                                //   "drawio" | "svg" | "png"
  "page_title": "Auth flow",    // optional; sets the diagram page name
  "relayout": false             // optional; force a layout pass even for mermaid
}
```

**Response `200`**
```jsonc
{
  "ok": true,
  "drawio": "<mxfile>…</mxfile>",          // present iff "drawio" requested
  "svg": "<svg …>…</svg>",                  // present iff "svg" requested (raw markup)
  "png_base64": "iVBORw0KGgo…",             // present iff "png" requested
  "stats": { "nodes": 3, "edges": 2, "pages": 1, "render_ms": 412 },
  "warnings": []                            // e.g. ["unsupported shape coerced to rectangle"]
}
```

**Errors** (see §1.5). The most common is `422` for an unparseable spec, carrying the
underlying draw.io/mermaid parser message so the **agent can self-heal** (§2.3).

**Behaviour notes**
- `format:"mermaid"` → loaded via `{action:"load", descriptor:{format:"mermaid"}}`;
  draw.io's importer converts + lays out (clean routing, no LLM coordinates).
- `format:"xml"` → expects **uncompressed simplified `<mxGraphModel>`** (or `<mxfile>`);
  loaded via `{action:"load", xml}`, then `{action:"layout"}` if `layout` set.
- `format:"csv"` → draw.io CSV-import syntax (§5.3); converted + laid out.
- `drawio` output is always **uncompressed** XML (human-diffable, re-editable).
- `svg` is `xmlsvg` (SVG with the editable diagram XML embedded) so the preview file
  is *also* a valid draw.io document.

### 1.3 `POST /validate`

Static-check a `.drawio` without rendering. Used by `create_diagram` before persist,
and available to the viewer.

**Request**
```jsonc
{ "drawio": "<mxfile>…</mxfile>" }   // required
```
**Response `200`**
```jsonc
{
  "ok": false,
  "errors": [
    { "code": "DANGLING_EDGE", "message": "edge 'e3' source 'n9' not found", "cell_id": "e3" },
    { "code": "MALFORMED_XML",  "message": "unexpected end tag at line 12" }
  ],
  "stats": { "nodes": 5, "edges": 4 }
}
```
**Validation rules (minimum):** XML well-formed; every edge `source`/`target`
resolves to an existing cell id; at least one node; no duplicate cell ids.

### 1.4 `GET /health`
`200 {"ok":true,"mode":"oracle","pool":{"size":2,"busy":0},"drawio_reachable":true}`.
Used by compose healthcheck + readiness.

### 1.5 Error model

All non-2xx share:
```jsonc
{ "ok": false, "error": { "code": "SPEC_PARSE_ERROR", "message": "…", "detail": "…" } }
```

| HTTP | `code` | When |
|---|---|---|
| `400` | `BAD_REQUEST` | missing/invalid fields, unknown `format`/`layout`, spec too large |
| `422` | `SPEC_PARSE_ERROR` | draw.io/mermaid could not parse the spec (message = parser output) |
| `422` | `EMPTY_DIAGRAM` | parsed but produced zero cells |
| `504` | `RENDER_TIMEOUT` | exceeded `RENDER_TIMEOUT_MS` (draw.io hung / pathological spec) |
| `503` | `UPSTREAM_UNAVAILABLE` | self-hosted draw.io unreachable |
| `500` | `INTERNAL` | unexpected |

### 1.6 Internal: the headless embed bridge (oracle mode)

Illustrative — the conversion sequence inside `/render`. Confirms how draw.io is
driven headlessly (no human tab).

```js
// pseudo — one pooled Playwright page already at DRAWIO_EMBED_URL
async function render(page, { spec, format, layout, outputs, relayout }) {
  const want = new Set(outputs);
  const result = {};

  // 1) wait for the editor to announce readiness
  await waitForMessage(page, m => m.event === "init");          // {event:"init"}  (verify @ ST-DRW-02)

  // 2) load the spec — draw.io converts + lays out
  const loadMsg = format === "mermaid"
    ? { action: "load", descriptor: { format: "mermaid", data: spec } }
    : format === "csv"
      ? { action: "load", descriptor: { format: "csv", data: spec } }
      : { action: "load", xml: spec };
  post(page, loadMsg);
  await waitForMessage(page, m => m.event === "load", { timeout: RENDER_TIMEOUT_MS });

  // 3) optional explicit layout pass (xml/csv, or relayout)
  if (layout && (format !== "mermaid" || relayout)) {
    post(page, { action: "layout", layouts: [{ layout }] });   // §5.1 names
    await settle(page);
  }

  // 4) export the artefacts we need
  if (want.has("drawio")) result.drawio = (await exportAs(page, "xml")).data;       // uncompressed mxGraph
  if (want.has("svg"))    result.svg    = decodeSvg((await exportAs(page, "xmlsvg")).data);
  if (want.has("png"))    result.png_base64 = stripDataUri((await exportAs(page, "png")).data);

  return result;
}

// exportAs sends {action:"export", format} and awaits {event:"export", format, data}
```

**Failure detection:** a `{event:"error"}` or absence of `{event:"load"}` before
`RENDER_TIMEOUT_MS` → map to `422 SPEC_PARSE_ERROR` / `504 RENDER_TIMEOUT`. In `mvp`
mode the same `/render` contract is satisfied by `mmd2drawio` (→ `drawio`) + `mmdc`
(→ `svg`/`png`), with a local validation pass.

---

## 2. `create_diagram` — agent tool contract

### 2.1 Location & injection
`packages/acb_skills/acb_skills/create_diagram.py`, registered in
`_inject_agent_tools` (`apps/orchestrator/orchestrator/executor.py:504-756`) so it is
appended to **MAF `agent.tools`** and **Copilot `agent._tools`** alike — available to
every agent including the native-MAF email assistant.

### 2.2 Signature & return

```python
async def create_diagram(
    spec: str,
    *,
    format: str = "mermaid",        # "mermaid" | "xml" | "csv"
    title: str,                     # basename for the artefacts (slugified)
    layout: str | None = None,      # §5.1 hint; omit for draw.io default
    page_title: str | None = None,  # diagram page name (defaults to title)
) -> dict:
    """Create a clean, editable draw.io diagram from a Mermaid/XML/CSV spec.

    Prefer Mermaid. Never hand-place coordinates — pass a `layout` hint and let
    draw.io route the edges. Returns the workspace paths of the generated files.
    """
```

**Returns**
```jsonc
{
  "drawio_path": "outputs/auth-flow.drawio",   // editable source of truth
  "svg_path":    "outputs/auth-flow.svg",       // inline preview / email image
  "mmd_path":    "outputs/auth-flow.mmd",       // regeneration source (only for format=mermaid)
  "stats":       { "nodes": 3, "edges": 2 }
}
```

### 2.3 Behaviour (validate + self-heal)

```
1. POST diagram-svc /render {spec, format, layout, outputs:["drawio","svg"]}
2. POST diagram-svc /validate {drawio}
3. if not ok:
     return {"error": "<validation/parse errors>", "hint": "fix the spec and call create_diagram again"}
     # the model sees the error and retries — a broken .drawio is NEVER written
4. write_artifact("outputs/<title>.drawio", drawio)            # source of truth
   write_artifact("outputs/<title>.svg",    svg)               # preview/email
   if format == "mermaid": write_artifact("outputs/<title>.mmd", spec)
5. return paths   # write_artifact emits artifact_created → ArtifactCard appears
```

- Files share a basename in `outputs/`. Re-running with the same `title`
  **deduplicates** via `write_artifact`'s `name (1).ext` behaviour unless the agent
  passes the same path with `overwrite` intent (future `edit_diagram`).
- No new persistence/SSE code — `write_artifact` already handles storage + the
  `artifact_created` event + the workspace tree.

### 2.4 Optional `edit_diagram` (Phase 4)
```python
async def edit_diagram(path: str, instructions: str) -> dict
```
Regenerates from the stored `.mmd` (or merges mxGraph for XML-native diagrams).
**Guard:** if the `.drawio` has been hand-edited in the browser since generation,
return a warning and require explicit confirmation before overwrite (the `.drawio`
is canonical after first manual edit — §4).

### 2.5 Agent guidance (system-prompt / docstring)
- **Default to Mermaid.** Use **`xml`** (simplified `<mxGraphModel>`) only for
  cloud-architecture diagrams needing specific stencils (AWS/GCP/Azure); use **`csv`**
  for large data-driven graphs (org charts, dependency lists).
- **Never compute coordinates.** Pass a `layout` hint; draw.io routes the arrows.
- For **email**, generate then embed the `.svg`/`.png` inline (§do not attach raw
  `.drawio` as the only representation — recipients can't open it).

---

## 3. `DrawioEditor` — frontend component contract

`workbench/control_plane/src/components/DrawioEditor.tsx`.

### 3.1 Props
```ts
interface DrawioEditorProps {
  xml: string;                       // initial .drawio content
  onSave: (xml: string) => void;     // fired on save/autosave (debounced upstream)
  readOnly?: boolean;                // chat inline / mobile → true (view-only)
  autosave?: boolean;                // default true in modal/full-screen
  theme?: "dark" | "light";          // default from app theme
  onError?: (message: string) => void;
}
```

### 3.2 Embed URL
`${NEXT_PUBLIC_DRAWIO_EMBED_URL}` → self-hosted origin with
`?embed=1&proto=json&noSaveBtn=1&noExitBtn=1` (+ `&theme=dark` as applicable, and
read-only chrome params when `readOnly`). **Never** `embed.diagrams.net`.

### 3.3 Message bridge (host ⇄ iframe)

| Direction | Message | When |
|---|---|---|
| iframe → host | `{event:"init"}` | editor ready → host replies with `load` |
| host → iframe | `{action:"load", xml, autosave: autosave?1:0}` | after `init` |
| iframe → host | `{event:"save", xml}` | user saves → `onSave(xml)` |
| iframe → host | `{event:"autosave", xml}` | on change (if autosave) → debounced `onSave(xml)` |
| iframe → host | `{event:"exit"}` | exit (full-screen route → close) |

**Security:** the `message` handler **must check `event.origin === DRAWIO_ORIGIN`**.
The iframe is `sandbox="allow-scripts allow-same-origin"` scoped to the draw.io
origin — note this deliberately differs from the email renderer's `script-src 'none'`
(`MessageContent.tsx`): the editor needs scripts; isolation is by **origin**, not by
banning JS.

### 3.4 Mounting surfaces
1. **`ArtifactViewerModal`** `.drawio` branch (ST-DRW-07): `classify()` →
   `ViewerState.drawio`; fetch bytes from `GET /api/agent/workspace/{session}/file?path=`;
   `onSave` → `PUT /api/agent/workspace/{session}/file?path=` `{content, encoding:"utf-8"}`
   (**existing endpoint**).
2. **`/diagram` full-screen route** (ST-DRW-08): chromeless editor, same `onSave`.
3. **`ArtifactCard`** inline (ST-DRW-09): `readOnly` expand; primary actions are
   **Edit** (→ modal) / **Open** (→ route). The `.svg` sibling is the default preview.

---

## 4. Source-of-truth rules

- **`.drawio` is canonical once it exists.** `.mmd` is the *generation* source.
- After the **first manual browser edit**, regeneration from `.mmd` (`edit_diagram`
  or a re-`create_diagram` with the same title) **warns before overwrite** — the
  hand-edited geometry would otherwise be lost.
- Three artefacts per diagram (same basename, `outputs/`): `.mmd` (regen), `.drawio`
  (edit), `.svg` (preview/email). `.png` on demand for email.
- Validation is **mandatory** before persist; a malformed/dangling-edge `.drawio`
  never reaches the workspace.

---

## 5. Reference appendices

### 5.1 `layout` hints (draw.io layout engine)
`verticalFlow`, `horizontalFlow`, `verticalTree`, `horizontalTree`, `radialTree`,
`organic`, `circle`. Flowcharts → `verticalFlow`/`horizontalFlow`; hierarchies/org
charts → `*Tree`; dense graphs → `organic`. Omit to accept draw.io's default for the
detected diagram type.

### 5.2 Supported Mermaid diagram types (interim format)
`flowchart`/`graph`, `sequenceDiagram`, `classDiagram`, `stateDiagram`,
`erDiagram`, `gantt`, `mindmap`, `journey`. Flowchart/graph is the primary target and
the best-routed; others convert but with type-specific layout.

### 5.3 CSV import (data-driven path)
draw.io CSV uses a `##`-prefixed config header (`# style:`, `# connect:`,
`# layout:`) followed by a CSV table; `connect` declares edges by referencing a
column. Use for org charts / large node sets generated from a list. (Full syntax:
draw.io "CSV import" docs.)

### 5.4 draw.io embed messages used (subset)
Host→editor: `load` (with `xml` or `descriptor`), `export` (`xml`|`xmlsvg`|`png`),
`layout`. Editor→host: `init`, `load`, `save`, `autosave`, `export`, `exit`,
`error`. Activated by `embed=1&proto=json`. _(Exact field names verified @ ST-DRW-02.)_

---

## 6. Contract freeze checklist

- [ ] `/render`, `/validate`, `/health` request/response shapes (§1) agreed
- [ ] `create_diagram` signature + return + self-heal behaviour (§2) agreed
- [ ] `DrawioEditor` props + message bridge + origin check (§3) agreed
- [ ] `DRAWIO_EMBED_URL`, `DIAGRAM_SVC_PORT`, `NEXT_PUBLIC_DRAWIO_EMBED_URL` env names agreed
- [ ] Embed protocol field names confirmed in the ST-DRW-02 spike → update §1.6/§5.4

Once checked, backend (diagram-svc + tool) and frontend (editor + viewer) proceed in
parallel.
```
