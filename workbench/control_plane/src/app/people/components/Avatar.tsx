/**
 * People Center · the person avatar (WS-28q).
 *
 * The picture, or their initials. **One component**, so "what does a person
 * without a photo look like" is answered in one place — the directory row, the
 * person page and My Profile all draw the same thing at different sizes.
 *
 * No external request is ever made for a fallback. Gravatar and its cousins
 * would send a hash of every colleague's email address to a third party on
 * every page load, which is not a trade this product gets to make on somebody
 * else's behalf (§3.1a).
 */

import { initials } from "../lib/directory";

interface Props {
  name: string;
  /** A `data:image/jpeg` URI, or null/undefined for initials. */
  avatar?: string | null;
  /** Tailwind size class — the caller decides how big, not this. */
  className?: string;
}

export function Avatar({ name, avatar, className = "size-7 text-[10px]" }: Props) {
  if (avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a data URI is
      // already inline and already 256x256; there is nothing to optimise or
      // fetch, and next/image would only add a wrapper around it.
      <img
        src={avatar}
        alt=""
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-foreground ${className}`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export default Avatar;
