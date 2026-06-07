import { NextRequest, NextResponse } from "next/server";
import { fetchMemories, saveConversation, deleteMemory, type Mem0Message } from "@/lib/memory";

// GET /api/chat/memories?userId=<id>
export async function GET(req: NextRequest): Promise<NextResponse> {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const memories = await fetchMemories(userId);
  return NextResponse.json(memories);
}

// POST /api/chat/memories
// Body: { userId: string; messages: { role: string; content: string }[] }
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

// DELETE /api/chat/memories?userId=<id>&id=<memoryId>
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const id = req.nextUrl.searchParams.get("id");
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  await deleteMemory(userId, id);
  return NextResponse.json({ ok: true });
}
