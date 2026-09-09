# Changelog

All notable changes to Queueway are recorded here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [0.2.0] — 2026-09-09

RabbitMQ is now production-tested, which makes this the first release where a
job survives the worker that was running it. Everything here was found or
verified by running the code against a real broker, not by inspection.

### Added

- **RabbitMQ broker — tested.** Acknowledgement, redelivery without duplicates,
  automatic reconnection, prefetch, publisher confirms and dead-lettering,
  covered by 24 automated checks (29 against a Docker broker).
- **A job now survives the worker that was running it.** This is the reason to
  choose RabbitMQ over Redis. Redis' `BRPOP` removes a job on delivery, so a
  worker dying mid-handler relies on the store to re-publish it once the
  heartbeat goes stale (~30s). A RabbitMQ delivery stays in the queue until it
  is acknowledged, so the broker hands it to another worker in under a second.
  Queueway's store recovery deliberately stands down for RabbitMQ's in-flight
  jobs — recovering them as well would run the job twice.
- **Automatic reconnection for RabbitMQ.** `amqplib` has none of its own. A
  dropped connection now reconnects with exponential backoff and jitter and —
  the part that is easy to get wrong — **re-binds every subscription**, so the
  worker resumes consuming rather than sitting there reporting healthy.
- **Publisher confirms.** `publish()` now resolves only once RabbitMQ has
  actually accepted the message, instead of when it reached a socket buffer.
- **Dead-lettering.** Queues are declared with `queueway.dlx` as their
  dead-letter exchange, so a rejected message lands in `queueway.dead.<event>`
  instead of being deleted.
- **`queueway init` offers RabbitMQ again**, with both its ports found
  automatically and the management UI recorded in `.env`.
- **`QUEUEWAY_RABBITMQ_PREFETCH`** (default 1) — how many messages one worker
  may hold unacknowledged. Without it, one consumer takes everything and the
  load doesn't spread.
- **`QUEUEWAY_RABBITMQ_MANAGEMENT_URL`**, written by `queueway init`.
- Test script: `rabbitmq-test.js`.

### Fixed

- **RabbitMQ subscriptions could fail silently.** `assertQueue` was called
  without `await` or `.catch()`, so a failure became an unhandled rejection and
  the subscription simply never registered — a broker that reports healthy and
  consumes nothing.
- **A retry backoff held the RabbitMQ delivery open for its whole duration.**
  With prefetch 1 that worker could take nothing else for up to 30 seconds, and
  everything queued behind it waited. The message is now acknowledged first and
  the backoff waited out on a timer.
- **`nack` destroyed the message.** Rejecting with `requeue: false` and no
  dead-letter exchange deletes it outright — reachable if the retry path itself
  failed, such as a store write during an outage.
- **Publishes failed silently.** `channel.publish()` returns a boolean about its
  own write buffer and reports success even when the broker never took the
  message.
- **No prefetch**, so several workers did not share the load at all.
- **Store recovery and broker redelivery could both re-run the same job.**

### Known limitations

- **A wedged-but-alive worker isn't rescued on RabbitMQ.** The broker only
  redelivers when the connection drops. A handler hung on a socket holds its
  message unacknowledged, and the store deliberately will not re-publish it
  either — a stalled job is recoverable, a duplicated one is not. Give network
  handlers their own timeouts; handler timeouts are on the roadmap.
- **RabbitMQ queues created by 0.1.0 and earlier predate dead-lettering** and
  will be refused with a `406`. Let them drain, then
  `rabbitmqctl delete_queue queueway.<event>` once.
- **Classic durable queues only.** Quorum queues suit a real cluster better and
  are on the roadmap, but they change declaration and failure semantics.
- **Tested against RabbitMQ 3.12 and 3.13.** From 4.3 onward the delivery
  acknowledgement timeout applies only to quorum queues, so behaviour on 4.x
  differs and has not yet been verified.
- **Redis has no message acknowledgement** — unchanged from 0.1.0; pair it with
  PostgreSQL, never with the In-Memory store.

---

## [0.1.0] — 2026-08-25

The first release with production-tested PostgreSQL and Redis. Everything here
was found or verified by actually running the code against real services, not
by inspection.

### Added

- **PostgreSQL store — tested.** Schema, retry/DLQ, crash recovery, health and
  connection cleanup, covered by 17 automated checks.
- **Redis broker — tested.** Delivery, multi-worker distribution, durability
  and outage recovery, covered by 17 automated checks.
- **Multi-worker safety.** Workers register in a new `queueway_workers` table
  and heartbeat every 10 seconds. Recovery only reclaims jobs whose owner has
  stopped responding, using `FOR UPDATE SKIP LOCKED` so two workers can never
  be handed the same job.
- **Setup wizard (`queueway init`).** Asks for a broker, then a store. Finds a
  PostgreSQL or Redis you already run, or starts containers for you. When using
  your existing PostgreSQL it creates its own role and database and never
  touches anything else. Ports are chosen automatically, so it won't collide
  with services you already have.
- **Outage resilience.** If the database or broker goes away the process stays
  up, `publish()` rejects so your code can catch it, health reports which
  component is down, and everything reconnects on its own. Jobs stranded
  mid-flight are picked up within 30 seconds without a restart.
- **`QUEUEWAY_*` environment variables.** Every setting Queueway reads or
  writes is now namespaced.
- **Health reports which broker and store are in use**, shown on the dashboard —
  "up" alone doesn't say whether your jobs survive a restart.
- **`engines: node >=18`** declared.
- Test scripts: `regression-test.js`, `postgres-test.js`,
  `postgres-multiworker-test.js`, `redis-test.js`, `resilience-test.js`.

### Fixed

- **Duplicate job execution with multiple workers.** Recovery collected every
  unfinished job regardless of owner, so a restarting worker re-queued jobs
  another worker was still processing — running them twice. Invisible with
  SQLite (one process, one file); guaranteed to appear with a shared store.
- **The process crashed when the database went away.** An unhandled `'error'`
  event from the connection pool ends a Node process. Now handled for
  PostgreSQL, Redis and RabbitMQ.
- **`queueway init` overwrote `DATABASE_URL` and `REDIS_URL`** — repointing the
  host application's own database. All variables are now `QUEUEWAY_*`, and
  writing an unprefixed key is refused outright. The old names are still read
  as a fallback, so existing setups keep working.
- **Deleting a job didn't stop it.** The retry loop slept through the deletion
  and re-published anyway. The job record is now checked before running, after
  the backoff, and before moving to the DLQ.
- **Health could hang or lie.** A stopped Docker container still accepts TCP,
  so a Postgres query waited indefinitely while health reported "up"; a dead
  Redis took 10.6s because ioredis retried 20 times, long enough for the
  dashboard to time out and show everything as down. Each component is now
  checked independently with a short timeout.
- **`stop()` never closed the PostgreSQL pool**, leaking connections for the
  life of the process.
- **Resetting one service deleted another's data** — `docker compose down -v`
  removes every volume in the file.
- **The dashboard white-screened when the store was down**, expecting a list
  and receiving an error object. It now stays up and shows what's wrong.
- **`inquirer@9` is ESM-only** and would have broken `queueway init` on
  Node 18 and 20. Pinned to inquirer 8.
- **`queueway --version` reported a hardcoded version** that had drifted from
  the package.
- **Adding a second service rewrote the compose file**, dropping the first and
  orphaning its container.
- **Docker Desktop wasn't actually launched on Windows** — the wizard waited
  three minutes for nothing. Failures now explain the real cause (memory,
  Hyper-V, WSL2, permissions) and offer a way forward.
- Existing job data is never deleted without being asked, twice, and defaults
  to keeping it. "Keep" reopens the old data using the saved credentials.

### Changed

- `queueway init` no longer offers RabbitMQ or the In-Memory store: RabbitMQ is
  still untested, and an In-Memory store loses everything on restart. Both
  remain available in `queueway.config.js` for anyone who wants them.
- Redis and RabbitMQ automatically use PostgreSQL as the store. Several workers
  must share job records, and SQLite is a local file.

### Known limitations

- **RabbitMQ is implemented but untested**, and `amqplib` does not reconnect on
  its own. Tracked for the next release.
- **Redis has no message acknowledgement.** `BRPOP` removes a job immediately,
  so a worker dying mid-handler relies on the store to bring it back — pair
  Redis with PostgreSQL, never with the In-Memory store.

---

## [0.0.2] — 2026-07-16

- Core engine: `publish()` / `subscribe()`, retry with exponential backoff,
  dead letter queue
- In-Memory broker, In-Memory and SQLite stores
- CLI: `init`, `start`, `status`, `stop`, `health`
- Bundled dashboard with authentication, plus a REST API
- Published to npm
