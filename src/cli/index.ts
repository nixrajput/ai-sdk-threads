#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { ThreadStoreDatabase } from "../drizzle/store.js";
import { formatImportReport, importVercelChat } from "./import-vercel.js";
import { formatMigrateReport, migrateDatabase } from "./migrate.js";

const USAGE = `ai-sdk-threads <command> [options]

Commands
  migrate         Bring rows written by an older ai major up to the current one, verifying
                  that each one is still readable, and restamp sdk_version.
  import-vercel   Copy the Vercel ai-chatbot template's Chat and Message_v2 tables into
                  ai_sdk_threads and ai_sdk_messages.

Options
  --database-url <url>   Postgres connection string. Required.
  --dry-run              Report what would change and write nothing.
  --help                 Show this message.

Both commands are also exported for programmatic use, so you can run them against a database
handle you already have instead of a connection string.
`;

/**
 * `pg` is imported here rather than depended on: this package ships no runtime dependencies, and
 * the CLI is the only thing that needs a driver of its own.
 */
async function connect(databaseUrl: string) {
  type PgClient = new (config: {
    connectionString: string;
  }) => {
    connect(): Promise<void>;
    end(): Promise<void>;
  };
  let Client: PgClient;
  try {
    // A non-literal specifier on purpose: `pg` is not a dependency of this package, so it must
    // not be resolved at build time either.
    const specifier = "pg";
    ({ Client } = (await import(specifier)) as { Client: PgClient });
  } catch {
    throw new Error(
      "ai-sdk-threads: this command needs a Postgres driver. Install it with `npm i -D pg`, " +
        "or import migrateDatabase / importVercelChat and pass your own drizzle database.",
    );
  }
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return { db: drizzle(client) as unknown as ThreadStoreDatabase, close: () => client.end() };
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "database-url": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  if (command !== "migrate" && command !== "import-vercel") {
    console.error(`ai-sdk-threads: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  const databaseUrl = values["database-url"];
  if (!databaseUrl) {
    console.error("ai-sdk-threads: --database-url is required\n");
    console.error(USAGE);
    return 1;
  }

  const connection = await connect(databaseUrl);
  try {
    const dryRun = values["dry-run"] === true;
    if (command === "migrate") {
      console.log(formatMigrateReport(await migrateDatabase(connection.db, { dryRun })));
    } else {
      console.log(formatImportReport(await importVercelChat(connection.db, { dryRun })));
    }
    return 0;
  } finally {
    await connection.close();
  }
}

// Only self-executes as the bin; importing this module runs nothing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/)/, ""))) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
