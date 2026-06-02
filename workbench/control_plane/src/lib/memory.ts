/**
 * Mem0 REST client — server-side utility used by /api/chat/memories.
 *
 * Mem0 is optional. If MEM0_API_URL is not set, all functions return empty
 * results / no-op — the rest of the system degrades gracefully.
 *
 * Self-hosted Mem0 API docs: https://docs.mem0.ai/api-reference
 * Run via Docker:  docker run -p 8765:8000 mem0ai/mem0:latest
 */

export interface Mem0Memory {
  id: string;
  memory: string;
  user_id?: string;
  created_at?: string;
}

export interface Mem0Message {
  role: "user" | "assistant" | "system";
  content: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.MEM0_API_KEY) {
    h["Authorization"] = `Token ${process.env.MEM0_API_KEY}`;
  }
  return h;
}

/**
 * Retrieve all stored memories for a user, most-recent first.
 */
export async function fetchMemories(userId: string): Promise<Mem0Memory[]> {
  const baseUrl = process.env.MEM0_API_URL;
  if (!baseUrl) return [];

  try {
    const res = await fetch(
      `${baseUrl}/v1/memories?user_id=${encodeURIComponent(userId)}&limit=20`,
      { headers: headers(), next: { revalidate: 60 } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as Mem0Memory[] | { memories: Mem0Memory[] };
    return Array.isArray(data) ? data : (data.memories ?? []);
  } catch {
    return [];
  }
}

/**
 * Search memories by semantic query (used by the orchestrator to retrieve
 * context relevant to the current task before running an agent).
 */
export async function searchMemories(
  userId: string,
  query: string
): Promise<Mem0Memory[]> {
  const baseUrl = process.env.MEM0_API_URL;
  if (!baseUrl) return [];

  try {
    const res = await fetch(`${baseUrl}/v1/memories/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ user_id: userId, query, limit: 10 }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Mem0Memory[] | { memories: Mem0Memory[] };
    return Array.isArray(data) ? data : (data.memories ?? []);
  } catch {
    return [];
  }
}

/**
 * Save a conversation to Mem0. Mem0 extracts semantic facts automatically
 * from the message list (it does not store raw messages verbatim).
 *
 * Called from /api/chat/memories POST after a session ends.
 */
export async function saveConversation(
  userId: string,
  messages: Mem0Message[]
): Promise<void> {
  const baseUrl = process.env.MEM0_API_URL;
  if (!baseUrl || messages.length === 0) return;

  try {
    await fetch(`${baseUrl}/v1/memories`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ user_id: userId, messages }),
    });
  } catch {
    // Graceful degradation — memory is best-effort, not critical path.
  }
}

/**
 * Delete a single memory by ID.
 */
export async function deleteMemory(memoryId: string): Promise<void> {
  const baseUrl = process.env.MEM0_API_URL;
  if (!baseUrl) return;

  try {
    await fetch(`${baseUrl}/v1/memories/${memoryId}`, {
      method: "DELETE",
      headers: headers(),
    });
  } catch {
    /* graceful */
  }
}
