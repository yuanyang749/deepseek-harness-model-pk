export const CONTROL_SCHEMA_VERSION = 2

function attemptsTableSql(tableName: 'attempts' | 'attempts_v2', ifNotExists: boolean): string {
  return `
CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
  trigger TEXT NOT NULL CHECK(trigger IN ('INITIAL', 'RETRY', 'RUN_AGAIN', 'RETRY_FAILED')),
  batch_action_id TEXT,
  state TEXT NOT NULL,
  lifecycle_version INTEGER NOT NULL DEFAULT 0,
  queue_seq INTEGER NOT NULL UNIQUE,
  dsh_session_id TEXT UNIQUE,
  dispatch_intent_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  finalization_id TEXT UNIQUE,
  finalization_stage TEXT,
  execution_lease_id TEXT NOT NULL UNIQUE,
  fencing_token TEXT NOT NULL UNIQUE,
  reservation_state TEXT NOT NULL CHECK(reservation_state IN ('NOT_ACQUIRED', 'HELD', 'RELEASED', 'ORPHANED')),
  control_slot_id TEXT NOT NULL REFERENCES capacity_slots(slot_id),
  body_json TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  finalized_at TEXT,
  FOREIGN KEY(batch_action_id) REFERENCES actions(action_id),
  UNIQUE(run_id, attempt_no)
) STRICT;
`
}

const ATTEMPT_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS one_nonterminal_attempt_per_run
  ON attempts(run_id) WHERE state IN ('QUEUED','PREPARING','DISPATCHING','RUNNING','RECOVERING','CANCELLING','FINALIZING');
CREATE INDEX IF NOT EXISTS attempt_fifo ON attempts(state, queue_seq);
CREATE INDEX IF NOT EXISTS attempt_by_experiment ON attempts(experiment_id, queue_seq);
CREATE INDEX IF NOT EXISTS attempt_by_control_slot ON attempts(control_slot_id);
`

export const ATTEMPTS_V2_MIGRATION_SQL = `
${attemptsTableSql('attempts_v2', false)}
INSERT INTO attempts_v2(
  attempt_id,run_id,experiment_id,attempt_no,trigger,batch_action_id,state,lifecycle_version,
  queue_seq,dsh_session_id,dispatch_intent_id,idempotency_key,finalization_id,finalization_stage,
  execution_lease_id,fencing_token,reservation_state,control_slot_id,body_json,queued_at,finalized_at
)
SELECT
  attempt_id,run_id,experiment_id,attempt_no,trigger,batch_action_id,state,lifecycle_version,
  queue_seq,dsh_session_id,dispatch_intent_id,idempotency_key,finalization_id,finalization_stage,
  execution_lease_id,fencing_token,reservation_state,control_slot_id,body_json,queued_at,finalized_at
FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_v2 RENAME TO attempts;
${ATTEMPT_INDEX_SQL}
`

export const CONTROL_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA temp_store = MEMORY;
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS capacity_slots (
  slot_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  state TEXT NOT NULL CHECK(state IN ('FREE', 'CLAIMED')),
  owner_attempt_id TEXT UNIQUE,
  generation INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL UNIQUE,
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id) ON DELETE CASCADE,
  expected_revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  expected_hash TEXT NOT NULL,
  temp_path TEXT NOT NULL UNIQUE,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('UPLOADING', 'READY', 'FAILED')),
  error_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS preflight_snapshots (
  preflight_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id) ON DELETE CASCADE,
  draft_revision INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('READY', 'WARNING', 'BLOCKED')),
  body_json TEXT NOT NULL,
  confirmed_snapshot_hash TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS preflight_by_draft ON preflight_snapshots(draft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('STARTING', 'ACTIVE', 'START_FAILED', 'SETTLED')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('ALL_SUCCEEDED', 'PARTIAL_SUCCESS', 'NONE_SUCCEEDED', 'ALL_CANCELLED')),
  generation INTEGER NOT NULL DEFAULT 0,
  semantic_event_cursor INTEGER NOT NULL DEFAULT 0,
  audit_sequence INTEGER NOT NULL DEFAULT 0,
  attempt_set_hash TEXT NOT NULL,
  archive_freshness TEXT NOT NULL CHECK(archive_freshness IN ('CURRENT', 'STALE')),
  archive_integrity TEXT NOT NULL CHECK(archive_integrity IN ('COMPLETE', 'PARTIAL', 'INCOMPLETE')),
  archive_revision INTEGER NOT NULL DEFAULT 0,
  latest_seal_hash TEXT,
  seal_activation_id TEXT,
  body_json TEXT NOT NULL,
  experiment_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_experiment
  ON experiments((1)) WHERE lifecycle_state IN ('STARTING', 'ACTIVE');

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  model_config_id TEXT NOT NULL,
  model_config_fingerprint TEXT NOT NULL,
  latest_attempt_id TEXT,
  last_successful_attempt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(experiment_id, ordinal),
  UNIQUE(experiment_id, model_config_id)
) STRICT;

${attemptsTableSql('attempts', true)}
${ATTEMPT_INDEX_SQL}

CREATE TABLE IF NOT EXISTS actions (
  action_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  experiment_id TEXT REFERENCES experiments(experiment_id) ON DELETE SET NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING', 'APPLIED', 'FAILED')),
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS action_by_experiment ON actions(experiment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS action_targets (
  action_id TEXT NOT NULL REFERENCES actions(action_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  expected_lifecycle_version INTEGER NOT NULL,
  result TEXT,
  PRIMARY KEY(action_id, attempt_id)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_by_experiment ON audit_events(experiment_id, cursor);

CREATE TABLE IF NOT EXISTS seal_jobs (
  seal_job_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  archive_revision INTEGER NOT NULL,
  expected_generation INTEGER NOT NULL,
  expected_semantic_cursor INTEGER NOT NULL,
  expected_attempt_set_hash TEXT NOT NULL,
  audit_sequence_at_snapshot INTEGER NOT NULL,
  activation_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('PENDING','SNAPSHOTTED','ACTIVATING','ACTIVE','SUPERSEDED','FAILED')),
  index_hash TEXT,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(experiment_id, archive_revision)
) STRICT;

CREATE TABLE IF NOT EXISTS deletion_receipts (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL
) STRICT;
`
