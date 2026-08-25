# Changelog

All notable changes to Queueway are recorded here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-08-21

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
