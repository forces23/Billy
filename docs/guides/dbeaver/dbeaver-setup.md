# DBeaver setup guide

This guide installs DBeaver Community on macOS, connects it safely to Billy's local SQLite database, and explains what changes when Billy later moves to PostgreSQL or Amazon Aurora PostgreSQL.

Last checked against DBeaver and AWS documentation: October 12, 2026.

## What you will set up

By the end of the local setup, DBeaver will have a read-only connection to:

```text
/Users/shadowcoder/Workspace/Billy/data/billy.sqlite
```

You will be able to inspect:

- Incoming email metadata and processing status
- Generated draft bodies and private reviewer notes
- Scheduling sessions, availability cards, and calendar proposals
- Assistant conversations, durable memories, and model usage costs
- Gmail polling checkpoints
- Applied SQLite migrations

DBeaver is only a database viewer and management client. Billy continues to own the database and run migrations automatically.

## 1. Download DBeaver Community

1. Open the official [DBeaver Community download page](https://dbeaver.io/download/).
2. Find the **macOS** downloads.
3. Choose the build matching your Mac:
   - Choose **Apple Silicon** or **AArch64** for an M-series Mac.
   - Choose **Intel** or **x86_64** for an Intel Mac.
4. Download the installer or `.dmg` package.

To check which Mac you have:

1. Open the Apple menu in the upper-left corner of the screen.
2. Select **About This Mac**.
3. Look for **Chip** or **Processor**.

DBeaver's [installation documentation](https://dbeaver.com/docs/dbeaver/Installation/) recommends the installer distribution on macOS and confirms that DBeaver includes its own OpenJDK. You do not need to install Java separately.

## 2. Install and open DBeaver

1. Open the downloaded installer or `.dmg`.
2. If a disk image opens, drag **DBeaver** into **Applications**.
3. Open **Applications** in Finder.
4. Open **DBeaver**.
5. If macOS asks whether you want to open an application downloaded from the internet, verify that it is DBeaver and click **Open**.
6. Complete any first-launch prompts.

If DBeaver offers to create or connect to a sample database, skip it. Billy already has the database you need.

## 3. Create the SQLite connection

1. In DBeaver, open **Database** > **New Database Connection**.

   - You can also click the plug-shaped **New Database Connection** button in the toolbar.
2. Enter `SQLite` in the database search field.
3. Select **SQLite**.
4. Click **Next**.
5. In the **Path** field, click **Browse**.
6. Select Billy's database:

   ```text
   /Users/shadowcoder/Workspace/Billy/data/billy.sqlite
   ```
7. If DBeaver asks to download the SQLite driver, click **Download** and wait for it to finish.
8. Click **Test Connection**.
9. Confirm that DBeaver reports a successful connection.
10. Click **Finish**.

DBeaver's [connection documentation](https://dbeaver.com/docs/dbeaver/Create-Connection/) describes SQLite as an embedded database: it uses a file path instead of a server host, port, username, or password.

### If the database file does not exist

Run Billy once from the repository root:

```bash
npm run dev
```

Wait for this log entry:

```text
Database is ready
```

Press `Ctrl+C`, then return to DBeaver and select the database file again.

## 4. Name and protect the connection

Name the connection clearly and make it read-only so an accidental edit cannot change Billy's workflow state.

1. Find the new SQLite connection in the **Database Navigator**.
2. Right-click it and select **Edit Connection**.
3. Set the connection name to:

   ```text
   Billy Local SQLite
   ```
4. Open **Connection settings** > **Security**.
5. Enable **Read-only connection**.
6. Click **OK** or **Save**.

If your DBeaver version does not show the Security page, select the connection and use the **Make connection read-only** button in the toolbar.

DBeaver documents the read-only option in its [connection security restrictions](https://dbeaver.com/docs/dbeaver/Managing-security-restrictions-for-database-connection/). Keep the connection read-only unless you deliberately need to repair data and have first stopped Billy and created a backup.

## 5. Browse Billy's tables

In the **Database Navigator**, expand:

```text
Billy Local SQLite
└── main
    └── Tables
```

Depending on the DBeaver version, an extra database or schema level might appear before `main`.

Billy currently uses these application tables:

| Area | Table | Contents |
| --- | --- | --- |
| Email | `email_messages` | Gmail identifiers, metadata, workflow status, classifications, and errors |
| Email | `email_drafts` | Immutable draft revisions, reviewer notes, models, and token usage |
| Email | `email_review_decisions` | Final approval or do-not-reply decision and selected draft |
| Email | `email_review_recipients` | Exact To and Cc recipients approved for sending |
| Email | `email_revision_requests` | Thread instructions and source/result drafts for revisions |
| Email | `email_conversations` | One Discord review conversation per Gmail thread |
| Email | `email_conversation_messages` | Gmail messages attached to each review conversation |
| Discord | `discord_draft_publications` | Discord message IDs for published draft revisions |
| Discord | `discord_generation_failure_publications` | Published retry controls for generation failures |
| Discord | `discord_inbound_publications` | Published incoming-email messages in review threads |
| Scheduling | `scheduling_sessions` | Parsed scheduling requests, analysis, selections, and status |
| Scheduling | `scheduling_turns` | Scheduling clarification history |
| Scheduling | `scheduling_draft_links` | Links between scheduling sessions and generated email drafts |
| Scheduling | `scheduling_availability_cards` | Immutable Discord availability-card revisions |
| Scheduling | `scheduling_lifecycle` | Scheduling and follow-up lifecycle state |
| Calendar | `calendar_event_records` | Proposed, created, updated, rejected, and cancelled calendar events |
| Assistant | `assistant_inbound_messages` | Deduplication and processing state for main-channel messages |
| Assistant | `assistant_conversation_messages` | Complete stored owner and assistant message history |
| Assistant | `assistant_conversation_state` | Per-channel recent-context reset boundary |
| Assistant | `assistant_memories` | Active and forgotten durable memories |
| Assistant | `assistant_model_usage` | Provider-reported model, tokens, reasoning tokens, and cost |
| Assistant | `assistant_conversation_fts` | FTS5 search index over stored assistant messages |
| Operations | `poll_checkpoints` | Last completed Gmail polling checkpoint |
| Operations | `schema_migrations` | Ordered database migrations Billy has applied |

SQLite also displays FTS5 implementation tables ending in `_config`, `_data`,
`_docsize`, and `_idx`. They are maintained automatically; do not edit them.

To browse a table:

1. Expand **Tables**.
2. Double-click the table name.
3. Select the **Data** tab.
4. Use the refresh button when Billy has written new data.

Long draft bodies can be difficult to read in the grid. Select the `body` cell and open DBeaver's value or text panel to view the complete text.

Do not share screenshots containing draft bodies, reviewer notes, sender information, message IDs, or other private email data.

## 6. View generated drafts with one query

1. Right-click **Billy Local SQLite** in the Database Navigator.
2. Select **SQL Editor** > **Open SQL Script**.
3. Paste this query:

```sql
SELECT
  e.subject,
  e.status,
  e.received_at,
  d.id AS draft_id,
  d.revision,
  d.body,
  d.reviewer_note,
  d.resolved_model,
  d.prompt_tokens,
  d.completion_tokens,
  d.created_at AS draft_created_at
FROM email_messages AS e
LEFT JOIN email_drafts AS d
  ON d.provider_message_id = e.provider_message_id
ORDER BY e.received_at DESC, d.revision DESC;
```

4. Click **Execute SQL Statement** in the SQL editor toolbar.

This query is read-only. It shows emails without drafts as well as every saved draft revision.

To view only messages waiting for approval, add this line before `ORDER BY`:

```sql
WHERE e.status = 'awaiting_approval'
```

### View assistant memories and usage

Saved memories can be inspected with:

```sql
SELECT id, content, status, created_at, updated_at
FROM assistant_memories
ORDER BY updated_at DESC;
```

Provider-reported assistant usage can be summarized with:

```sql
SELECT
  COUNT(*) AS requests,
  SUM(prompt_tokens) AS input_tokens,
  SUM(completion_tokens) AS output_tokens,
  SUM(reasoning_tokens) AS reasoning_tokens,
  SUM(cost_usd) AS cost_usd
FROM assistant_model_usage;
```

These queries are read-only. Memory content and conversation history are private
user data and should not be included in screenshots or shared exports.

## 7. Understand the statuses

The `status` column in `email_messages` shows where each email is in Billy's workflow:

| Status                | Meaning                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `discovered`        | Billy registered the email but has not started drafting                          |
| `drafting`          | Billy claimed the email and is generating a response                             |
| `awaiting_approval` | A draft exists and is waiting for Discord approval                               |
| `approved`          | Discord approval selected an exact draft and recipient list for future sending   |
| `sending`           | Billy is attempting to send the approved reply                                   |
| `sent`              | The reply was sent successfully                                                  |
| `failed`            | Processing failed; inspect `last_error`                                           |
| `rejected`          | A reviewer selected **Do not reply**                                              |
| `expired`           | The approval request expired                                                     |
| `ignored`           | Billy identified an automated or mailing-list message; inspect `ignored_reason`  |

The email-sending worker actively moves approved messages through `sending` to
`sent`. A `failed` send remains stored for inspection and recovery.

## 8. Use DBeaver while Billy is running

It is safe to read the database while Billy is running. Billy configures SQLite to use write-ahead logging, so these files may appear next to the database:

```text
billy.sqlite
billy.sqlite-wal
billy.sqlite-shm
```

Those files are normal. Do not delete, rename, or move them while Billy is running.

Recommended workflow:

1. Keep the DBeaver connection read-only.
2. Start Billy with `npm run dev`.
3. Refresh the DBeaver table or query results after new logs appear.
4. Disconnect DBeaver before moving, replacing, or restoring the database file.
5. Stop Billy before making a manual backup of the SQLite files.

Do not leave uncommitted DBeaver edits or transactions open. DBeaver's [transaction documentation](https://dbeaver.com/docs/dbeaver/Auto-and-Manual-Commit-Modes/) explains that manual transactions remain open until explicitly committed or rolled back.

## 9. Troubleshooting

### DBeaver asks to download a driver

This is expected the first time you create a connection. Approve the SQLite JDBC driver download. DBeaver requires internet access for the download.

### The connection test fails because the file cannot be opened

Confirm that the selected path is exactly:

```text
/Users/shadowcoder/Workspace/Billy/data/billy.sqlite
```

Also confirm that your macOS account can read the file and its parent `data` directory.

### New messages or drafts do not appear

Refresh the table or rerun the query. DBeaver does not automatically refresh an already-open result grid whenever Billy commits a change.

### DBeaver reports that the database is locked

1. Confirm the DBeaver connection is read-only.
2. Roll back any pending DBeaver transaction.
3. Disconnect and reconnect the SQLite connection.
4. If the problem continues, stop Billy and reopen DBeaver.

Do not delete the `-wal` or `-shm` files to resolve a lock.

### A table or column from this guide is missing

Billy applies migrations during startup. Run `npm run dev`, wait for **Database
is ready**, stop the process with `Ctrl+C`, and refresh the schema in DBeaver.

## 10. Later: connect DBeaver to PostgreSQL

When Billy moves to PostgreSQL, create a new connection instead of modifying the SQLite connection:

1. Open **Database** > **New Database Connection**.
2. Search for and select **PostgreSQL**.
3. Click **Next**.
4. Enter the PostgreSQL host.
5. Leave the default port as `5432` unless the server uses another port.
6. Enter the database name, username, and password.
7. Configure SSL if the server requires it.
8. Click **Test Connection**.
9. Download the PostgreSQL JDBC driver if prompted.
10. Click **Finish**.

The available fields and security options are documented in DBeaver's [PostgreSQL connection guide](https://dbeaver.com/docs/dbeaver/Database-driver-PostgreSQL/).

The SQLite connection can remain in DBeaver as a read-only historical reference after the migration is complete.

## 11. Later: connect DBeaver to Aurora PostgreSQL

Aurora PostgreSQL uses the PostgreSQL protocol, so a normal Aurora cluster can be opened through DBeaver's PostgreSQL driver.

You will need these values from AWS:

| DBeaver field | Aurora value                                                  |
| ------------- | ------------------------------------------------------------- |
| Host          | Aurora cluster or instance endpoint without`https://`       |
| Port          | Usually`5432`                                               |
| Database      | Database created in the Aurora cluster                        |
| Username      | A dedicated database user, not the application master user    |
| Password      | The database password or a temporary IAM authentication token |
| SSL           | Enabled, preferably with server certificate verification      |

### Network access comes first

DBeaver can connect only if your Mac can reach the Aurora endpoint. Use an approved private connection, VPN, SSH bastion, or narrowly scoped security-group rule. Do not expose PostgreSQL publicly to `0.0.0.0/0` merely to make DBeaver connect.

DBeaver Community supports ordinary PostgreSQL connections, SSL, and SSH tunnels. DBeaver's automatic **AWS RDS IAM Authentication** and AWS credential integration are paid-edition features, according to its [PostgreSQL driver documentation](https://dbeaver.com/docs/dbeaver/Database-driver-PostgreSQL/) and [AWS credential documentation](https://dbeaver.com/docs/dbeaver/AWS-Credentials/).

With Community Edition, the simplest initial administrative connection is a dedicated username and password protected by TLS and network restrictions. If you manually generate an AWS IAM database token, AWS says it expires after 15 minutes; DBeaver Community will not automatically refresh it. See [AWS IAM database authentication](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.Connecting.html).

### Configure TLS verification

1. Download the current AWS RDS certificate bundle for the Aurora region.
2. Edit the PostgreSQL connection in DBeaver.
3. Add or open the **SSL** configuration.
4. Select the AWS RDS CA bundle as the CA certificate.
5. Choose an SSL mode that verifies the certificate and hostname, such as `verify-full`, when supported by the selected driver configuration.
6. Test the connection.

AWS publishes its current CA bundles and verification instructions in [Using SSL/TLS with Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.SSL.html). DBeaver documents its side of the setup in [SSL configuration](https://dbeaver.com/docs/dbeaver/SSL-Configuration/).

## Safety checklist

- Keep the local SQLite connection read-only.
- Never paste `.env` secrets into DBeaver SQL scripts.
- Do not expose an Aurora database directly to the entire internet.
- Use TLS certificate verification for remote databases.
- Give DBeaver its own least-privileged database user.
- Use a separate connection for development and production.
- Keep production connections in manual-commit mode with confirmation prompts.
- Back up data before running manual repair statements.
