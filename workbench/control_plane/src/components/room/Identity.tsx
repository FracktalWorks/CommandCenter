"use client";

/**
 * Faces and names for the people in a room.
 *
 * The workbench has never rendered a human before — every avatar in the product
 * is an agent's pixel-art sprite (`AgentAvatar`). A room needs the other half:
 * a person, small, recognisable at 20px, with no image to rely on. So initials
 * on a stable colour, derived from the email rather than assigned, because a
 * colour that changes between renders is worse than no colour.
 */

import { useMemo } from "react";
import type { RoomParticipant } from "@/lib/rooms";

/**
 * Six accent hues from the design tokens. Chosen by hash so one person is the
 * same colour in the rail, the transcript, and the share sheet — recognising
 * "the orange one" is most of what an avatar is for at this size.
 */
const HUES = [
  "bg-[hsl(198_89%_50%/0.18)] text-[hsl(198_89%_62%)]",
  "bg-[hsl(27_96%_61%/0.18)] text-[hsl(27_96%_66%)]",
  "bg-[hsl(142_76%_47%/0.18)] text-[hsl(142_76%_52%)]",
  "bg-[hsl(262_60%_62%/0.18)] text-[hsl(262_60%_70%)]",
  "bg-[hsl(340_75%_60%/0.18)] text-[hsl(340_75%_68%)]",
  "bg-[hsl(190_70%_45%/0.18)] text-[hsl(190_70%_55%)]",
];

function hue(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function initialsOf(name: string): string {
  const clean = name.split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function PersonAvatar({
  email,
  displayName,
  avatarUrl,
  size = 24,
  ring = false,
  title,
}: {
  email: string;
  displayName?: string;
  avatarUrl?: string | null;
  size?: number;
  /** A ring means "here right now" — presence, not role. */
  ring?: boolean;
  title?: string;
}) {
  const label = displayName || email;
  const cls = useMemo(() => hue(email || label), [email, label]);
  const style = { width: size, height: size, fontSize: Math.max(8, size * 0.38) };

  return (
    <span
      title={title ?? label}
      style={style}
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none",
        avatarUrl ? "bg-secondary" : cls,
        ring ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "",
      ].join(" ")}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={label}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        initialsOf(label)
      )}
    </span>
  );
}

/**
 * Overlapping faces, freshest first, with a "+N" when the room is bigger than
 * the strip. Used in the header where there is room for a glance and not a list.
 */
export function AvatarStack({
  people,
  here,
  max = 4,
  size = 24,
}: {
  people: RoomParticipant[];
  /** Emails currently present, so the rail and the strip agree on the rings. */
  here: Set<string>;
  max?: number;
  size?: number;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;

  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <span key={p.subject} className={i === 0 ? "" : "-ml-1.5"}>
          <PersonAvatar
            email={p.subject}
            displayName={p.displayName}
            avatarUrl={p.avatarUrl}
            size={size}
            ring={here.has(p.subject)}
            title={here.has(p.subject) ? `${p.displayName} · here now` : p.displayName}
          />
        </span>
      ))}
      {extra > 0 && (
        <span
          style={{ width: size, height: size, fontSize: Math.max(8, size * 0.34) }}
          className="-ml-1.5 inline-flex items-center justify-center rounded-full bg-secondary font-semibold text-muted-foreground"
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

/** Room role as a word, in the room's own vocabulary — never an org role. */
export function RoleLabel({ role }: { role: string | null }) {
  if (!role) return <span className="text-faint">Not a member</span>;
  const copy: Record<string, string> = {
    owner: "Owner",
    member: "Contributor",
    viewer: "Watching",
  };
  return <span className="text-muted-foreground">{copy[role] ?? role}</span>;
}
