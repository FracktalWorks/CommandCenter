"use client";

/**
 * People Center · the avatar cropper (WS-28q).
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.1a · D-PC-17.
 *
 * A square viewport, drag to pan, a slider to zoom — and the crop is sent as
 * **fractions of the source**, because the server works in the image's own
 * coordinate space and a pixel rectangle would crop the wrong region.
 *
 * **This is a courtesy, not a control.** The server centre-crops, squares and
 * resizes whatever it receives, so a bug here misplaces somebody's face; it
 * cannot produce a stored image of the wrong shape or type. That is why the
 * arithmetic lives in `../lib/crop.ts` where it is testable, and why this file
 * holds only the gestures.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";

import {
  ACCEPT,
  type CropState,
  INITIAL_CROP,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  previewStyle,
  rejectReason,
  toCropRect,
} from "../lib/crop";

const VIEWPORT = 220;

interface Props {
  /** The current picture, or null for initials. */
  avatar?: string | null;
  /** Initials to show when there is no picture — never an external request. */
  initials: string;
  /** Absent when the caller may not change it; the control is then not drawn. */
  onUpload?: (file: File, crop: { x: number; y: number; size: number }) => Promise<void>;
  onRemove?: () => Promise<void>;
}

export function AvatarPicker({ avatar, initials, onUpload, onRemove }: Props) {
  /**
   * The file AND its object URL, minted together in the event handler.
   *
   * Not derived in an effect: an object URL is a document-lifetime handle that
   * has to be revoked, and creating it in an effect means a setState inside
   * one, which cascades a render. Minting both in the handler that already has
   * the file keeps the pair in step and leaves the effect with only the
   * cleanup — which is what effects are for.
   */
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const file = picked?.file ?? null;
  const preview = picked?.url ?? null;
  const [source, setSource] = useState({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropState>(INITIAL_CROP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ x: number; y: number; crop: CropState } | null>(null);

  // Revoke on unmount and whenever the choice changes. Not revoking keeps the
  // whole decoded image alive for as long as the tab is open.
  useEffect(() => {
    if (!picked) return;
    return () => URL.revokeObjectURL(picked.url);
  }, [picked]);

  const choose = useCallback((chosen: File | null) => {
    setError(null);
    if (!chosen) return;
    const reason = rejectReason(chosen);
    if (reason) {
      // Refused here AND at the server. This one only saves the round trip.
      setError(reason);
      return;
    }
    setCrop(INITIAL_CROP);
    setPicked({ file: chosen, url: URL.createObjectURL(chosen) });
  }, []);

  async function save() {
    if (!file || !onUpload) return;
    setBusy(true);
    setError(null);
    try {
      await onUpload(file, toCropRect(crop, source));
      setPicked(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const style = source.width ? previewStyle(crop, source, VIEWPORT) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {/*
          The picture, or initials. No external request is made for a fallback:
          Gravatar and its cousins would send a hash of every colleague's email
          address to a third party on every page load.
        */}
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data URI has
          // nothing to optimise: it is already 256×256 and already inline.
          <img
            src={avatar}
            alt=""
            className="h-16 w-16 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-sm text-foreground">
            {initials}
          </span>
        )}

        {onUpload && (
          <div className="flex items-center gap-2">
            {/*
              Hidden behind a Button: "Choose File / No file chosen" is the
              browser's string in the browser's font, and no theme can reach it
              (DESIGN_SYSTEM rule 3).
            */}
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              aria-label="Profile picture"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
            />
            <Button
              size="sm"
              variant="secondary"
              icon="Image"
              onClick={() => inputRef.current?.click()}
            >
              {avatar ? "Change picture" : "Add a picture"}
            </Button>
            {avatar && onRemove && (
              <Button
                size="sm"
                variant="ghost"
                icon="Trash2"
                loading={busy}
                onClick={() => void onRemove()}
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}

      {preview && (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <p className="text-[11px] text-muted-foreground">
            Drag to position, and zoom to fill the circle. It is stored at
            256×256 whatever you upload.
          </p>
          <div
            className="relative overflow-hidden rounded-full border border-border"
            style={{ width: VIEWPORT, height: VIEWPORT }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              dragRef.current = { x: e.clientX, y: e.clientY, crop };
            }}
            onPointerMove={(e) => {
              const start = dragRef.current;
              if (!start) return;
              setCrop({
                ...start.crop,
                offsetX: start.crop.offsetX + (e.clientX - start.x) / VIEWPORT,
                offsetY: start.crop.offsetY + (e.clientY - start.y) / VIEWPORT,
              });
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- an object
                URL for a file the user just picked; there is nothing to fetch. */}
            <img
              src={preview}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none"
              style={style ?? undefined}
              onLoad={(e) =>
                setSource({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
            />
          </div>
          <label className="flex items-center gap-2">
            <Icon name="ZoomIn" className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.05}
              value={crop.zoom}
              aria-label="Zoom"
              className="w-40 accent-primary"
              onChange={(e) =>
                setCrop((c) => ({ ...c, zoom: clampZoom(Number(e.target.value)) }))
              }
            />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} loading={busy}>
              Save picture
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default AvatarPicker;
