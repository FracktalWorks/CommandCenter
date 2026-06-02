import { NextRequest, NextResponse } from "next/server";
import { fetchMemories, saveConversation, deleteMemory, type Mem0Message } from "@/lib/memory";

// GET /api/chat/memories?userId=<id>
// Returns up to 20 memories for the user. Returns [] if Mem0 is not configured.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const memories = await fetchMemories(userId);
  return NextResponse.json(memories);
}

// POST /api/chat/memories
// Body: { userId: string; messages: { role: string; content: string }[] }
// Saves the conversation to Mem0 so facts are extracted and persisted.
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { userId, messages } = (await req.json()) as {
      userId: string;
      messages: Mem0Message[];
    };

    if (!userId || !Array.isArray(messages)) {
      return NextResponse.json({ error: "userId and messages are required" }, { status: 400 });
    }

    await saveConversation(userId, messages);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to save memories" }, { status: 500 });
  }
}

// DELETE /api/chat/memories?id=<memoryId>
// Deletes a single memory entry.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  await deleteMemory(id);
  return NextResponse.json({ ok: true });
}
