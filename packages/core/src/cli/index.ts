#!/usr/bin/env node
import { Command } from "commander";
import { init } from "./commands/init";
import { health } from "./commands/health";
import { start } from "./commands/start";
import { status } from "./commands/status";
import { stop } from "./commands/stop";

const program = new Command();

program
  .name("queueway")
  .description("Queueway CLI - zero-config job queue tooling")
  .version("0.0.1");

program.command("init").description("Interactive setup wizard").action(init);

program
  .command("health")
  .description(
    "Check broker/database health and job stats by calling the running Queueway API",
  )
  .option("-u, --url <url>", "Queueway API base URL", "http://localhost:4287")
  .action((opts) => health(opts.url));

program
  .command("start")
  .description(
    "Start the Queueway server (config + jobs auto-loaded, auto-restarts on crash)",
  )
  .option("-p, --port <port>", "Port to listen on", "4287")
  .option("-b, --background", "Run in the background without asking")
  .option("-f, --foreground", "Run in the foreground without asking")
  .action((opts) => start(opts));

program
  .command("status")
  .description(
    "Check whether the Queueway server is up (dev or prod, background or foreground)",
  )
  .option(
    "-p, --port <port>",
    "Port to check (defaults to the running background server's port, or 4287)",
  )
  .action((opts) => status(opts));

program
  .command("stop")
  .description("Stop a Queueway server that was started in the background")
  .action(stop);

program.parse(process.argv);
