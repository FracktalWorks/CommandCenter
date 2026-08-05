# Deploy delivery path — getting merged code onto the box

**Status: 🔴 BROKEN — diagnosed and measured 2026-08-05, verified against code and
against the running deployment on 2026-08-05.**

`main` is `d7d5c79b`; the box is `74082882` (#347).

> **⚠️ CORRECTED 2026-08-05, same day.** This spec first claimed five PRs were
> stranded, "including #355, the OAuth authorize fix, which is why mailbox
> connection still fails for a second member." **That was wrong.** #354, #355 and
> #356 are all **live**: the deploy does `git reset --hard origin/main`, so #347's
> successful 04:40 run carried everything merged before it — and those three had
> merged by 01:18. Only what merged *after* 04:40 was stranded.
>
> The error came from reading the box's HEAD (`#347`'s merge commit) as if delivery
> were PR-by-PR. It is not: **one successful deploy lands every commit merged up to
> that instant**, so "the box is on PR n" says nothing about PR n+1 — only about
> *when* the last success ran. Verified per PR with `git log --grep`, and by the
> BFF OAuth route existing on disk dated 04:42.

**Actually stranded: #357 and #358 — eight files, all documentation plus
`scripts/backup_db.sh`. Zero executable app code, zero migrations.** So the broken
delivery path has had **no production impact** to date. Its cost is entirely
forward-looking: the next app change to merge will not ship, and nothing will say so.

This spec owns the *delivery path* only: how a commit on `main` becomes running code
on the VPS. It does not own what the deploy script does once it runs
(`.github/workflows/deploy.yml` `DEPLOY_SCRIPT`), nor backup/restore
(`backup_and_restore.md`), nor identity (`user_management_contract.md`).

---

## 1. Scope and non-goals

**In scope:** the transport that triggers a deploy, and its failure modes.

**Non-goals:** changing deploy *steps*; migration policy; adding a staging
environment; CI test gating. Those are separate concerns and mixing them into this
change is how a transport fix becomes an outage.

---

## 2. The measurement

Deploy runs since 2026-08-04 (`gh run list --workflow deploy.yml`):

| Run | PR | Result | Duration |
|---|---|---|---|
| 30887875428 | #352 | success | 4m17s |
| 30920215465 | #353 | cancelled | 54m14s |
| 30924245024 | #354 | failure | 54m07s |
| 30965985816 | #355 | failure | 54m09s |
| 30965990418 | #356 | failure | 54m14s |
| 30975815621 | #347 | success | 4m05s |
| 30981508246 | #358 | failure | 54m04s |

Successes take ~4 minutes. Failures take ~54 — the retry ladder running to
exhaustion. The failures are intermittent, not a permanent block.

From the failing run's log:

```
ssh: connect to host ***: Connection timed out
not healthy yet (gateway_ok=0 workbench=000000, poll 24/24)
```

`000000` is curl's no-response code: the runner's **HTTPS** probe also got nothing.
So this is not SSH-specific.

**The box was healthy throughout.** During the 55-minute window 06:28–07:23 UTC,
`journalctl -u ssh` logged **four** lines total — one accepted key login from the
operator at 06:25, and two immediately-closed scans. Load average 0.16, uptime
7 days, no reboot. Simultaneously the box answered the operator's machine in 240 ms.

**Conclusion: GitHub's packets do not arrive.** The drop is upstream of the VPS and
affects every port. Nothing on the machine causes it — no fail2ban (not installed),
no iptables rules beyond UFW's own chains, no rate limiting.

Confirmed asymmetry — the box reaches GitHub *outbound* fine:

```
git ls-remote origin HEAD  -> d7d5c79b…   (instant)
curl https://api.github.com -> 200 in 0.029s
```

**Inbound is broken; outbound works.** Every option below follows from that one fact.

### 2.1 Why the existing retry logic cannot save this

`deploy.yml:546-559` already documents Hostinger network flakiness, but it models
the *wrong* failure: it assumes the deploy **ran** and only the SSH teardown flaked,
so it ignores the SSH exit code and verifies by health probe instead. That is a
sound design for a teardown blip. It is useless here, because the session never
establishes — the deploy genuinely never runs, and the health probe then fails from
the runner even though the app is serving users normally.

The retry ladder therefore turns a 4-minute no-op into a 54-minute no-op.

---

## 3. The structural obstacle

`DEPLOY_SCRIPT` is a **435-line shell script defined as a workflow `env:` value**
(`deploy.yml:107-544`) and piped over SSH with `bash -s`. **The box never holds a
copy.** It exists only inside the workflow run.

Any pull-based scheme must therefore either duplicate those 435 lines on the box —
producing two deploy paths that silently drift, which is worse than the outage this
spec is fixing — or the script must first be extracted into a real file in the repo.

**D1 — extract `DEPLOY_SCRIPT` to a versioned file. ✅ DONE — `scripts/vps_apply.sh`,
byte-identical (sha256 prefix `a779724d089319f6` before and after).** OWNER-GATE to
merge. This pays for itself regardless of which option below is chosen: a 437-line
script embedded in YAML cannot be shellchecked, cannot be run by hand during an
incident, and cannot be diffed meaningfully.

**Trap:** the script's first act is `git fetch && git reset --hard origin/main`
(`deploy.yml:117-118`). If the box runs the script *from the checkout*, the reset
rewrites the file while bash is still reading it — bash reads scripts incrementally
by byte offset, so this executes garbage. The extraction must be two-stage: a small
stable bootstrap that fetches, then `exec`s the fresh script.

---

## 4. Options

### Option A — pull-based deploy timer (RECOMMENDED — **BUILT, see §8**)

A systemd timer on the box fetches a **`release` ref** and, when it differs from
local `HEAD`, applies it. Depends only on outbound git, which is proven working.

**Not `main`.** The deploy job runs only after `lint` and `test` pass; a poller
watching `main` would install commits whose tests failed — trading an outage for a
worse and quieter one. CI publishes `release` once the gates pass, so gating
survives the inversion and the box needs no GitHub credential to check it.
(Earlier drafts of this section said "polls `git ls-remote origin main`". That was
the naive version and it silently dropped CI gating; corrected when built.)

- **For:** no new inbound dependency; no daemon executing remote-authored jobs on
  the production host; short enough for the operator to read in full; survives
  GitHub Actions outages as well as this network fault.
- **Against:** deploys lag by the poll interval; loses the Actions log as the
  audit trail (mitigate: log to journald, which is where every other box-side unit
  already reports); requires D1 first.

### Option B — self-hosted GitHub runner on the box

The runner connects *outbound* to GitHub and long-polls for jobs, so inbound
reachability stops mattering. `deploy.yml` changes `runs-on` and replaces the SSH
invocation with local execution — roughly a one-line change to the deploy step, and
`DEPLOY_SCRIPT` stays as-is (D1 not strictly required).

- **For:** far less bespoke code; keeps the existing workflow, logs, and audit trail.
- **Against:** puts a job executor holding repo credentials on the production host.
  GitHub explicitly warns against self-hosted runners where untrusted code can reach
  them; that is acceptable only while this repo stays private and no forked PR can
  target the runner — a property that must then be *maintained*, not assumed.
- **Also:** the health verification would run *from the box*, so it can no longer
  prove the app is reachable from outside. That is a real loss of signal, and today
  it is unavoidable either way — GitHub cannot reach the box to check.

### Option C — Hostinger support ticket

The drop is in their network. Costs nothing to file in parallel, but nothing here
should wait on it: the same symptom recurred across two days and the workflow's own
comments show it predates this week.

**Recommendation: A, with C filed alongside.** B is the faster path and a defensible
choice if the operator would rather not maintain bespoke deploy code — but it trades
a network problem for a standing security property that has to hold forever.

---

## 5. Acceptance

| # | Done when | Gate |
|---|---|---|
| D1 | `DEPLOY_SCRIPT` lives in a versioned file; `deploy.yml` references it; a deploy runs green through the new path; the two-stage bootstrap is proven by deploying a commit that *modifies the deploy script itself* | OWNER-GATE |
| D2 | Chosen option installed; a push to `main` reaches the box with no human action; `git -C /opt/acb/app rev-parse HEAD` equals `origin/main` within the stated interval | OWNER-GATE |
| D3 | Failure is visible: a deploy that does not land raises something the operator sees, rather than a workflow that goes red where nobody looks | OWNER-GATE |
| D4 | The stranded commits are live: box `HEAD` == `d7d5c79b` or later, and `/health` answers 200. **Today this needs no deploy** — the eight files are documentation plus `scripts/backup_db.sh`, no service reads them at runtime, so a `git fetch && git reset --hard origin/main` in `/opt/acb/app` is sufficient and needs no restart (`agents.json` is clean; only untracked `models/` is present, which a reset leaves alone) | OWNER-GATE |

D3 is not optional. The reason this ran for two days is that the only signal was a
red tick on a page nobody was watching, while the app stayed up and looked fine.

---

## 6. Stopgap — landing the five stranded PRs now

Independent of the options above, and the most urgent item here. The operator's own
machine reaches the box; only GitHub's runners cannot. So the existing deploy can be
driven by hand.

**Preconditions — both already true as of 2026-08-05 09:29:**
- a verified restorable backup exists (`live=228 restored=228`, `Result=success`)
- the nightly backup timer is installed and enabled

```bash
ssh acb@187.127.179.143
cd /opt/acb/app

# What is about to change:
git fetch origin main
git log --oneline HEAD..origin/main
git diff --stat HEAD origin/main -- infra/postgres/   # migrations that will apply
```

Then run the deploy exactly as CI would, so the box takes the same path it always
does rather than a hand-rolled variant:

```bash
gh run view 30975815621 --log | sed -n '/Pulling latest from origin/,/Deployment complete/p'
```

…or, more simply, re-run the workflow's script by copying `DEPLOY_SCRIPT` from
`.github/workflows/deploy.yml` to the box and running it under `bash`.

**This is OWNER-GATE.** It applies migrations forward-only and it ships auth
behaviour changes (#354, #355, #356). Rollback is the 09:29 dump, restored per
`backup_and_restore.md` §3 — which, unusually, has actually been tested.

---

## 7. Verification commands

```bash
# delivery works end to end
git -C /opt/acb/app -c safe.directory=/opt/acb/app rev-parse HEAD
git ls-remote https://github.com/FracktalWorks/CommandCenter main

# the app is serving, from OUTSIDE the box
curl -s -o /dev/null -w '%{http_code}\n' https://api.commandcenter.fracktal.in/health
curl -s -o /dev/null -w '%{http_code}\n' https://commandcenter.fracktal.in

# recent deploy outcomes
gh run list --workflow deploy.yml --limit 10
```

---

## 8. Option A as built

Three parts. The first two are in the repo; the third is an owner install.

### 8.1 `scripts/vps_apply.sh` — D1, the extraction

The 437-line script moved out of `deploy.yml`'s `env:` block into a versioned
file, **byte-identical** (sha256 prefix `a779724d089319f6` before and after — a
move, not a rewrite). `deploy.yml` gained `actions/checkout` and now does
`cp scripts/vps_apply.sh /tmp/deploy_remote.sh`; everything downstream is
unchanged.

This is what makes one script serve both delivery paths. A poller that carried
its own copy would drift from the workflow's, and the drift would only surface
during an incident.

### 8.2 `scripts/vps_pull.sh` — the poller

Three decisions in it are load-bearing:

**It polls `release`, never `main`.** The deploy job runs only after `lint` and
`test` pass; a poller watching `main` would install commits whose tests failed,
trading an outage for a worse and quieter one. So `publish-release` fast-forwards
a `release` ref once the gates pass, and the box applies only that.

**`publish-release` is gated on lint+test and NOT on the deploy job.** This looks
wrong until you remember the failure: when GitHub cannot reach the VPS the deploy
job *fails*. Gating the ref on deploy success would withhold it exactly when the
box's own pull is the only path left. `release` asserts "this commit passed the
gates and is safe to install", not "GitHub managed to install it".

**Two-stage bootstrap.** `vps_apply.sh`'s first act is to synchronise the
checkout, which rewrites files under `$APP_DIR` — including `scripts/`. bash
reads a script incrementally by byte offset, so a script that rewrites itself
mid-run executes garbage from that offset on. The poller therefore reads the
target's copy out of the object database with `git show "$TARGET:…"`, which does
not touch the working tree, and runs it from a temp path nothing is about to
overwrite.

Also: `flock` so a slow apply cannot have the next tick start a second one;
`safe.directory` because the unit runs as root against an `acb`-owned checkout;
and a non-zero exit on failure so `systemctl --failed` shows it.

**`paths-ignore` was removed from `deploy.yml`** in the same change. It skipped
the whole workflow for `**.md` and `ai-company-brain/**` — and a workflow-level
path filter skips the jobs too, so a docs-only merge would never move `release`
and the box would never converge. It also made this outage harder to see: #357
was documentation-only, so **no run was ever queued for it**, and "no failed run"
read as "nothing to do" rather than "never attempted".

### 8.3 The timer — OWNER-GATE to install

```ini
# /etc/systemd/system/acb-pull.service
[Unit]
Description=CommandCenter pull-based delivery (apply origin/release)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
# Run from a COPY. vps_apply.sh synchronises the checkout, which can rewrite
# scripts/vps_pull.sh while bash is still reading this very file.
ExecStart=/bin/bash -c 'install -m 0700 /opt/acb/app/scripts/vps_pull.sh /tmp/acb-pull-run.sh && exec /tmp/acb-pull-run.sh'
TimeoutStartSec=1800
```

```ini
# /etc/systemd/system/acb-pull.timer
[Unit]
Description=Poll for released CommandCenter commits

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=acb-pull.service

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now acb-pull.timer
sudo systemctl start acb-pull.service    # prove it now — see BO-23's lesson
journalctl -u acb-pull -n 40 --no-pager
```

⚠️ **Start it by hand before trusting the timer.** BO-23's timer was installed,
looked correct, and failed on its first real run for a reason no amount of
reading would have found. A timer that has never fired is not a schedule.

### 8.4 What is still unverified

`vps_apply.sh` cannot be proven by the push path while the network fault
persists — but it does not need to be: **the poller is what verifies it.** The
first successful `acb-pull.service` run exercises the identical file the
workflow would have piped.

Until `publish-release` runs once, `origin/release` does not exist and the poller
exits 1 saying so. That is the intended first-run state, not a fault.

---

## 9. Related

- `backup_and_restore.md` — the rollback path this spec's stopgap depends on
- `user_management_contract.md` — what #354/#355/#356 change, and why shipping them
  matters beyond "the board is out of date"
- `colleague_onboarding.md` §2 — blocked at its final step until D4 lands
