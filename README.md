<p align="center">
  <img src="packages/dashboard/public/logo.svg" alt="Queueway" width="120" />
</p>

<h1 align="center">Queueway</h1>

<p align="center">
  A zero-config, TypeScript-first job queue for Node.js — pick a broker, pick a store, publish/subscribe to events, and get retries, crash-recovery, a secured dashboard, and a REST API out of the box.
</p>

<p align="center">
  <em>A <a href="#modestick">Modestick</a> project.</em>
</p>

---

> **Status:** Early access (v0.1.0). CORE engine (In-Memory + SQLite) is fully dev+prod tested. Redis, RabbitMQ, and PostgreSQL are implemented but not yet production-tested — see [Roadmap](#roadmap).

## ✨ Features

- **Zero-config by default** — `npm install queueway && npx queueway init && npx queueway start` and you have a working queue, dashboard, and API
- **Pluggable brokers** — In-Memory (tested), RabbitMQ & Redis (implemented, not yet production-tested)
- **Pluggable stores** — In-Memory (tested), SQLite (tested), PostgreSQL (implemented, not yet production-tested)
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

```bash
npm install queueway
npx queueway init      # pick a store (SQLite recommended) and broker (In-Memory)
npx queueway start     # boots the queue engine + REST API + dashboard, all on one port
```

Open **http://localhost:4287** — you'll be asked to create a one-time dashboard account (email + password), then land on the live dashboard.

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
| PostgreSQL | 🧪 Implemented, untested | For when you outgrow SQLite |

Configure via `queueway.config.js` (created by `queueway init`) or directly:

```javascript
new Queueway({ broker: 'redis', store: 'postgres' });
```

Connection details come from environment variables: `RABBITMQ_URL`, `REDIS_URL`, `DATABASE_URL`, `SQLITE_PATH`.

### Why brokers/stores matter for scaling

A **process** is one running instance of your program, with its own private memory. With the In-Memory broker, `publish()` and `subscribe()` only work within the *same process* — two separate servers (or two terminals running the same app) can't talk to each other through it. Redis/RabbitMQ exist precisely to solve this: they run as their own independent service, so any number of separate processes/servers can publish and subscribe through them. Until Redis/RabbitMQ finish their own dev+prod testing pass, Queueway is best suited to single-process deployments — which, for most small-to-medium workloads, is enough.

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
// queueway.jobs.js — auto-loaded by `queueway start`
module.exports = function registerJobs(queue) {
  queue.subscribe('email.welcome', async (job) => {
    console.log('Sending:', job.data);
  });
};
```

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

## 🗺️ Roadmap

- [x] CORE queue engine — In-Memory + SQLite, retry, DLQ, crash-recovery
- [x] REST API, dashboard, CLI (init/start/status/stop/health)
- [x] Dashboard authentication (signup/login/reset), structured logging
- [ ] Redis dev+prod testing pass
- [ ] RabbitMQ dev+prod testing pass
- [ ] PostgreSQL dev+prod testing pass
- [ ] npm publish
- [ ] Community (Discord, contributor program)
- [ ] PRO plugins (AI error analyzer, circuit breaker, SSO, compliance reports)
- [ ] Cloud SaaS

## Modestick

Queueway is built and maintained by **[Modestick](https://www.instagram.com/modestick.official)** — a creative and technology studio building AI agents & automation, custom software, mobile apps, IoT solutions, cloud infrastructure, and brand/design work for clients who care about quality.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

MIT — see [LICENSE](./LICENSE)
