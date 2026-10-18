import { initialMigration } from "./001-initial.js";
import { addEmailSubjectMigration } from "./002-add-email-subject.js";
import { addPollCheckpointsMigration } from "./003-add-poll-checkpoints.js";
import { addVersionedDraftsMigration } from "./004-add-versioned-drafts.js";
import { addDiscordApprovalsMigration } from "./005-add-discord-approvals.js";
import { addSentEmailMetadataMigration } from "./006-add-sent-email-metadata.js";
import { addFailureAndDiscordStatusMigration } from "./007-add-failure-and-discord-status.js";
import { addEmailClassificationMigration } from "./008-add-email-classification.js";
import { addSchedulingSessionsMigration } from "./009-add-scheduling-sessions.js";
import { addEmailConversationsMigration } from "./010-add-email-conversations.js";
import { removeObsoleteDiscordPublicationsMigration } from "./011-remove-obsolete-discord-publications.js";
import { addMultipleSchedulingOptionsMigration } from "./012-add-multiple-scheduling-options.js";
import { allowSentConversationsMigration } from "./013-allow-sent-conversations.js";
import type { Migration } from "./types.js";

export const migrations: readonly Migration[] = Object.freeze([
  initialMigration,
  addEmailSubjectMigration,
  addPollCheckpointsMigration,
  addVersionedDraftsMigration,
  addDiscordApprovalsMigration,
  addSentEmailMetadataMigration,
  addFailureAndDiscordStatusMigration,
  addEmailClassificationMigration,
  addSchedulingSessionsMigration,
  addEmailConversationsMigration,
  removeObsoleteDiscordPublicationsMigration,
  addMultipleSchedulingOptionsMigration,
  allowSentConversationsMigration,
]);
