/**
 * GET    /api/chat/memories            this member's stored memories
 * POST   /api/chat/memories            save a conversation to their memory
 * DELETE /api/chat/memories?id=<id>    delete one of their memories
 *
 * The scope is ALWAYS the signed-in member. It used to come from a `userId`
 * query parameter or request body, which — because `/api/chat/` is in the
 * proxy's public list and this handler never called `auth()` — meant anyone
 * who could reach the site could read, append to, or delete any colleague's
 * private memories by naming them in a URL. `lib/memory.ts` forwarded only the
 * internal token, so the gateway saw a service principal and had nobody to
 * check the scope against.
 *
 * `userId` is therefore no longer an input. A caller that sends one is ignored
 * rather than refused: the parameter is gone, not renamed, and failing loudly
 * on it would only tell a prober that it once worked.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth, isAuthEnabled } from "@/auth";
import {
  fetchMemories,
  saveConversation,
  deleteMemory,
  type Mem0Message,
} from "@/lib/memory";

export const dynamic = "force-dynamic";

/** The signed-in member's email, or null when there is nobody to act as. */
async function actor(): Promise<string | null> {
  try {
    const session = await auth();
    const email = session?.user?.email;
    if (email) return email;
  } catch {
    /* not a request context */
  }
  // Auth disabled (local dev) keeps the previous dev identity so the memory
  // panel still works on a laptop; with auth ON, no session means no scope.
  return isAuthEnabled ? null : "dev@fracktal.in";
}

const UNAUTHORIZED = NextResponse.json(
  { error: "Sign in to use memory" },
  { status: 401 }
);

export async function GET(): Promise<NextResponse> {
  const me = await actor();
  if (!me) return UNAUTHORIZED;
  return NextResponse.json(await fetchMemories(me, me));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const me = await actor();
  if (!me) return UNAUTHORIZED;
  try {
    const { messages } = (await req.json()) as { messages: Mem0Message[] };
    if (!Array.isArray(messages)) {
      return NextResponse.json({ error: "messages are required" }, { status: 400 });
    }
    await saveConversation(me, messages, me);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to save memories" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const me = await actor();
  if (!me) return UNAUTHORIZED;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  await deleteMemory(me, id, me);
  return NextResponse.json({ ok: true });
}
