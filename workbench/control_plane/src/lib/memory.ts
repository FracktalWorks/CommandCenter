/**
 * Mem0 REST client — server-side utility used by /api/chat/memories.
 *
 * Priority:
 *   1. GATEWAY_BASE_URL → proxies to /memory/* on the FastAPI gateway
 *      (gateway owns auth + Postgres pgvector backend — recommended).
 *   2. MEM0_API_URL → legacy self-hosted Mem0 REST container.
 *   3. Neither set → returns empty / no-op gracefully.
 */

export interface Mem0Memory {
  id: string;
  memory: string;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface Mem0Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function gatewayHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.GATEWAY_INTERNAL_TOKEN ?? process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me"}`,
  };
}

function legacyHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.MEM0_API_KEY) h["Authorization"] = `Token ${process.env.MEM0_API_KEY}`;
  return h;
}

const GATEWAY = () => process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const LEGACY = () => process.env.MEM0_API_URL ?? "";

/**
 * Retrieve all stored memories for a user, most-recent first.
 */
export async function fetchMemories(userId: string): Promise<Mem0Memory[]> {
  // ── Gateway path (preferred) ──────────────────────────────────────────
  try {
    const res = await fetch(
      `${GATEWAY()}/memory/${encodeURIComponent(userId)}`,
      { headers: gatewayHeaders(), next: { revalidate: 0 } }
    );
    if (res.ok) {
      const data = await res.json() as Mem0Memory[] | { results: Mem0Memory[]; memories?: Mem0Memory[] };
      if (Array.isArray(data)) return data;
      return (data as { results?: Mem0Memory[] }).results ?? [];
    }
  } catch {
    // fall through to legacy
  }

  // ── Legacy MEM0_API_URL path ──────────────────────────────────────────
  const baseUrl = LEGACY();
  if (!baseUrl) return [];
  try {
    const res = await fetch(
      `${baseUrl}/v1/memories?user_id=${encodeURIComponent(userId)}&limit=50`,
      { headers: legacyHeaders(), next: { revalidate: 60 } }
    );
    if (!res.ok) return [];
    const data = await res.json() as Mem0Memory[] | { memories: Mem0Memory[] };
    return Array.isArray(data) ? data : (data.memories ?? []);
  } catch {
    return [];
  }
}

/**
 * Search memories by semantic query.
 */
export async function searchMemories(
  userId: string,
  query: string
): Promise<Mem0Memory[]> {
  // ── Gateway path ──────────────────────────────────────────────────────
  try {
    const res = await fetch(
      `${GATEWAY()}/memory/${encodeURIComponent(userId)}/search`,
      {
        method: "POST",
        headers: gatewayHeaders(),
        body: JSON.stringify({ query, limit: 10 }),
      }
    );
    if (res.ok) {
      const data = await res.json() as Mem0Memory[] | { results: Mem0Memory[] };
      if (Array.isArray(data)) return data;
      return (data as { results?: Mem0Memory[] }).results ?? [];
    }
  } catch {
    // fall through
  }

  // ── Legacy path ───────────────────────────────────────────────────────
  const baseUrl = LEGACY();
  if (!baseUrl) return [];
  try {
    const res = await fetch(`${baseUrl}/v1/memories/search`, {
      method: "POST",
      headers: legacyHeaders(),
      body: JSON.stringify({ user_id: userId, query, limit: 10 }),
    });
    if (!res.ok) return [];
    const data = await res.json() as Mem0Memory[] | { memories: Mem0Memory[] };
    return Array.isArray(data) ? data : (data.memories ?? []);
  } catch {
    return [];
  }
}

/**
 * Save a conversation to Mem0 (fire-and-forget — non-critical path).
 */
export async function saveConversation(
  userId: string,
  messages: Mem0Message[]
): Promise<void> {
  if (!messages.length) return;

  // ── Gateway path ──────────────────────────────────────────────────────
  try {
    const res = await fetch(
      `${GATEWAY()}/memory/${encodeURIComponent(userId)}/add`,
      {
        method: "POST",
        headers: gatewayHeaders(),
        body: JSON.stringify({ messages }),
      }
    );
    if (res.ok || res.status === 202) return;
  } catch {
    // fall through
  }

  // ── Legacy path ───────────────────────────────────────────────────────
  const baseUrl = LEGACY();
  if (!baseUrl) return;
  try {
    await fetch(`${baseUrl}/v1/memories`, {
      method: "POST",
      headers: legacyHeaders(),
      body: JSON.stringify({ user_id: userId, messages }),
    });
  } catch {
    /* graceful */
  }
}

/**
 * Delete a single memory by ID.
 */
export async function deleteMemory(userId: string, memoryId: string): Promise<void> {
  // ── Gateway path ──────────────────────────────────────────────────────
  try {
    const res = await fetch(
      `${GATEWAY()}/memory/${encodeURIComponent(userId)}/${encodeURIComponent(memoryId)}`,
      { method: "DELETE", headers: gatewayHeaders() }
    );
    if (res.ok || res.status === 204) return;
  } catch {
    // fall through
  }

  // ── Legacy path ───────────────────────────────────────────────────────
  const baseUrl = LEGACY();
  if (!baseUrl) return;
  try {
    await fetch(`${baseUrl}/v1/memories/${memoryId}`, {
      method: "DELETE",
      headers: legacyHeaders(),
    });
  } catch {
    /* graceful */
  }
}

/**
 * Check if either Mem0 or Graphiti is enabled on the gateway.
 */
export async function fetchMemoryStatus(userId: string): Promise<{
  mem0_enabled: boolean;
  graphiti_enabled: boolean;
  count?: number;
}> {
  try {
    const res = await fetch(
      `${GATEWAY()}/memory/${encodeURIComponent(userId)}/status`,
      { headers: gatewayHeaders(), next: { revalidate: 30 } }
    );
    if (res.ok) return await res.json();
  } catch {
    /* graceful */
  }
  return { mem0_enabled: false, graphiti_enabled: false };
}

