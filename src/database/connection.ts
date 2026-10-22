import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { migrations } from "./migrations/index.js";
import type { Migration } from "./migrations/types.js";

interface AppliedMigrationRow {
  version: number;
}

export function createDatabase(databasePath: string): Database.Database {
  if (typeof databasePath !== "string") {
    throw new TypeError("databasePath must be a string");
  }

  if (!databasePath.trim()) {
    throw new Error("A SQLite database path is required");
  }

  if (databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }

  const database = new Database(databasePath, { timeout: 5_000 });

  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");

  runMigrations(database);

  return database;
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set(
    database
      .prepare<[], AppliedMigrationRow>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .all()
      .map((migration) => migration.version),
  );

  const applyMigration = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database
      .prepare<{ version: number; name: string; appliedAt: string }>(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (@version, @name, @appliedAt)
      `)
      .run({
        version: migration.version,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
  });

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      applyMigration(migration);
    }
  }
}
