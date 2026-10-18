import type { Migration } from "./types.js";

export const removeObsoleteDiscordPublicationsMigration: Migration = {
  version: 11,
  name: "remove obsolete classification publications",
  sql: `
    DROP TABLE IF EXISTS discord_classification_publications;
  `,
};
