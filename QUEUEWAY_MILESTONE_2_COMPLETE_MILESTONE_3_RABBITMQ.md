# 🧪 Queueway — Milestone 2 Complete · Milestone 3 Plan

**Last updated:** August 21, 2026
**Applies to:** `queueway@0.0.2` → target release `0.1.0`
**Branch:** `milestone-2/broker-testing`
**A Modestick project.**

> Supersedes `QUEUEWAY_MILESTONE_2_BROKERS_STORES_TESTING.md`.
> Milestone 2 covered PostgreSQL and Redis. RabbitMQ moved to Milestone 3
> because the setup wizard, the duplicate-job fix and the outage work grew
> into real pieces of their own.

---

# ✅ MILESTONE 2 — COMPLETE

## What was actually delivered

| Piece | Status |
|---|---|
| PostgreSQL store | ✅ Tested — 17 automated checks |
| Multi-worker safety | ✅ No duplicates, no orphans lost |
| Redis broker | ✅ Tested — 17 automated checks |
| Setup wizard (`queueway init`) | ✅ Native PostgreSQL/Redis + Docker, both paths |
| Outage resilience | ✅ Survives, reports honestly, self-heals |
| Regression baseline | ✅ 12 checks — In-Memory + SQLite never regressed |
| RabbitMQ | ⬜ Moved to Milestone 3 |

---

## The bug that mattered most: duplicate jobs

`recoverStuckJobs()` collected **every** row in `pending`/`processing`/
`retrying` with no notion of which worker owned it. Two workers, one restarts,
and the restarting worker re-queued the other's in-flight jobs.

Reproduced before the fix:

```
[A] started job 353182ed
→ Worker B boots
[B] started job 353182ed        ← the same job
❌ job 353182ed ran 2× (A, B)
```

**Why it never showed up before:** SQLite is one process and one file. The
problem only exists once the store is shared — which is exactly what Redis and
RabbitMQ are for. A rolling deploy would have been enough to trigger it: two
Qoyod invoices, two emails.

### The fix

- New `queueway_workers` table; each worker registers and heartbeats every 10s.
- Jobs carry `worker_id` + `locked_at`; the heartbeat refreshes the lock, so a
  long job is never mistaken for a dead worker's.
- Recovery asks whether anyone else is alive:
  - **No one** → recover everything (an ordinary single-server restart).
  - **Someone is** → only reclaim jobs whose owner stopped heartbeating.
- Claims use `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, so two
  workers recovering at the same instant can't be handed the same job.
- A clean `stop()` deregisters immediately — no 30-second wait after a normal
  restart.
- `includePending` is broker-aware: the In-Memory broker loses its queue with
  the process, so `pending` really is lost and must be re-published. Redis and
  RabbitMQ still hold it, so re-publishing would deliver it twice.

Both directions are tested — a live worker's job is never stolen, and a dead
worker's job is always reclaimed.

---

## Everything else that was fixed

Each of these was found by running the thing, not by reading it.

### Crashes and hangs

| Problem | Effect | Fix |
|---|---|---|
| No `error` listener on the pg pool | **The whole app crashed** when the database went away — an unhandled `'error'` event ends the Node process | Listener on pool, Redis clients, and the RabbitMQ connection/channel |
| Postgres health check unbounded | Docker's port proxy keeps accepting TCP after a container stops, so a query waited **20s+** and health still said "up" | 2s bounded check; `connectionTimeoutMillis` + `query_timeout` on the pool |
| ioredis retried 20× per command | A dead Redis made health take **10.6s**; the dashboard's own fetch timed out and showed *everything* down | `maxRetriesPerRequest: 3` → 0.3s |
| One slow component blocked the health report | A single failure hid the state of the others | Each component checked independently with its own timeout |
| Redis poll loop spun on failure | Full-speed loop plus a stack trace every few ms for the whole outage | Connection errors → one warning + 2s backoff |
| ioredis logged every reconnect attempt | Hundreds of identical lines per outage | Report once, reset on `ready` |

### Data safety

| Problem | Effect | Fix |
|---|---|---|
| **`.env` variables not namespaced** | `queueway init` **overwrote the app's own `DATABASE_URL` and `REDIS_URL`** — repointing the application's database | All variables now `QUEUEWAY_*`; `upsertEnv` throws on any unprefixed key. Old names still read as a fallback |
| `stop()` never closed the pg pool | Connections leaked for the process's life; managed Postgres plans cap them | `IStore.close()`, called from `stop()` |
| `down -v` on reset | Resetting PostgreSQL **deleted Redis's data too** | Per-service volume removal |
| Deleting a job didn't stop it | The retry loop slept through the deletion and re-published anyway | Job record checked before running, after the backoff, and before the DLQ |
| Reuse check trusted a working URL | A working `DATABASE_URL` was taken as proof our container was up — it might be the machine's own PostgreSQL | Reuse requires our container to actually be running |
| Data deleted on a stale volume | Old jobs thrown away when the password didn't match | Always asks; "Keep" reopens with the saved credentials; delete needs two confirmations and defaults to No |

### Setup and packaging

| Problem | Effect | Fix |
|---|---|---|
| `inquirer@9` is ESM-only | `queueway init` would have died with `ERR_REQUIRE_ESM` on Node 18/20 — the CI matrix | Downgraded to inquirer 8 (same API, CJS) |
| CLI version hardcoded | `queueway --version` said `0.0.1` while the package was `0.0.2` | Read from `package.json` |
| Compose file overwritten | Adding Redis dropped PostgreSQL from the file and orphaned its container | Services merged, not replaced |
| Ports hardcoded | `docker compose up` failed when 5432 was already in use | Free port found automatically; `.env` written to match |
| Docker Desktop launch failed silently | `start "" "Docker Desktop"` looks for a *file* — the wizard then waited 3 minutes for nothing | Launch the executable directly, detached |
| `docker info` answers too early | Compose then failed with a 500 from the image store | Readiness also probes `docker image ls` |
| Docker failure was silent | The wizard downgraded the user's choices without asking | Explains the real cause (memory, Hyper-V, WSL2, permissions) and asks what to do |
| Dashboard white-screened on 503 | `jobs.map is not a function` — an error object where a list was expected | Status checked; health still renders; amber banner explains |
| No engine declared | Nothing stated the supported Node version | `"engines": { "node": ">=18" }` |
| Health didn't say which broker/store | "Up" alone doesn't reveal whether jobs survive a restart | `type` on each component; shown as a badge on the dashboard |

---

## The test suite

Four scripts, all runnable any time. They are the reason the above were found.

| Script | Checks | What it proves |
|---|---|---|
| `scripts/regression-test.js` | 12 | In-Memory + SQLite still work end to end. **Run after every change.** ~60s |
| `scripts/postgres-test.js` | 17 | Schema, retry/DLQ, crash recovery, health, pool cleanup |
| `scripts/postgres-multiworker-test.js` | — | No duplicates, and no orphans lost |
| `scripts/redis-test.js` | 17 | Delivery, multi-worker distribution, durability, outage recovery |
| `scripts/resilience-test.js` | 6 | Surviving and recovering from a real container outage |

```bash
node scripts/regression-test.js
node scripts/postgres-test.js
node scripts/postgres-multiworker-test.js
node scripts/redis-test.js
```

**The regression baseline earned its keep.** When the recovery watcher was
added, it caught a 6th retry attempt — the watcher was re-queuing jobs during
their backoff, quietly recreating the duplicate bug from another direction.

---

## Verified before release

- Clean `npm install` + build from a fresh checkout
- All four suites pass, plus `lerna run test` (8 Jest tests)
- `npm pack` → installed into an empty project → CLI, library, types,
  dashboard, static assets and auth all work from the real artifact
- An existing app's `.env` is left untouched; the guard rejects unprefixed keys
- No shell invocations (`execFile`/`spawn` with argument arrays), all paths via
  `path.resolve`, platform branches for Windows/macOS/Linux
- No ESM-only dependencies; `engines: node >=18` matches the CI matrix

---

## Before pushing

- [ ] `.env` is gitignored — confirm it isn't staged
- [ ] `docker-compose.queueway.yml` is now gitignored (it holds a generated password)
- [ ] Remove the temporary `test.event` / `test.will.fail` handlers from `aadaad-backend`
- [ ] Rotate the Gmail App Password if it was ever shown in a screenshot

```bash
git add -A
git commit -m "Milestone 2: PostgreSQL + Redis tested, multi-worker safety, setup wizard, outage resilience"
git push origin milestone-2/broker-testing
```

Hold `main` until RabbitMQ is done — `0.1.0` should ship all three together.

---
---

# ⬜ MILESTONE 3 — RabbitMQ

**Goal:** bring RabbitMQ to the same standard as PostgreSQL and Redis, then
release `0.1.0`.

## Why RabbitMQ at all, given Redis works

Redis has **no message acknowledgement**. `BRPOP` removes a job the instant a
worker takes it; if that worker dies mid-handler the job is gone from Redis,
and only the store's record brings it back — which means recovery, and a wait
for the heartbeat to go stale.

RabbitMQ has **real acknowledgement**. An unacked message returns to the queue
by itself, immediately, with no store involvement. For work where a lost job is
expensive, that's the difference worth paying the extra complexity for.

---

## Risks already identified in the code

These were found reading `RabbitMQBroker.ts` and have **not** been addressed.
Know them before testing, or the results won't make sense.

### 🔴 Risk 1 — No automatic reconnection

`amqplib` does not reconnect. When the connection drops, the app now survives
(the `'error'`/`'close'` listeners added in Milestone 2 prevent the crash), but
**it stops consuming and never resumes**.

Redis got this for free from ioredis. RabbitMQ needs a reconnect loop written
by hand: reconnect with backoff, recreate the channel, re-assert the exchange,
and re-bind every subscription.

**This is the largest piece of work in the milestone.**

### 🔴 Risk 2 — The retry backoff sleeps inside the consumer callback

```ts
await new Promise((resolve) => setTimeout(resolve, delay));  // up to 30s
```

With RabbitMQ this holds the message **unacked for the entire backoff**. Two
consequences to test:

- Does the consumer timeout fire? (default 30 minutes in recent versions)
- Do other messages stall behind it?

If they do, the fix is to ack immediately and schedule the retry as a delayed
re-publish rather than sleeping mid-delivery.

### 🟠 Risk 3 — `nack` discards the message

```ts
this.channel!.nack(msg, false, false);   // requeue=false, and no dead-letter exchange
```

Normally unreachable, since Queueway handles retries itself. But if the retry
path itself fails — a store write failing mid-outage — the message is silently
destroyed.

**Test:** stop PostgreSQL, process a job, see whether it disappears.

### 🟠 Risk 4 — No prefetch

Without `channel.prefetch(n)`, one consumer can take every available message.
With several workers the load may not spread at all — the opposite of the point.

Redis distributed evenly (`A:20 B:20 C:20`) because `BRPOP` is naturally fair.
RabbitMQ will not be, unless prefetch is set.

### 🟡 Risk 5 — Floating promise in `bindQueue`

```ts
this.channel!.assertQueue(queueName, { durable: true }).then(() => { ... });
```

No `await`, no `.catch()`. A failure here becomes an unhandled rejection and
the subscription silently never registers.

### 🟡 Risk 6 — `recoverStuckJobs` may double up

RabbitMQ returns an unacked message to the queue by itself. If the store's
recovery **also** re-publishes it, the job runs twice.

`retainsPendingJobs = true` already stops `pending` jobs being re-published.
What still needs checking is `processing`: RabbitMQ may redeliver at the same
moment the 30-second stale timeout reclaims it. If so, RabbitMQ needs a longer
stale window — or to opt out of store-based recovery entirely, since the broker
already guarantees redelivery.

**This is the subtlest risk in the milestone.** Test it deliberately.

---

## Plan

### Part 0 — Baseline
- [ ] `node scripts/regression-test.js` → save as `baseline-before-m3.txt`
- [ ] All four suites pass before any RabbitMQ change
- [ ] Branch: `milestone-3/rabbitmq`

### Part 1 — Fix the known risks first
Unlike Redis, testing before fixing wastes time here — Risks 1, 4 and 5 will
distort every result.

- [ ] `channel.prefetch(n)` (Risk 4)
- [ ] `await` + `.catch()` on `bindQueue` (Risk 5)
- [ ] Reconnect loop with backoff, re-asserting exchange and re-binding
      subscriptions (Risk 1)

### Part 2 — `scripts/rabbitmq-test.js`
Mirroring the Redis suite so the two are comparable:

- [ ] Smoke: exchange `queueway` (topic, durable), queue `queueway.<event>`
      (durable), publish → consume → ack, message count returns to 0
- [ ] Subscribe-before-connect: `pendingSubscriptions` replay, both orders
- [ ] Multi-worker: 60 jobs across 3 workers, even spread, no duplicates
- [ ] **Durability:** `kill -9` mid-handler → RabbitMQ redelivers by itself —
      and confirm the store does **not** also re-publish it (Risk 6)
- [ ] Retry + DLQ, watching whether the message stays unacked (Risk 2)
- [ ] Store outage mid-job: does `nack` destroy it? (Risk 3)
- [ ] Broker outage: container stopped and started, reconnect without a restart
- [ ] Health reports `type: 'rabbitmq'`

### Part 3 — Wizard
- [ ] RabbitMQ back into `BROKER_CHOICES` (removed while untested)
- [ ] Management UI port handled like the AMQP port — free port, `.env` written
- [ ] Verify the keep/fresh flow for its volume (credentials live inside it,
      as with PostgreSQL)

### Part 4 — Docs
- [ ] README: RabbitMQ `🧪` → `✅`, roadmap ticked
- [ ] Document the ack difference: **Redis loses a job to the store on crash,
      RabbitMQ returns it to the queue** — this is the whole reason to choose it
- [ ] Website docs page + `i18n.ts` `note_untested`, all three languages

### Part 5 — Release `0.1.0`
- [ ] All five suites pass
- [ ] `npm pack` → install into an empty project → verify
- [ ] Test in `aadaad-backend` **on SQLite first**, config unchanged
- [ ] Version → `0.1.0`, CHANGELOG, publish, GitHub release + tag
- [ ] Email the newsletter subscribers

---

## Ground rules that earned their place

- **Run it, don't reason about it.** Every bug above came from executing the
  code. None came from reading it.
- **Regression test after every change.** 60 seconds; it caught the watcher
  re-queuing jobs mid-backoff.
- **Duplicates are worse than crashes.** A crash is visible. Two invoices are not.
- **Never touch what belongs to the user.** Their `.env`, their databases, their
  containers, their data. Ask, don't assume — and default to keeping.
- **Untested stays marked untested**, everywhere, until it genuinely isn't.
- **In-Memory + SQLite are sacred** — that pairing runs in production today.

---

*A Modestick project.*
