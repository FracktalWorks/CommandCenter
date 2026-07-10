"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import {
  Bold, Italic, Underline as UnderlineIcon, Link2, Image as ImageIcon,
  List, Code2, Eye,
} from "lucide-react";

/**
 * Hybrid email-signature editor: a rich-text (WYSIWYG) view you can format —
 * bold/italic/underline, bulleted lists, links on selected text, and embedded
 * images (by URL or uploaded as a data URI) — plus a raw-HTML source view you
 * can switch to for full control. The two views share one HTML string, so a
 * switch round-trips losslessly. Output is DOMPurify-sanitised HTML.
 *
 * Rich editing uses `contentEditable` + `document.execCommand`. execCommand is
 * deprecated but universally supported and perfectly adequate for a signature;
 * it avoids pulling a multi-hundred-KB rich-text dependency into the bundle.
 */

// Signatures are user-authored but we still sanitise: strip scripts/handlers and
// keep only presentational markup + links + images (the tags a mail client will
// actually render). Mirrors the intent of MessageContent's email sanitiser.
const SIG_ALLOWED_TAGS = [
  "a", "b", "strong", "i", "em", "u", "span", "div", "p", "br", "hr",
  "img", "ul", "ol", "li", "table", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "font", "small",
];
const SIG_ALLOWED_ATTR = [
  "href", "target", "rel", "src", "alt", "width", "height", "style",
  "color", "align", "border", "cellpadding", "cellspacing", "class",
];

export function cleanSignatureHtml(html: string): string {
  if (typeof window === "undefined") return html || "";
  return DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS: SIG_ALLOWED_TAGS,
    ALLOWED_ATTR: SIG_ALLOWED_ATTR,
    // data: URIs for uploaded/inline images; http(s) + mailto/tel for links.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/[a-z]+;base64,)/i,
    ADD_ATTR: ["target"],
  });
}

const TB_BTN =
  "p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary " +
  "transition-colors";

export function SignatureEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}) {
  const [mode, setMode] = useState<"rich" | "html">("rich");
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Push the current value INTO the contentEditable only when we (re)enter rich
  // mode — never on every keystroke, or the caret would jump on each render.
  useEffect(() => {
    if (mode === "rich" && editorRef.current) {
      const clean = cleanSignatureHtml(value);
      if (editorRef.current.innerHTML !== clean) {
        editorRef.current.innerHTML = clean;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const syncFromEditor = useCallback(() => {
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }, [onChange]);

  const exec = useCallback(
    (command: string, arg?: string) => {
      editorRef.current?.focus();
      document.execCommand(command, false, arg);
      syncFromEditor();
    },
    [syncFromEditor],
  );

  const addLink = useCallback(() => {
    const url = window.prompt("Link URL (https://…)");
    if (url) exec("createLink", url);
  }, [exec]);

  const addImageByUrl = useCallback(() => {
    const url = window.prompt("Image URL (https://…)");
    if (url) exec("insertImage", url);
  }, [exec]);

  const onPickImage = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") exec("insertImage", reader.result);
      };
      reader.readAsDataURL(file); // embeds as a data: URI
    },
    [exec],
  );

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border bg-secondary/40">
        {mode === "rich" && (
          <>
            <button type="button" className={TB_BTN} title="Bold"
              onMouseDown={(e) => e.preventDefault()} onClick={() => exec("bold")}>
              <Bold size={14} />
            </button>
            <button type="button" className={TB_BTN} title="Italic"
              onMouseDown={(e) => e.preventDefault()} onClick={() => exec("italic")}>
              <Italic size={14} />
            </button>
            <button type="button" className={TB_BTN} title="Underline"
              onMouseDown={(e) => e.preventDefault()} onClick={() => exec("underline")}>
              <UnderlineIcon size={14} />
            </button>
            <span className="w-px h-4 bg-border mx-1" />
            <button type="button" className={TB_BTN} title="Bulleted list"
              onMouseDown={(e) => e.preventDefault()} onClick={() => exec("insertUnorderedList")}>
              <List size={14} />
            </button>
            <button type="button" className={TB_BTN} title="Insert link on selected text"
              onMouseDown={(e) => e.preventDefault()} onClick={addLink}>
              <Link2 size={14} />
            </button>
            <button type="button" className={TB_BTN} title="Insert image by URL"
              onMouseDown={(e) => e.preventDefault()} onClick={addImageByUrl}>
              <ImageIcon size={14} />
            </button>
            <button type="button" className={`${TB_BTN} text-[10px] px-1.5`}
              title="Upload an image (embedded)"
              onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>
              Upload
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { onPickImage(e.target.files?.[0]); e.target.value = ""; }}
            />
          </>
        )}
        {/* View toggle — always on the right */}
        <button
          type="button"
          className={`${TB_BTN} ml-auto flex items-center gap-1 text-[11px]`}
          title={mode === "rich" ? "Edit raw HTML" : "Back to rich text"}
          onClick={() => setMode((m) => (m === "rich" ? "html" : "rich"))}
        >
          {mode === "rich" ? (<><Code2 size={13} /> HTML</>) : (<><Eye size={13} /> Rich</>)}
        </button>
      </div>

      {/* Editor body */}
      {mode === "rich" ? (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={syncFromEditor}
          onBlur={syncFromEditor}
          data-placeholder="Type your signature — format it, add links or images…"
          className="min-h-[140px] max-h-[320px] overflow-y-auto px-3 py-2 text-sm text-foreground outline-none leading-relaxed [&_a]:text-primary [&_a]:underline [&_img]:max-w-full empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground"
        />
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder="<table>…full HTML signature…</table>"
          className="w-full min-h-[140px] max-h-[320px] px-3 py-2 text-xs font-mono text-foreground bg-background outline-none resize-y"
        />
      )}
    </div>
  );
}
