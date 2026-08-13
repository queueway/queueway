<p align="center">
  <img src="https://raw.githubusercontent.com/queueway/queueway/main/packages/dashboard/public/logo.svg" alt="Queueway" width="120" />
</p>

<h1 align="center">Queueway</h1>

<p align="center">
  A zero-config, TypeScript-first job queue for Node.js — pick a broker, pick a store, publish/subscribe to events, and get retries, crash-recovery, a secured dashboard, and a REST API out of the box.
</p>

<p align="center">
  <em>A <a href="#modestick">Modestick</a> project.</em>
</p>

---

> **Status:** Early access (v0.0.2). CORE engine (In-Memory + SQLite) is fully dev+prod tested. Redis, RabbitMQ, and PostgreSQL are implemented but not yet production-tested — see [Roadmap](#roadmap).

## ✨ Features

- **Zero-config by default** — `npm install queueway && npx queueway init && npx queueway start` and you have a working queue, dashboard, and API
- **Pluggable brokers** — In-Memory (tested), Redis & RabbitMQ (implemented, not yet production-tested)
- **Pluggable stores** — In-Memory (tested), SQLite (tested), PostgreSQL (tested)
- **Automatic setup** — `queueway init` finds the PostgreSQL/Redis you already run, or starts containers for you; it never touches your existing databases
- **Survives outages** — if the database or broker goes away, the process stays up, health reports which part is down, and everything reconnects on its own
- **Safe with multiple workers** — workers heartbeat, so a restart never re-runs a job another worker is still processing
- **Automatic retry** with exponential backoff — jobs are genuinely redelivered, not just delayed
- **Dead Letter Queue (DLQ)** for jobs that exceed max retries, with one-click retry from the dashboard
- **Crash-recovery** — if the process dies mid-job (SQLite/Postgres), the job resumes on the next start instead of vanishing
- **Auto-heal** — `queueway start` runs your server under a watchdog that automatically restarts it if it crashes (dev or prod, same command)
- **Background mode** — run detached from your terminal with one prompt, check on it anytime with `queueway status`
- **Secured dashboard** — real signup/login (bcrypt-hashed passwords, session cookies), not an open door
- **Real health checks** — the dashboard's health panel actually pings your broker/database; it doesn't just say "healthy" no matter what
- **Dark/light mode** — via `next-themes`, matching system preference by default
- **Structured logging** — leveled, JSON, written to a real log file — crash-proof by design (a logging failure never takes your app down)
- **Full TypeScript support**

---

## 🚀 Quick Start

**For production**, run the setup wizard first — this is required, not optional (skipping it means you're stuck with In-Memory defaults, and no data survives a restart):

```bash
npm install queueway
npx queueway init      # pick a store (SQLite recommended) and broker (In-Memory)
npx queueway start     # boots the queue engine + REST API + dashboard, all on one port
```

Open **http://localhost:4287** — you'll be asked to create a one-time dashboard account (email + password), then land on the live dashboard.

**For dev / quick testing**, you can skip `init` entirely and just start using it — zero setup:

```javascript
const { queue } = require('queueway'); // defaults to In-Memory broker + store
```

### Use it as a library in your own app

```javascript
const { queue } = require('queueway'); // auto-configured from queueway.config.js, if present

queue.subscribe('email.welcome', async (job) => {
  console.log('Sending email to:', job.data.to);
});

async function main() {
  await queue.start();
  await queue.publish('email.welcome', { to: 'user@example.com' });
}

main();
```

`queue.subscribe(eventName, handler)` registers what should happen when a job of that type runs. `queue.publish(eventName, data)` enqueues one. Both calls need to be in the **same running process** while using the In-Memory broker — see [Brokers & Stores](#-brokers--stores) for why, and what changes once Redis/RabbitMQ are production-ready.

Want the dashboard + REST API running alongside your own app too, without the CLI? Pass `{ withServer: true }`:

```javascript
await queue.start({ withServer: true, port: 4287 });
```

This does everything `npx queueway start` does — including auto-loading `queueway.jobs.js` and printing reachable URLs (localhost, LAN, and public IP if detected) — **except** background mode and auto-heal, which need a separate supervisor process watching this one (see the table below).

### Which command should I use?

| | `queue.start()` (embedded in your app) | `npx queueway start` (standalone CLI) |
|---|---|---|
| Runs inside your app's own process | ✅ — direct access to your app's own variables/functions from job handlers | ❌ — runs as a separate process, isolated |
| HTTP API + dashboard | Only with `{ withServer: true }` | ✅ always |
| Auto-heal (restarts itself if it crashes) | ❌ — use PM2/systemd/Docker around your *whole* app instead | ✅ built in |
| Background mode | ❌ | ✅ |
| Best for | Adding a queue to an app you already have (Express, etc.) where job handlers need tight access to your app's own state | Running the queue as its own standalone service, with zero extra code |

**Rule of thumb:** if you're bolting a queue onto an *existing* app, use `queue.start()` (add `{ withServer: true }` if you also want the dashboard). If you want the queue to just run and manage itself with no app code of your own, use `npx queueway start`.

> ⚠️ **Don't run both for the same project at the same time.** If your own script already calls `queue.start({ withServer: true })` on port 4287 (or already has the SQLite files open), and you *also* run `npx queueway start` in the same folder, they'll either collide on the port (`EADDRINUSE`) or contend over the same SQLite files. Pick one way to run your app, not both.

---

## 📊 Dashboard

Running `queueway start` automatically serves a full dashboard (Next.js, statically exported — no separate server or port) at whatever port your API runs on:

- **Live job stats** — pending / processing / completed / failed, auto-refreshing every 3s
- **Real health panel** — broker + database status, with live latency, not a hardcoded "healthy"
- **Filterable job list** — by status, with full payload data visible
- **One-click retry** for failed jobs, right from the table
- **Dark/light mode toggle**

### Dashboard security

The dashboard requires a real login — bcrypt-hashed password, HttpOnly session cookie. The first person to visit creates the one admin account (`queueway` is designed as a single-admin dashboard, not a multi-tenant one); after that, everyone else sees a login screen. Every `/queueway/*` API route is protected the same way — there's no unauthenticated backdoor.

**Email delivery (optional):** to send the welcome email + password-reset links, set these environment variables (a `.env` file in your project root is loaded automatically):

```ini
QUEUEWAY_SMTP_HOST=smtp.gmail.com
QUEUEWAY_SMTP_PORT=465
QUEUEWAY_SMTP_USER=you@example.com
QUEUEWAY_SMTP_PASS=your-app-password
QUEUEWAY_ADMIN_EMAIL=you@example.com   # optional — CC'd on every signup notification
```

If these aren't set, signup/login still work fully — you just won't get the welcome/reset emails, and a warning is logged.

---

## 🧱 Brokers & Stores

| Broker | Status | Notes |
|---|---|---|
| In-Memory | ✅ Production-tested | Zero-config default. Single-process only — see note below |
| Redis | 🧪 Implemented, untested | Lists-based (`LPUSH`/`BRPOP`) |
| RabbitMQ | 🧪 Implemented, untested | Topic exchange, durable queues |

| Store | Status | Notes |
|---|---|---|
| In-Memory | ✅ Production-tested | Testing/dev only — data lost on restart |
| SQLite | ✅ Production-tested | File-based, crash-recovery, zero external services |
| PostgreSQL | ✅ Tested | Shared by several workers; required for multi-worker setups |

Configure via `queueway.config.js` (created by `queueway init`) or directly:

```javascript
new Queueway({ broker: 'redis', store: 'postgres' });
```

Connection details come from environment variables: `RABBITMQ_URL`, `REDIS_URL`, `DATABASE_URL`, `SQLITE_PATH`.

### Why brokers/stores matter for scaling

A **process** is one running instance of your program, with its own private
memory. With the In-Memory broker, `publish()` and `subscribe()` only work
within the *same process* — two separate servers can't talk to each other
through it. Redis and RabbitMQ exist to solve exactly this: they run as their
own service, so any number of processes can publish and subscribe through them.

Several workers also need a store they can all reach. SQLite is a local file,
so two machines can't share it — which is why choosing Redis or RabbitMQ in
`queueway init` gives you PostgreSQL as the store, with no question asked.

---

## ⚙️ Setup wizard

`queueway init` asks for a **broker** first, then a **store**, because the
broker determines which stores are honest options.

For PostgreSQL or Redis, it offers only what's actually possible on your
machine:

1. **Use what's already running** — shown only when something is listening on
   the default port.
2. **Run a container for this project** — Docker.
3. **Cancel.**

Nothing dead-ends. If a path fails you're asked what to do next, and SQLite is
always there as a working fallback — it needs nothing installed and is
production-tested.

### Using a PostgreSQL you already have

Queueway does **not** touch your existing databases. It creates its own, the
same way the SQLite store creates its own file:

```sql
CREATE ROLE queueway_<project> LOGIN PASSWORD '<generated>';
CREATE DATABASE queueway_<project> OWNER queueway_<project>;
```

The role is not a superuser and has neither `CREATEDB` nor `CREATEROLE`.
Nothing is ever dropped or altered — only created. The name comes from your
`package.json`, so two projects on one machine never share a jobs table.

Creating a role needs administrator rights, so the wizard first tries to
connect as an administrator on its own (this works on Homebrew and some Linux
setups). On Windows you'll be asked for the password once — it's used at that
moment and never written anywhere.

Re-running `init` is safe: an existing role has its password rotated, an
existing database is reused, and your jobs stay where they are.

### Using Docker

The wizard writes `docker-compose.queueway.yml`, pulls the image, starts the
container and waits until it genuinely accepts connections.

**Ports are never hardcoded.** If 5432 is taken — common, since you may already
run PostgreSQL — Queueway's container takes 5433 and `.env` is written to
match. Your own services are left alone. The compose file is merged rather than
overwritten, so adding Redis later keeps PostgreSQL in it.

```bash
docker compose -f docker-compose.queueway.yml ps      # status
docker compose -f docker-compose.queueway.yml down    # stop, keep data
docker compose -f docker-compose.queueway.yml down -v # stop, delete ALL data
```

---

## 💾 Your job data

When you re-run `init` and Queueway finds data from an earlier setup, it always
asks. **Nothing is deleted without you choosing it, twice.**

```
? There's job data here from an earlier setup. What should happen to it?
❯ Keep it — reconnect to the existing jobs
  Start fresh — delete it and create an empty database
  Cancel
```

**Keep it** restarts the container with the credentials in `.env` and
reconnects to your jobs. If the password in `.env` doesn't match that data,
Queueway says so and stops, leaving the data untouched.

That last case is a PostgreSQL rule, not a Queueway limitation:
`POSTGRES_PASSWORD` is only applied to an empty data directory, after which the
password lives inside the data. Without the original, that data can't be opened
by anyone. If you still have the old `DATABASE_URL`, put it back in `.env` and
run `init` again — it comes straight back.

> **`DATABASE_URL` in `.env` is the key to your job data.** Back it up like a
> password. Lose it and the data in that volume can't be recovered.

**Start fresh** asks for confirmation, then removes only that service's volume
— resetting PostgreSQL leaves Redis data alone.

---

## 🔌 When a database or broker goes down

Containers restart themselves (`restart: unless-stopped`). Queueway's job is to
survive the outage and reconnect:

- **The process stays alive.** A dropped connection is a logged warning, not a
  crash.
- **Errors reach your code, not the process.** `publish()` rejects so you can
  catch and retry.
- **Health is honest and fast.** Each component is checked independently with a
  short timeout, so one failure never hides the others — and the dashboard
  keeps working, showing exactly which part is down.
- **It reconnects on its own.** No restart needed. Jobs stranded mid-flight are
  picked up automatically within 30 seconds.

```bash
node scripts/resilience-test.js   # stops and restarts your container for real
```

---

## 👥 Running several workers

Several workers sharing one PostgreSQL is the point of the Redis and RabbitMQ
brokers. Recovery has to be careful there: a job marked `processing` might
belong to a worker that's alive and busy, and re-queuing it would run it twice
— two invoices, two emails.

Each worker registers in `queueway_workers` and heartbeats every 10 seconds:

- A job held by a **live** worker is never touched.
- A job whose owner **stopped heartbeating** (30s) is reclaimed.
- Claims use `FOR UPDATE SKIP LOCKED`, so two workers recovering at the same
  instant can't be handed the same job.
- A clean shutdown deregisters immediately — no 30-second wait after a normal
  restart.

---

## 🖥️ CLI Reference

| Command | What it does |
|---|---|
| `queueway init` | Interactive wizard — writes `queueway.config.js` and a starter `queueway.jobs.js` |
| `queueway start` | Boots the server (config + jobs auto-loaded). Asks foreground vs background; `-b`/`-f` to skip the prompt, `-p <port>` to set the port (default `4287`) |
| `queueway status` | Checks whether the server is up — works for dev/prod, foreground/background |
| `queueway stop` | Stops a server started in the background |
| `queueway health` | Prints broker/database health + job stats from a running instance |

`queueway.jobs.js` is where you define what happens for each job type:

```javascript
// queueway.jobs.js — auto-loaded by `queueway start` (and by `queue.start()` too)
module.exports = function registerJobs(queue) {
  queue.subscribe('email.welcome', async (job) => {
    console.log('Sending:', job.data);
  });
};
```

You're not boxed into that one file — it's just an entry point, so `require()` as many other files from it as you want. Or skip it entirely and use a **`jobs/` directory** instead: every `.js` file inside is auto-loaded, no manual wiring needed, so you can organize handlers across as many files as you like (`jobs/email.js`, `jobs/payments.js`, ...) — the same freedom you'd have embedding Queueway directly in your own app.

---

## 🧩 Library API — do everything the dashboard does, in code

Every action the dashboard/REST API can do is also a plain method on `queue` — no dashboard, no HTTP calls needed, if you'd rather manage jobs directly from your own code:

```javascript
const { queue } = require('queueway');

await queue.publish(eventName, data);           // enqueue a job
queue.subscribe(eventName, async (job) => {});  // register a handler

await queue.getStats();                         // { jobs: { pending, processing, completed, failed, retrying, archived }, total }
await queue.getJob(jobId);                       // single job, or null
await queue.getJobs(status?, limit?);            // list jobs, optionally filtered by status
await queue.getDLQ(limit?);                      // failed jobs currently in the dead-letter queue
await queue.retryJob(jobId);                     // re-queue a job (resets attempts to 0)
await queue.deleteJob(jobId);                    // permanently delete a job record
await queue.getHealth();                         // real broker/database health check
```

These are the exact same methods the dashboard and `/queueway/*` REST routes call internally — so anything you can click in the dashboard, you can also do directly in your own scripts, cron jobs, or admin tooling.

---

## 📡 REST API

All routes below require a logged-in session (see [Dashboard security](#dashboard-security)).

| Method | Route | Description |
|---|---|---|
| GET | `/queueway/health` | Broker + database + API status (200 if healthy, 503 if not) |
| GET | `/queueway/stats` | Job counts by status |
| GET | `/queueway/jobs?status=&limit=` | List jobs, optionally filtered |
| GET | `/queueway/jobs/:id` | Get one job |
| GET | `/queueway/dlq?limit=` | List failed (dead-lettered) jobs |
| POST | `/queueway/jobs/:id/retry` | Re-queue a job (resets attempts to 0) |
| DELETE | `/queueway/jobs/:id` | Permanently delete a job record |

Auth routes (always public, obviously): `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/status`, `POST /auth/forgot-password`, `POST /auth/reset-password`.

---

## 📦 Monorepo Structure

```
packages/
  core/         -> the "queueway" npm package: engine, brokers, stores, auth, REST API, CLI, dashboard assets
    src/cli/    -> CLI commands (init, start, status, stop, health)
    src/auth/   -> signup/login/session/email
    src/logging -> crash-proof structured logger
  dashboard/    -> Next.js dashboard source (statically exported and bundled into core/public at build time)
examples/
  basic-server.ts -> minimal library-usage example
```

There is only **one** npm package to install (`queueway`) — the CLI, library, and dashboard assets all ship together.

---

## 🧹 Uninstalling

`npm uninstall queueway` removes the package itself, but **not** the files it created while running — this is deliberate, since those files may contain real data (dashboard accounts, job history) you might not want silently deleted just because you removed a dependency:

- `.queueway/` — dashboard login (`auth.db`), job data if using SQLite (`queueway.db`), and logs
- `queueway.config.js` / `queueway.jobs.js` — your config and job handlers (created by `queueway init`)
- `docker-compose.queueway.yml` and its containers/volumes, if you used the Docker option
- `DATABASE_URL` / `REDIS_URL` in `.env`

If you're removing Queueway for good and want a clean slate, delete these yourself:

```bash
docker compose -f docker-compose.queueway.yml down -v   # only if you used Docker
npm uninstall queueway
rm -rf .queueway queueway.config.js queueway.jobs.js docker-compose.queueway.yml
```

A PostgreSQL role and database created inside your own PostgreSQL are left in
place — Queueway never drops anything. Remove them yourself if you want to:

```sql
DROP DATABASE queueway_<project>;
DROP ROLE queueway_<project>;
```

---

## 🗺️ Roadmap

- [x] CORE queue engine — In-Memory + SQLite, retry, DLQ, crash-recovery
- [x] REST API, dashboard, CLI (init/start/status/stop/health)
- [x] Dashboard authentication (signup/login/reset), structured logging
- [x] PostgreSQL dev+prod testing pass — worker-aware recovery, outage resilience, automatic setup
- [ ] Redis dev+prod testing pass
- [ ] RabbitMQ dev+prod testing pass
- [ ] Community (Discord, contributor program)
- [ ] PRO plugins (AI error analyzer, circuit breaker, SSO, compliance reports)
- [ ] Cloud SaaS

## Modestick

Queueway is built and maintained by **[Modestick](https://www.instagram.com/modestick.official)** — a creative and technology studio building AI agents & automation, custom software, mobile apps, IoT solutions, cloud infrastructure, and brand/design work for clients who care about quality.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

MIT — see [LICENSE](./LICENSE)
