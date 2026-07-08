# 🚀 Queueway

A zero-config, TypeScript-first job queue for Node.js — pick a broker, pick a store, publish/subscribe to events, and get retries, a dead-letter queue, a REST API, and a live dashboard out of the box.

> **Status:** Early development (CORE engine complete). Not yet published to npm — clone the repo to try it out.

---

## ✨ Features

- **Zero-config by default** — `new Queueway()` works out of the box with in-memory broker + store
- **Pluggable brokers** — RabbitMQ, Redis, In-Memory (Kafka/SQS planned)
- **Pluggable stores** — PostgreSQL, SQLite, In-Memory (MongoDB/MySQL planned)
- **Automatic retry** with exponential backoff
- **Dead Letter Queue (DLQ)** for jobs that exceed max retries
- **REST API** — health, stats, job listing/inspection, DLQ, manual retry
- **Live dashboard** — Next.js + shadcn-style UI, auto-refreshes every 3s
- **CLI** — `queueway init` (setup wizard), `queueway health` (check a running instance)
- **Full TypeScript support**

---

## 🚀 Quick Start

Clone the repo and install dependencies:

```bash
git clone https://github.com/queue-kit/queueway.git
cd queueway
npm install
npm run build
```

### Publish and subscribe to jobs

```typescript
import { Queueway } from 'queueway';

const queue = new Queueway({ broker: 'in-memory', store: 'in-memory' });

queue.subscribe('email.send', async (job) => {
  console.log('Sending email:', job.data);
});

await queue.start();
await queue.publish('email.send', { to: 'user@example.com', subject: 'Welcome!' });
```

### Add the REST API + dashboard

```typescript
import { Queueway, startServer } from 'queueway';

const queue = new Queueway({ broker: 'in-memory', store: 'in-memory' });
await queue.start();
startServer(queue, 3000); // http://localhost:3000/queueway/health, /stats, /jobs, /dlq
```

Then run the dashboard (separate terminal):

```bash
cd packages/dashboard
npm run dev
```

Open **http://localhost:3001** to see live job stats, a jobs table, and health status.

### Check health from the CLI

```bash
node packages/cli/dist/index.js health
```

---

## 🧱 Brokers & Stores

| Broker | Status | Notes |
|---|---|---|
| In-Memory | ✅ | Zero-config default, testing |
| RabbitMQ | ✅ | Production-recommended |
| Redis | ✅ | Lightweight alternative (Lists-based) |
| Kafka / AWS SQS | ⏭️ Planned | |

| Store | Status | Notes |
|---|---|---|
| In-Memory | ✅ | Zero-config default, testing |
| PostgreSQL | ✅ | Production-recommended |
| SQLite | ✅ | File-based, no external DB needed |
| MongoDB / MySQL | ⏭️ Planned | |

Configure via the constructor:

```typescript
new Queueway({ broker: 'redis', store: 'postgres' });
```

Connection details are read from environment variables (`RABBITMQ_URL`, `REDIS_URL`, `DATABASE_URL`, `SQLITE_PATH`).

---

## 📦 Monorepo Structure

```
packages/
  core/       -> Queueway engine: brokers, stores, retry/DLQ, REST API (npm package: "queueway")
  cli/        -> CLI tool (init, health)
  dashboard/  -> Next.js dashboard (App Router + shadcn-style UI)
  plugins/    -> PRO plugins (private, not yet started)
examples/
  basic-server.ts -> minimal working example
```

---

## 🗺️ Roadmap

- [x] CORE queue engine, brokers, stores, retry/DLQ
- [x] REST API + dashboard + CLI
- [ ] npm publish
- [ ] Community (Discord, contributor program)
- [ ] PRO plugins (AI error analyzer, circuit breaker, SSO, etc.)
- [ ] Cloud SaaS

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

MIT — see [LICENSE](./LICENSE)
