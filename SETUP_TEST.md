# Queueway — Milestone 2 test run

## 1. Install and build

```powershell
cd E:\queueway
npm install
npm run build
```

`npm install` is required — the CLI's prompt library changed (inquirer 9 was
ESM-only and crashed on Node 18/20; it's now inquirer 8).

---

## 2. Test the Docker path  ← the only untested piece left

Run the wizard in a **separate empty folder**, never inside `E:\queueway` —
it writes `.env`, `queueway.config.js` and `queueway.jobs.js` into whatever
folder it runs in.

```powershell
mkdir E:\wizard-docker
cd E:\wizard-docker
npm init -y
npm install E:\queueway\packages\core
npx queueway init
```

Answer:

| Prompt | Answer |
|---|---|
| Choose a broker | **In-Memory** |
| Choose a store | **PostgreSQL** |
| Docker is installed but not running. Start it? | **Yes** |
| How should Queueway get a PostgreSQL? | **Run a PostgreSQL container just for this project** |

No admin password is asked on this path — the container is ours, so Queueway
sets its own credentials.

What to watch for:

1. `⏳ Waiting for Docker to start…` should now appear and Docker Desktop
   should actually open. (Previously this failed silently.)
2. `ℹ️  Port 5432 is already in use, so Queueway's Postgres will use 5433
   instead.` — your own PostgreSQL must not be disturbed.
3. `⏳ Waiting for Postgres to accept connections… ready.`

Then confirm:

```powershell
docker ps
npx queueway start
```

A container named `queueway-wizard-docker-postgres` should be running, and the
dashboard should load at http://localhost:4287.

---

## 3. Cleanup

```powershell
cd E:\wizard-docker
docker compose -f docker-compose.queueway.yml down -v
cd ..
Remove-Item -Recurse -Force E:\wizard-docker
```

---

## 4. Re-running the test suites (any time)

```powershell
cd E:\queueway
node scripts\postgres-test.js            # needs DATABASE_URL in .env
node scripts\postgres-multiworker-test.js
node scripts\regression-test.js          # ~60s, silent for 30s at a time
```
