"""Frontend connectivity audit."""
import json
import urllib.error
import urllib.request

BASE = "http://localhost:3001"
GW   = "http://localhost:8000"
KEY  = "sk-local-dev-change-me"
AUTH = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def get(url, headers=None):
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=12) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:
        return None, str(e)[:300]


def post(url, body, headers=None):
    try:
        data = json.dumps(body).encode()
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        req = urllib.request.Request(url, data=data, headers=h)
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()[:600]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:
        return None, str(e)[:300]


# ── Pages ──────────────────────────────────────────────────────────────────
print("=== PAGES ===")
for page in ["/", "/chat", "/agents", "/integrations", "/settings", "/observability"]:
    s, _ = get(BASE + page)
    s_str = str(s) if s is not None else "ERR"
    print(f"  {'OK' if s == 200 else 'FAIL'} {s_str:>3}  {page}")

# ── Agent list ─────────────────────────────────────────────────────────────
print("\n=== AGENT LIST (/api/agent/list) ===")
s, data = get(BASE + "/api/agent/list")
if isinstance(data, list):
    for a in data:
        print(f"  {a['name']:22} runtime={a.get('runtime','maf'):8} integrations={a.get('integrations',[])}")
else:
    print(f"  FAIL {s}: {data}")

# ── Integration status ─────────────────────────────────────────────────────
print("\n=== INTEGRATION STATUS (/api/integrations/status) ===")
s, data = get(BASE + "/api/integrations/status")
if isinstance(data, list):
    for i in data:
        mark = "✓" if i.get("configured") else "✗"
        mand = "required " if i.get("mandatory") else "optional "
        print(f"  {mark} {i['service']:22} {mand}")
else:
    print(f"  FAIL {s}: {data}")

# ── Integration live tests ─────────────────────────────────────────────────
print("\n=== INTEGRATION TESTS ===")
for svc in ["clickup", "github"]:
    s, data = get(BASE + f"/api/integrations/test?service={svc}")
    if isinstance(data, dict):
        ok = data.get("ok", data.get("healthy", False))
        print(f"  {'OK' if ok else 'FAIL'} {svc:20} {data.get('detail', data.get('error', ''))[:80]}")
    else:
        print(f"  FAIL {s} {svc}: {data}")

# ── LLM / model health ─────────────────────────────────────────────────────
print("\n=== MODEL / LLM HEALTH ===")
s, data = get(BASE + "/api/settings/llm/health")
print(f"  LiteLLM: {s} → {data}")

s, data = get(BASE + "/api/models/all")
if isinstance(data, dict) and "models" in data:
    groups = {}
    for m in data["models"]:
        g = m.get("group", "?")
        groups[g] = groups.get(g, 0) + 1
    print(f"  Models: {dict(groups)}")
else:
    print(f"  Models: {s} → {str(data)[:120]}")

# ── Chat (litellm, fastest path) ───────────────────────────────────────────
print("\n=== CHAT — litellm mode (tier2) ===")
s, raw = post(
    BASE + "/api/agent/chat",
    {"agentName": "task-manager", "message": "Hello, what can you help me with?",
     "messages": [], "threadId": "audit-001", "mode": "litellm", "model": "tier-balanced"},
)
# Parse SSE stream: pick first delta
answer = ""
for line in raw.splitlines():
    if line.startswith("data: "):
        try:
            ev = json.loads(line[6:])
            if ev.get("type") == "delta":
                answer += ev.get("content", "")
            if ev.get("type") == "done":
                break
        except Exception:
            pass
print(f"  HTTP {s} — response preview: {answer[:200]}")

# ── Chat (copilot/MAF mode) ────────────────────────────────────────────────
print("\n=== CHAT — copilot/MAF mode ===")
s2, raw2 = post(
    BASE + "/api/agent/chat",
    {"agentName": "task-manager",
     "message": "What tasks are currently in progress?",
     "messages": [], "threadId": "audit-002", "mode": "copilot"},
)
answer2 = ""
for line in raw2.splitlines():
    if line.startswith("data: "):
        try:
            ev = json.loads(line[6:])
            if ev.get("type") == "delta":
                answer2 += ev.get("content", "")
        except Exception:
            pass
print(f"  HTTP {s2}")
if answer2:
    print(f"  Response preview: {answer2[:300]}")
else:
    print(f"  Raw (first 300): {raw2[:300]}")
