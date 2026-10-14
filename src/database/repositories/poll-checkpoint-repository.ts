import type Database from "better-sqlite3";

import type { PollCheckpointRepository } from "../../interfaces/poll-checkpoint-repository.js";

interface PollCheckpointRow {
  checkpoint_at: string;
}

export class SqlitePollCheckpointRepository
  implements PollCheckpointRepository
{
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async get(name: string): Promise<Date | null> {
    const row = this.#database
      .prepare<[string], PollCheckpointRow>(`
        SELECT checkpoint_at
        FROM poll_checkpoints
        WHERE name = ?
      `)
      .get(name);

    if (!row) {
      return null;
    }

    const checkpoint = new Date(row.checkpoint_at);

    if (Number.isNaN(checkpoint.getTime())) {
      throw new Error(`Invalid poll checkpoint for ${name}: ${row.checkpoint_at}`);
    }

    return checkpoint;
  }

  async save(name: string, checkpoint: Date): Promise<void> {
    if (!name.trim()) {
      throw new Error("A poll checkpoint name is required");
    }

    if (Number.isNaN(checkpoint.getTime())) {
      throw new Error("A valid poll checkpoint date is required");
    }

    const now = new Date().toISOString();

    this.#database
      .prepare<{
        name: string;
        checkpointAt: string;
        updatedAt: string;
      }>(`
        INSERT INTO poll_checkpoints (name, checkpoint_at, updated_at)
        VALUES (@name, @checkpointAt, @updatedAt)
        ON CONFLICT (name) DO UPDATE SET
          checkpoint_at = excluded.checkpoint_at,
          updated_at = excluded.updated_at
      `)
      .run({
        name,
        checkpointAt: checkpoint.toISOString(),
        updatedAt: now,
      });
  }
}
