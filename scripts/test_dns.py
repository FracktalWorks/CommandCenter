"""Test DNS resolution from Python on the VPS — sync and async."""
import socket
import asyncio

HOSTS = [
    "api.deepseek.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
    "api.groq.com",
    "api.githubcopilot.com",
    "api.anthropic.com",
]

print("=== Sync DNS ===")
for host in HOSTS:
    try:
        info = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        ips = list(set(a[4][0] for a in info))
        print(f"  {host}: {ips}")
    except Exception as e:
        print(f"  {host}: FAILED — {e}")

print("\n=== Async DNS ===")

async def resolve(host):
    try:
        info = await asyncio.get_event_loop().getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        ips = list(set(a[4][0] for a in info))
        return f"  {host}: {ips}"
    except Exception as e:
        return f"  {host}: FAILED — {e}"

async def main():
    tasks = [resolve(h) for h in HOSTS]
    results = await asyncio.gather(*tasks)
    for r in results:
        print(r)

asyncio.run(main())
