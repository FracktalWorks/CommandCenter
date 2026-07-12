// Emit a self-contained, LIVE-animated office preview (no backend needed).
// node make_preview.mjs  -> writes office-preview.html at the control_plane root.
import fs from "fs";

const ROOT = "../..";
const b64 = (p) => "data:image/png;base64," + fs.readFileSync(`${ROOT}/${p}`).toString("base64");
const cast = JSON.parse(
  fs.readFileSync(`${ROOT}/src/app/observability/office-cast.generated.ts`, "utf8")
    .match(/OFFICE_CAST[^=]*=\s*\{([\s\S]*?)\n\};/)[1]
    .replace(/,\s*$/gm, ",").replace(/(\w+):/g, '"$1":').replace(/,(\s*})/g, "$1")
    .replace(/^/, "{").replace(/$/, "}").replace(/,(\s*})/g, "$1")
);
const AGENTS = Object.keys(cast);
const PROPS = ["plant", "water-cooler", "whiteboard", "coffee", "bookshelf"];
// cycle states so all three (working/idle/error) show live
const STATE = (i) => (i % 4 === 3 ? "error" : i % 2 === 0 ? "working" : "idle");

const style = `
*{box-sizing:border-box} body{margin:0;background:#0d1117;font-family:ui-monospace,monospace;padding:18px}
.hdr{max-width:1000px;margin:0 auto 12px;color:#e8e8ef;font-size:13px}
.hdr small{color:#8b949e}
.oc-room{position:relative;max-width:1000px;margin:0 auto;padding:52px 24px 24px;
  background:linear-gradient(#2c2438,#241d30) padding-box,
  repeating-linear-gradient(0deg,transparent,transparent 33px,rgba(255,255,255,.028) 33px,rgba(255,255,255,.028) 34px),
  repeating-linear-gradient(90deg,transparent,transparent 33px,rgba(255,255,255,.028) 33px,rgba(255,255,255,.028) 34px);
  border:5px solid #3a2f4a;border-radius:16px;box-shadow:inset 0 0 0 3px #1b1626,inset 0 20px 44px rgba(0,0,0,.4)}
.oc-wall{position:absolute;inset:5px 5px auto 5px;height:40px;background:linear-gradient(#3a2f4a,#2c2440);
  border-radius:12px 12px 0 0;border-bottom:3px solid #1b1626;display:flex;align-items:center;gap:18px;padding:0 18px}
.oc-prop{height:36px;image-rendering:pixelated;filter:drop-shadow(0 2px 2px rgba(0,0,0,.4))}
.oc-grid{position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;z-index:2}
.oc-seat{position:relative;display:flex;flex-direction:column;align-items:center;padding:4px 0}
.oc-figure{position:relative;height:128px;display:flex;align-items:flex-end}
.oc-static,.oc-anim{image-rendering:pixelated;filter:drop-shadow(0 5px 4px rgba(0,0,0,.55))}
.oc-static{height:128px}
.oc-anim{--w:128px;display:block;width:var(--w);height:var(--w);background-repeat:no-repeat;
  background-size:calc(var(--n)*var(--w)) var(--w);background-position:0 0;
  animation:oc-play calc(var(--n)*.12s) steps(var(--n)) infinite}
.oc-idle .oc-static{animation:oc-breathe 3.4s ease-in-out infinite}
.oc-idle .oc-figure{filter:grayscale(.5) brightness(.72)}
.oc-error .oc-static{animation:oc-shake .4s steps(2) infinite}
.oc-zzz{position:absolute;top:2px;right:24px;color:#8b949e;font-size:13px;animation:oc-zf 2.6s ease-in-out infinite}
.oc-ping{position:absolute;top:14px;right:26px;width:7px;height:7px;border-radius:50%;background:#58a6ff;box-shadow:0 0 8px #58a6ff;animation:oc-pl 1.2s steps(2) infinite}
.oc-plate{margin-top:-4px;text-align:center}
.oc-name{display:block;font-size:12px;color:#e8e8ef;font-weight:600}
.oc-pill{display:inline-block;margin-top:2px;font-size:9px;text-transform:uppercase;padding:1px 6px;border-radius:5px;border:1px solid}
.oc-pill.oc-working{color:#f5b301;border-color:#f5b30155;background:#f5b30115}
.oc-pill.oc-idle{color:#8b949e;border-color:#8b949e33}
.oc-pill.oc-error{color:#ff6b6b;border-color:#ff6b6b44;background:#ff6b6b12}
@keyframes oc-play{to{background-position-x:calc(-1*var(--n)*var(--w))}}
@keyframes oc-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(1px) scale(.994)}}
@keyframes oc-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
@keyframes oc-zf{0%{opacity:0;transform:translateY(0)}40%{opacity:.85}100%{opacity:0;transform:translateY(-8px)}}
@keyframes oc-pl{0%,100%{opacity:1}50%{opacity:.3}}
`;

function seat(a, i) {
  const s = STATE(i);
  const c = cast[a];
  const fig = s === "working" && c.working
    ? `<span class="oc-anim" style="--n:${c.workingFrames};background-image:url(${b64("public" + c.working)})"></span>`
    : `<img class="oc-static" src="${b64("public" + c.seated)}"/>`;
  return `<div class="oc-seat oc-${s}"><div class="oc-figure">${fig}
    ${s === "idle" ? '<span class="oc-zzz">z</span>' : ""}${s === "working" ? '<span class="oc-ping"></span>' : ""}</div>
    <div class="oc-plate"><span class="oc-name">${a}</span><span class="oc-pill oc-${s}">${s === "idle" ? "sleeping" : s}</span></div></div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Agent Office preview</title><style>${style}</style></head>
<body><div class="hdr">Agent Office &mdash; live preview <small>(standalone; the real page is /observability &rarr; Office. Working agents play the typing animation, idle breathe, error shakes.)</small></div>
<div class="oc-room"><div class="oc-wall">${PROPS.map((p) => `<img class="oc-prop" src="${b64(`public/office-props/${p}.png`)}"/>`).join("")}</div>
<div class="oc-grid">${AGENTS.map((a, i) => seat(a, i)).join("")}</div></div></body></html>`;

fs.writeFileSync(`${ROOT}/office-preview.html`, html);
console.log("wrote office-preview.html (", (html.length / 1024) | 0, "KB )");
