# Upstream connectivity fault — evidence pack

Written 2026-07-28. Paste the body below into a Hostinger support ticket.

The point of this document: **the VPS is not at fault and cannot be fixed from
inside.** Inbound packets from some networks never reach the network interface
at all. Everything below is measurement, not inference, so support can't
reasonably bounce it back as "check your firewall".

Re-collect any of it with:

```bash
gh workflow run vps-forensics.yml --ref main     # deep, read-only
gh workflow run vps-health.yml --ref main -f diagnose=true
```

---

## Ticket body

> **Subject:** VPS 1747539 (187.127.179.143) — inbound packets from some networks never reach the VM
>
> VPS `srv1747539.hstgr.cloud`, IPv4 `187.127.179.143`, KVM 2, Ubuntu 24.04.
>
> Since 2026-07-27 the server is intermittently unreachable from some networks
> while remaining fully reachable from others **at the same moment**. The VM
> itself is healthy throughout — it never reboots on its own, CPU sits at ~3%,
> and it keeps serving traffic to the networks that can reach it.
>
> I have ruled out the server side by measurement, not by inspection:
>
> - `ip -s link show eth0` → **RX errors 0, dropped 0, missed 0**. Nothing
>   arrives and is then discarded.
> - `iptables -L INPUT -v -n` → policy DROP counter at **48 packets / 4871
>   bytes** across 32 minutes of uptime, i.e. background scan noise. Dozens of
>   genuine connection attempts made from a blocked network during that exact
>   window do not appear in the counter at all — the SYNs never arrived.
> - `TcpExtListenDrops 2`, `SyncookiesSent 0`, `ListenOverflows 0`,
>   `TCPBacklogDrop 0`.
> - **No fail2ban, no CrowdSec, no ipset** are installed. Nothing on the host
>   bans IP addresses.
> - `ufw` is active and explicitly ALLOWs 22, 80, 443, 8080, 3001 from
>   Anywhere (v4 and v6).
> - Only `monarx-agent` and `qemu-guest-agent` run as additional services;
>   neither filters packets.
> - Listeners are correct and bound to all interfaces: `*:443` and `*:80`
>   (caddy), `0.0.0.0:8080` (uvicorn), `*:3001` (next-server), `0.0.0.0:22`
>   (sshd).
> - No Hostinger cloud firewall is attached (`firewall_group_id: null`).
>
> Observed simultaneously, which is the core of the problem:
>
> | Source network | Result |
> | --- | --- |
> | GitHub Actions runners (Azure) | SSH connects on first attempt; HTTPS returns 200 |
> | Client on Airtel Broadband, India (122.172.81.47) | 100% ICMP loss; TCP 22/80/443/8080 all time out (packets dropped, no RST) |
>
> A traceroute from the affected client stops at hop 4, `182.79.240.3`, inside
> Airtel's own network — the packets never reach Hostinger's edge.
>
> Also unexplained and possibly related: the VM was restarted twice on
> 2026-07-27 (04:11 and 11:41 UTC) without any action from us, and there was a
> ~1 GB incoming traffic spike around 06:15 UTC that day against a ~30 MB
> baseline.
>
> Questions:
> 1. Is `187.127.179.143` subject to any DDoS mitigation, null-routing, or
>    rate-limiting that would drop traffic selectively by source network?
> 2. Were the two reboots on 2026-07-27 initiated by Hostinger, and why?
> 3. Is there a known routing issue between Hostinger and Airtel (AS24560 /
>    AS9498) for this IP or its prefix?
> 4. If none of the above, can the VM be assigned a different IPv4 to test
>    whether the problem follows the address or the route?

---

## What we are NOT doing, and why

**Not moving DNS to Cloudflare.** It would route visitors via anycast and hide
the fault, but `fracktal.in` carries Microsoft 365 mail (MX to
`fracktal-in.mail.protection.outlook.com`), four DKIM selector sets, Brevo,
Zoho Desk, Shiprocket, Atlassian and Google verification records — roughly two
dozen entries. A nameserver migration risks silently breaking mail for the
company to work around someone else's routing fault. Revisit only if Hostinger
confirms the fault is theirs and will not fix it.

**Not changing anything on the box.** There is nothing to change — see above.

## Confirming the diagnosis in one minute

Load `https://commandcenter.fracktal.in` on a phone with wifi **off** (mobile
data). If it loads, the server is fine and the fault is the fixed-line ISP
path. That single test is worth more than any further server-side inspection.
