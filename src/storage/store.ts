import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ActionKind,
  Attempt,
  AttemptState,
  AuditEvent,
  Draft,
  DurableAction,
  Experiment,
  ExperimentLifecycle,
  ExperimentOutcome,
  ExperimentProjection,
  Hash,
  ModelPkError,
  PreflightSnapshot,
  Run,
  StorageListItem,
  UUID,
} from '../contracts/types.js'
import { hashCanonical } from '../core/jcs.js'
import { fail } from '../core/error.js'
import { assertAttemptTransition, deriveCounts, deriveExperimentOutcome, isTerminalAttemptState } from '../core/state-machine.js'
import { ATTEMPTS_V2_MIGRATION_SQL, CONTROL_SCHEMA_SQL, CONTROL_SCHEMA_VERSION } from './schema.js'

type SqlValue = string | number | bigint | Uint8Array | null
type Bindings = Record<string, SqlValue>

interface CapacitySlotInput {
  readonly slotId: string
  readonly path: string
  readonly byteLength: number
  readonly generation?: number
  readonly checksum?: string
}

export interface UploadRecord {
  readonly uploadId: UUID
  readonly attachmentId: UUID
  readonly draftId: UUID
  readonly expectedRevision: number
  readonly name: string
  readonly mimeType: string
  readonly byteLength: number
  readonly expectedHash: Hash
  readonly tempPath: string
  readonly receivedBytes: number
  readonly state: 'UPLOADING' | 'READY' | 'FAILED'
  readonly error: ModelPkError | null
  readonly createdAt: string
  readonly expiresAt: string
}

interface ActionClaim {
  readonly action: DurableAction
  readonly existing: boolean
}

interface ExperimentCreateInput {
  readonly experiment: Experiment
  readonly runs: readonly Run[]
  readonly attempts: readonly Attempt[]
  readonly actionId: UUID
  readonly requestHash: Hash
}

interface AttemptCreateInput {
  readonly attempt: Attempt
  readonly actionId: UUID
  readonly actionKind: ActionKind
  readonly requestHash: Hash
  readonly expectedLatestAttemptId: UUID
}

interface AttemptBatchCreateInput {
  readonly attempts: readonly Attempt[]
  readonly actionId: UUID
  readonly actionKind: 'RETRY_FAILED'
  readonly requestHash: Hash
  readonly experimentId: UUID
  readonly expectedLatestByRun: Readonly<Record<UUID, UUID>>
}

interface AttemptTransitionPatch {
  readonly expectedVersion: number
  readonly to: AttemptState
  readonly patch: Partial<Attempt>
}

interface DbExperimentRow {
  experiment_id: string
  lifecycle_state: ExperimentLifecycle
  outcome: ExperimentOutcome
  generation: number
  semantic_event_cursor: number
  audit_sequence: number
  attempt_set_hash: Hash
  archive_freshness: 'CURRENT' | 'STALE'
  archive_integrity: 'COMPLETE' | 'PARTIAL' | 'INCOMPLETE'
  archive_revision: number
  latest_seal_hash: Hash | null
  body_json: string
  experiment_path: string
  created_at: string
  settled_at: string | null
}

interface DbRunRow {
  run_id: string
  experiment_id: string
  ordinal: number
  model_config_fingerprint: Hash
  latest_attempt_id: string
  last_successful_attempt_id: string | null
  attempt_count: number
  body_json: string
  created_at: string
}

interface DbAttemptRow {
  body_json: string
}

interface DbActionRow {
  action_id: string
  kind: ActionKind
  experiment_id: string | null
  request_hash: Hash
  state: 'PENDING' | 'APPLIED' | 'FAILED'
  result_json: string | null
  error_json: string | null
  created_at: string
  completed_at: string | null
}

export class ControlStore {
  readonly db: DatabaseSync
  private readonly listeners = new Set<(event: AuditEvent) => void>()
  private transactionDepth = 0
  private pendingEvents: AuditEvent[] | null = null

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    this.db = new DatabaseSync(path)
    this.db.exec(CONTROL_SCHEMA_SQL)
    this.migrateReusableControlSlots()
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      .run('schema_version', String(CONTROL_SCHEMA_VERSION))
    try { chmodSync(path, 0o600) } catch { /* in-memory databases have no path */ }
  }

  close(): void {
    this.db.close()
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, value)
  }

  private migrateReusableControlSlots(): void {
    const uniqueIndexes = this.db.prepare(`
      SELECT name FROM pragma_index_list('attempts') WHERE "unique"=1
    `).all() as { name: string }[]
    const hasLegacyConstraint = uniqueIndexes.some(index => {
      const columns = this.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(index.name) as { name: string }[]
      return columns.length === 1 && columns[0]?.name === 'control_slot_id'
    })
    if (!hasLegacyConstraint) return

    this.db.exec('PRAGMA foreign_keys = OFF')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.db.exec(ATTEMPTS_V2_MIGRATION_SQL)
      const violations = this.db.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new Error(`control schema migration produced ${violations.length} foreign key violation(s)`)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original migration failure */ }
      throw error
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON')
    }
  }

  transaction<T>(callback: () => T): T {
    if (this.transactionDepth > 0) return callback()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    this.pendingEvents = []
    try {
      const result = callback()
      this.db.exec('COMMIT')
      const events = this.pendingEvents
      if (events !== null && events.length > 0) queueMicrotask(() => {
        for (const event of events) for (const listener of this.listeners) listener(event)
      })
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original failure */ }
      throw error
    } finally {
      this.pendingEvents = null
      this.transactionDepth -= 1
    }
  }

  onEvent(listener: (event: AuditEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  registerCapacitySlots(slots: readonly CapacitySlotInput[]): void {
    this.transaction(() => {
      const statement = this.db.prepare(`
        INSERT INTO capacity_slots(slot_id,path,byte_length,state,owner_attempt_id,generation,checksum,updated_at)
        VALUES($slotId,$path,$byteLength,'FREE',NULL,$generation,$checksum,$now)
        ON CONFLICT(slot_id) DO UPDATE SET
          path=excluded.path,
          byte_length=excluded.byte_length,
          generation=CASE WHEN capacity_slots.state='FREE' THEN excluded.generation ELSE capacity_slots.generation END,
          checksum=CASE WHEN capacity_slots.state='FREE' THEN excluded.checksum ELSE capacity_slots.checksum END,
          updated_at=excluded.updated_at
      `)
      const now = new Date().toISOString()
      for (const slot of slots) statement.run(bind({
        slotId: slot.slotId,
        path: slot.path,
        byteLength: slot.byteLength,
        generation: slot.generation ?? 0,
        checksum: slot.checksum ?? null,
        now,
      }))
    })
  }

  freeCapacitySlotCount(): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM capacity_slots WHERE state='FREE'").get() as { count: number }
    return Number(row.count)
  }

  nextQueueSequence(): number {
    const row = this.db.prepare('SELECT coalesce(max(queue_seq), 0) + 1 AS next FROM attempts').get() as { next: number }
    return Number(row.next)
  }

  putDraft(draft: Draft, expectedRevision?: number): Draft {
    if (expectedRevision === undefined) {
      this.db.prepare(`
        INSERT INTO drafts(draft_id,revision,body_json,created_at,updated_at)
        VALUES($id,$revision,$body,$createdAt,$updatedAt)
      `).run(bind({
        id: draft.draftId,
        revision: draft.revision,
        body: json(draft),
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      }))
      return draft
    }
    const result = this.db.prepare(`
      UPDATE drafts SET revision=$revision, body_json=$body, updated_at=$updatedAt
      WHERE draft_id=$id AND revision=$expectedRevision
    `).run(bind({
      id: draft.draftId,
      revision: draft.revision,
      body: json(draft),
      updatedAt: draft.updatedAt,
      expectedRevision,
    }))
    if (Number(result.changes) !== 1) {
      fail('ACTION_TARGET_STALE', 'draft', '草稿已变化，请刷新后重试', `draft CAS failed id=${draft.draftId} revision=${expectedRevision}`)
    }
    this.db.prepare('DELETE FROM preflight_snapshots WHERE draft_id=?').run(draft.draftId)
    return draft
  }

  getDraft(draftId: UUID): Draft | null {
    const row = this.db.prepare('SELECT body_json FROM drafts WHERE draft_id=?').get(draftId) as { body_json: string } | undefined
    if (row === undefined) return null
    const draft = parse<Draft>(row.body_json)
    return { ...draft, resultRootPath: draft.resultRootPath ?? null }
  }

  deleteExpiredDrafts(before: string): number {
    const result = this.db.prepare('DELETE FROM drafts WHERE updated_at < ?').run(before)
    return Number(result.changes)
  }

  expiredDraftIds(before: string): UUID[] {
    return (this.db.prepare('SELECT draft_id FROM drafts WHERE updated_at < ? ORDER BY draft_id').all(before) as unknown as { draft_id: UUID }[])
      .map(row => row.draft_id)
  }

  createUpload(upload: UploadRecord): void {
    this.db.prepare(`
      INSERT INTO uploads(
        upload_id,attachment_id,draft_id,expected_revision,name,mime_type,byte_length,expected_hash,
        temp_path,received_bytes,state,error_json,created_at,expires_at
      ) VALUES($uploadId,$attachmentId,$draftId,$revision,$name,$mimeType,$byteLength,$expectedHash,
        $tempPath,$receivedBytes,$state,$error,$createdAt,$expiresAt)
    `).run(bind({
      uploadId: upload.uploadId,
      attachmentId: upload.attachmentId,
      draftId: upload.draftId,
      revision: upload.expectedRevision,
      name: upload.name,
      mimeType: upload.mimeType,
      byteLength: upload.byteLength,
      expectedHash: upload.expectedHash,
      tempPath: upload.tempPath,
      receivedBytes: upload.receivedBytes,
      state: upload.state,
      error: upload.error === null ? null : json(upload.error),
      createdAt: upload.createdAt,
      expiresAt: upload.expiresAt,
    }))
  }

  getUpload(uploadId: UUID): UploadRecord | null {
    const row = this.db.prepare('SELECT * FROM uploads WHERE upload_id=?').get(uploadId) as {
      upload_id: string
      attachment_id: string
      draft_id: string
      expected_revision: number
      name: string
      mime_type: string
      byte_length: number
      expected_hash: Hash
      temp_path: string
      received_bytes: number
      state: 'UPLOADING' | 'READY' | 'FAILED'
      error_json: string | null
      created_at: string
      expires_at: string
    } | undefined
    if (row === undefined) return null
    return {
      uploadId: row.upload_id,
      attachmentId: row.attachment_id,
      draftId: row.draft_id,
      expectedRevision: row.expected_revision,
      name: row.name,
      mimeType: row.mime_type,
      byteLength: row.byte_length,
      expectedHash: row.expected_hash,
      tempPath: row.temp_path,
      receivedBytes: row.received_bytes,
      state: row.state,
      error: row.error_json === null ? null : parse<ModelPkError>(row.error_json),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  advanceUpload(uploadId: UUID, expectedOffset: number, nextOffset: number): UploadRecord {
    const result = this.db.prepare(`
      UPDATE uploads SET received_bytes=?
      WHERE upload_id=? AND state='UPLOADING' AND received_bytes=? AND byte_length>=?
    `).run(nextOffset, uploadId, expectedOffset, nextOffset)
    if (Number(result.changes) !== 1) {
      fail('ACTION_TARGET_STALE', 'attachment', '上传偏移已变化，请重试', `upload offset CAS failed id=${uploadId} offset=${expectedOffset}`)
    }
    const upload = this.getUpload(uploadId)
    if (upload === null) fail('NOT_FOUND', 'attachment', '上传不存在', `upload missing ${uploadId}`)
    return upload
  }

  finishUpload(uploadId: UUID, state: 'READY' | 'FAILED', error: ModelPkError | null): UploadRecord {
    this.db.prepare(`
      UPDATE uploads SET state=?,error_json=? WHERE upload_id=? AND state='UPLOADING'
    `).run(state, error === null ? null : json(error), uploadId)
    const upload = this.getUpload(uploadId)
    if (upload === null) fail('NOT_FOUND', 'attachment', '上传不存在', `upload missing ${uploadId}`)
    return upload
  }

  commitUploadToDraft(uploadId: UUID, draft: Draft, expectedRevision: number): Draft {
    return this.transaction(() => {
      this.putDraft(draft, expectedRevision)
      const result = this.db.prepare("UPDATE uploads SET state='READY',error_json=NULL WHERE upload_id=? AND state='UPLOADING'")
        .run(uploadId)
      if (Number(result.changes) !== 1) fail('ACTION_TARGET_STALE', 'attachment', '上传状态已变化', `upload commit CAS failed ${uploadId}`)
      return draft
    })
  }

  removeUpload(uploadId: UUID): void {
    this.db.prepare('DELETE FROM uploads WHERE upload_id=?').run(uploadId)
  }

  putPreflight(snapshot: PreflightSnapshot): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM preflight_snapshots WHERE draft_id=?').run(snapshot.draftId)
      this.db.prepare(`
        INSERT INTO preflight_snapshots(
          preflight_id,draft_id,draft_revision,snapshot_hash,status,body_json,confirmed_snapshot_hash,created_at
        ) VALUES($id,$draftId,$revision,$hash,$status,$body,$confirmed,$createdAt)
      `).run(bind({
        id: snapshot.preflightId,
        draftId: snapshot.draftId,
        revision: snapshot.draftRevision,
        hash: snapshot.snapshotHash,
        status: snapshot.status,
        body: json(snapshot),
        confirmed: snapshot.confirmedSnapshotHash,
        createdAt: snapshot.createdAt,
      }))
    })
  }

  getPreflight(preflightId: UUID): PreflightSnapshot | null {
    const row = this.db.prepare('SELECT body_json, confirmed_snapshot_hash FROM preflight_snapshots WHERE preflight_id=?')
      .get(preflightId) as { body_json: string; confirmed_snapshot_hash: Hash | null } | undefined
    if (row === undefined) return null
    return { ...parse<PreflightSnapshot>(row.body_json), confirmedSnapshotHash: row.confirmed_snapshot_hash }
  }

  confirmPreflight(preflightId: UUID, snapshotHash: Hash): PreflightSnapshot {
    return this.transaction(() => {
      const snapshot = this.getPreflight(preflightId)
      if (snapshot === null) fail('NOT_FOUND', 'preflight', 'Preflight 快照不存在', `preflight not found ${preflightId}`)
      if (snapshot.status !== 'WARNING' || snapshot.snapshotHash !== snapshotHash) {
        fail('PREFLIGHT_STALE', 'preflight', 'Preflight 快照已变化', `cannot confirm status=${snapshot.status} hash=${snapshot.snapshotHash}`)
      }
      const confirmed: PreflightSnapshot = { ...snapshot, confirmedSnapshotHash: snapshotHash }
      this.db.prepare('UPDATE preflight_snapshots SET confirmed_snapshot_hash=?, body_json=? WHERE preflight_id=?')
        .run(snapshotHash, json(confirmed), preflightId)
      return confirmed
    })
  }

  claimAction(
    actionId: UUID,
    kind: ActionKind,
    experimentId: UUID | null,
    requestHash: Hash,
    now = new Date().toISOString(),
  ): ActionClaim {
    const existing = this.getAction(actionId)
    if (existing !== null) {
      if (existing.kind !== kind || existing.requestHash !== requestHash || existing.experimentId !== experimentId) {
        fail('ACTION_ID_CONFLICT', 'action', 'operationId 已用于不同请求', `action conflict id=${actionId}`)
      }
      return { action: existing, existing: true }
    }
    this.db.prepare(`
      INSERT INTO actions(action_id,kind,experiment_id,request_hash,state,result_json,error_json,created_at,completed_at)
      VALUES($id,$kind,$experimentId,$requestHash,'PENDING',NULL,NULL,$createdAt,NULL)
    `).run(bind({ id: actionId, kind, experimentId, requestHash, createdAt: now }))
    return {
      existing: false,
      action: {
        actionId,
        kind,
        experimentId,
        requestHash,
        state: 'PENDING',
        result: null,
        error: null,
        createdAt: now,
        completedAt: null,
      },
    }
  }

  getAction(actionId: UUID): DurableAction | null {
    const row = this.db.prepare('SELECT * FROM actions WHERE action_id=?').get(actionId) as DbActionRow | undefined
    return row === undefined ? null : actionFromRow(row)
  }

  pendingActions(kind?: ActionKind): DurableAction[] {
    const rows = kind === undefined
      ? this.db.prepare("SELECT * FROM actions WHERE state='PENDING' ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM actions WHERE state='PENDING' AND kind=? ORDER BY created_at").all(kind)
    return (rows as unknown as DbActionRow[]).map(actionFromRow)
  }

  finishAction(actionId: UUID, result: Readonly<Record<string, unknown>>, now = new Date().toISOString()): DurableAction {
    this.db.prepare("UPDATE actions SET state='APPLIED',result_json=?,completed_at=? WHERE action_id=? AND state='PENDING'")
      .run(json(result), now, actionId)
    const action = this.getAction(actionId)
    if (action === null) fail('INTERNAL_ERROR', 'action', '操作记录丢失', `action missing after finish ${actionId}`)
    return action
  }

  failAction(actionId: UUID, error: ModelPkError, now = new Date().toISOString()): DurableAction {
    this.db.prepare("UPDATE actions SET state='FAILED',error_json=?,completed_at=? WHERE action_id=? AND state='PENDING'")
      .run(json(error), now, actionId)
    const action = this.getAction(actionId)
    if (action === null) fail('INTERNAL_ERROR', 'action', '操作记录丢失', `action missing after failure ${actionId}`)
    return action
  }

  createExperiment(input: ExperimentCreateInput): DurableAction {
    return this.transaction(() => {
      const existing = this.getAction(input.actionId)
      if (existing !== null) {
        if (existing.kind !== 'START' || existing.requestHash !== input.requestHash
          || existing.experimentId !== input.experiment.experimentId) {
          fail('ACTION_ID_CONFLICT', 'action', 'operationId 已用于不同请求', `action conflict id=${input.actionId}`)
        }
        return existing
      }
      if (input.runs.length !== input.attempts.length || input.runs.length < 2) {
        fail('VALIDATION_ERROR', 'start', '实验定义无效', 'start requires one initial attempt per run and at least two runs')
      }
      const slots = this.takeFreeSlots(input.attempts.length)
      this.insertExperiment(input.experiment)
      this.claimAction(input.actionId, 'START', input.experiment.experimentId, input.requestHash, input.experiment.createdAt)
      const attemptByRun = new Map(input.attempts.map(attempt => [attempt.runId, attempt]))
      for (const [index, run] of input.runs.entries()) {
        const attempt = attemptByRun.get(run.runId)
        const slot = slots[index]
        if (attempt === undefined || slot === undefined) fail('INTERNAL_ERROR', 'start', '实验定义不完整', 'run/attempt/slot mismatch')
        this.insertRun(run)
        this.insertAttempt(attempt, input.experiment.experimentId, slot)
      }
      this.appendEventInTransaction(input.experiment.experimentId, null, 'EXPERIMENT_START_INTENT_COMMITTED', {
        actionId: input.actionId,
        runIds: input.runs.map(run => run.runId),
        attemptIds: input.attempts.map(attempt => attempt.attemptId),
      }, input.experiment.createdAt)
      return this.finishAction(input.actionId, { experimentId: input.experiment.experimentId })
    })
  }

  private insertExperiment(experiment: Experiment): void {
    this.db.prepare(`
      INSERT INTO experiments(
        experiment_id,lifecycle_state,outcome,generation,semantic_event_cursor,audit_sequence,
        attempt_set_hash,archive_freshness,archive_integrity,archive_revision,latest_seal_hash,
        seal_activation_id,body_json,experiment_path,created_at,settled_at
      ) VALUES(
        $id,$state,$outcome,$generation,$semanticCursor,$auditSequence,
        $attemptSetHash,$freshness,$integrity,$archiveRevision,$latestSealHash,
        NULL,$body,$path,$createdAt,$settledAt
      )
    `).run(bind({
      id: experiment.experimentId,
      state: experiment.lifecycleState,
      outcome: experiment.outcome,
      generation: experiment.generation,
      semanticCursor: experiment.semanticEventCursor,
      auditSequence: experiment.auditSequence,
      attemptSetHash: experiment.attemptSetHash,
      freshness: experiment.archiveFreshness,
      integrity: experiment.archiveIntegrity,
      archiveRevision: experiment.archiveRevision,
      latestSealHash: experiment.latestSealHash,
      body: json(experiment),
      path: experiment.experimentPath,
      createdAt: experiment.createdAt,
      settledAt: experiment.settledAt,
    }))
  }

  private insertRun(run: Run): void {
    this.db.prepare(`
      INSERT INTO runs(
        run_id,experiment_id,ordinal,model_config_id,model_config_fingerprint,latest_attempt_id,
        last_successful_attempt_id,attempt_count,body_json,created_at
      ) VALUES($id,$experimentId,$ordinal,$modelConfigId,$fingerprint,$latestAttemptId,$lastSuccessful,$count,$body,$createdAt)
    `).run(bind({
      id: run.runId,
      experimentId: run.experimentId,
      ordinal: run.ordinal,
      modelConfigId: run.modelConfig.modelConfigId,
      fingerprint: run.modelConfigFingerprint,
      latestAttemptId: run.latestAttemptId,
      lastSuccessful: run.lastSuccessfulAttemptId,
      count: run.attemptCount,
      body: json(run),
      createdAt: run.createdAt,
    }))
  }

  private insertAttempt(attempt: Attempt, experimentId: UUID, controlSlotId: string): void {
    this.db.prepare(`
      INSERT INTO attempts(
        attempt_id,run_id,experiment_id,attempt_no,trigger,batch_action_id,state,lifecycle_version,
        queue_seq,dsh_session_id,dispatch_intent_id,idempotency_key,finalization_id,finalization_stage,
        execution_lease_id,fencing_token,reservation_state,control_slot_id,body_json,queued_at,finalized_at
      ) VALUES(
        $id,$runId,$experimentId,$attemptNo,$trigger,$batchActionId,$state,$version,
        $queueSeq,$sessionId,$dispatchIntentId,$idempotencyKey,$finalizationId,$finalizationStage,
        $leaseId,$fencingToken,$reservationState,$slotId,$body,$queuedAt,$finalizedAt
      )
    `).run(bind({
      id: attempt.attemptId,
      runId: attempt.runId,
      experimentId,
      attemptNo: attempt.attemptNo,
      trigger: attempt.trigger,
      batchActionId: attempt.batchActionId,
      state: attempt.state,
      version: attempt.lifecycleVersion,
      queueSeq: attempt.queueSeq,
      sessionId: attempt.dshSessionId,
      dispatchIntentId: attempt.dispatchIntentId,
      idempotencyKey: attempt.idempotencyKey,
      finalizationId: attempt.finalizationId,
      finalizationStage: attempt.finalizationStage,
      leaseId: attempt.executionLeaseId,
      fencingToken: attempt.fencingToken,
      reservationState: attempt.executionReservationState,
      slotId: controlSlotId,
      body: json(attempt),
      queuedAt: attempt.queuedAt,
      finalizedAt: attempt.finalizedAt,
    }))
    this.db.prepare("UPDATE capacity_slots SET state='CLAIMED', owner_attempt_id=?, updated_at=? WHERE slot_id=? AND state='FREE'")
      .run(attempt.attemptId, attempt.queuedAt, controlSlotId)
  }

  private takeFreeSlots(count: number): string[] {
    const rows = this.db.prepare("SELECT slot_id FROM capacity_slots WHERE state='FREE' ORDER BY slot_id LIMIT ?")
      .all(count) as { slot_id: string }[]
    if (rows.length !== count) {
      fail('CONTROL_STORE_CAPACITY_UNAVAILABLE', 'capacity', '控制存储容量不足', `required=${count}; free=${rows.length}`)
    }
    return rows.map(row => row.slot_id)
  }

  activateExperiment(experimentId: UUID, expectedState: 'STARTING' = 'STARTING'): ExperimentProjection {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE experiments SET lifecycle_state='ACTIVE', generation=generation+1,
          semantic_event_cursor=semantic_event_cursor+1, archive_freshness='STALE'
        WHERE experiment_id=? AND lifecycle_state=?
      `).run(experimentId, expectedState)
      if (Number(result.changes) !== 1) fail('ACTION_TARGET_STALE', 'start', '实验启动状态已变化', `activate CAS failed ${experimentId}`)
      this.appendEventInTransaction(experimentId, null, 'EXPERIMENT_ACTIVATED', {}, new Date().toISOString())
      return this.getExperimentRequired(experimentId)
    })
  }

  markStartFailed(experimentId: UUID, error: ModelPkError): ExperimentProjection {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE experiments SET lifecycle_state='START_FAILED', outcome=NULL, generation=generation+1,
          semantic_event_cursor=semantic_event_cursor+1, archive_freshness='STALE'
        WHERE experiment_id=? AND lifecycle_state='STARTING'
      `).run(experimentId)
      if (Number(result.changes) !== 1) fail('ACTION_TARGET_STALE', 'start', '实验启动状态已变化', `start failure CAS failed ${experimentId}`)
      this.appendEventInTransaction(experimentId, null, 'EXPERIMENT_START_FAILED', { error }, new Date().toISOString())
      return this.getExperimentRequired(experimentId)
    })
  }

  createAttempt(input: AttemptCreateInput): DurableAction {
    return this.transaction(() => {
      const projection = this.getExperimentRequired(this.experimentIdForRun(input.attempt.runId))
      const claim = this.claimAction(input.actionId, input.actionKind, projection.experimentId, input.requestHash)
      if (claim.existing) return claim.action
      const run = projection.runs.find(candidate => candidate.runId === input.attempt.runId)
      if (run === undefined) fail('NOT_FOUND', 'retry', 'Run 不存在', `run missing ${input.attempt.runId}`)
      if (run.latestAttemptId !== input.expectedLatestAttemptId) {
        fail('ACTION_TARGET_STALE', 'retry', 'Run 已有更新的 Attempt', `expected=${input.expectedLatestAttemptId}; actual=${run.latestAttemptId}`)
      }
      const slot = this.takeFreeSlots(1)[0]
      if (slot === undefined) fail('CONTROL_STORE_CAPACITY_UNAVAILABLE', 'capacity', '控制存储容量不足')
      this.insertAttempt(input.attempt, projection.experimentId, slot)
      this.db.prepare(`
        UPDATE runs SET latest_attempt_id=?, attempt_count=attempt_count+1 WHERE run_id=? AND latest_attempt_id=?
      `).run(input.attempt.attemptId, input.attempt.runId, input.expectedLatestAttemptId)
      const attemptIds = (this.db.prepare('SELECT attempt_id FROM attempts WHERE experiment_id=? ORDER BY attempt_id')
        .all(projection.experimentId) as { attempt_id: string }[]).map(row => row.attempt_id)
      this.db.prepare(`
        UPDATE experiments SET lifecycle_state='ACTIVE', generation=generation+1,
          semantic_event_cursor=semantic_event_cursor+1, archive_freshness='STALE', outcome=NULL,
          settled_at=NULL, attempt_set_hash=?
        WHERE experiment_id=? AND lifecycle_state IN ('ACTIVE','SETTLED')
      `).run(hashCanonical({ schemaVersion: 'model-pk/attempt-set/v1', attemptIds }), projection.experimentId)
      this.appendEventInTransaction(projection.experimentId, input.attempt.attemptId, 'ATTEMPT_CREATED', {
        actionId: input.actionId,
        trigger: input.attempt.trigger,
        runId: input.attempt.runId,
      }, input.attempt.queuedAt)
      return this.finishAction(input.actionId, { attemptId: input.attempt.attemptId })
    })
  }

  createAttemptBatch(input: AttemptBatchCreateInput): DurableAction {
    return this.transaction(() => {
      const projection = this.getExperimentRequired(input.experimentId)
      const claim = this.claimAction(input.actionId, input.actionKind, input.experimentId, input.requestHash)
      if (claim.existing) return claim.action
      if (input.attempts.length === 0) {
        return this.finishAction(input.actionId, { attemptIds: [], skipped: projection.runs.length })
      }
      const slots = this.takeFreeSlots(input.attempts.length)
      for (const [index, attempt] of input.attempts.entries()) {
        const run = projection.runs.find(candidate => candidate.runId === attempt.runId)
        const expectedLatest = input.expectedLatestByRun[attempt.runId]
        if (run === undefined || expectedLatest === undefined || run.latestAttemptId !== expectedLatest) {
          fail('ACTION_TARGET_STALE', 'retry-failed', '重试目标已变化', `stale run=${attempt.runId}`)
        }
        const slot = slots[index]
        if (slot === undefined) fail('CONTROL_STORE_CAPACITY_UNAVAILABLE', 'capacity', '控制存储容量不足')
        this.insertAttempt(attempt, input.experimentId, slot)
        const updated = this.db.prepare(`
          UPDATE runs SET latest_attempt_id=?,attempt_count=attempt_count+1
          WHERE run_id=? AND latest_attempt_id=?
        `).run(attempt.attemptId, attempt.runId, expectedLatest)
        if (Number(updated.changes) !== 1) fail('ACTION_TARGET_STALE', 'retry-failed', '重试目标已变化', `run CAS lost ${attempt.runId}`)
        this.appendEventInTransaction(input.experimentId, attempt.attemptId, 'ATTEMPT_CREATED', {
          actionId: input.actionId,
          trigger: attempt.trigger,
          runId: attempt.runId,
        }, attempt.queuedAt)
      }
      const attemptIds = (this.db.prepare('SELECT attempt_id FROM attempts WHERE experiment_id=? ORDER BY attempt_id')
        .all(input.experimentId) as { attempt_id: string }[]).map(row => row.attempt_id)
      this.db.prepare(`
        UPDATE experiments SET lifecycle_state='ACTIVE',generation=generation+1,
          semantic_event_cursor=semantic_event_cursor+1,archive_freshness='STALE',outcome=NULL,
          settled_at=NULL,attempt_set_hash=?
        WHERE experiment_id=? AND lifecycle_state IN ('ACTIVE','SETTLED')
      `).run(hashCanonical({ schemaVersion: 'model-pk/attempt-set/v1', attemptIds }), input.experimentId)
      return this.finishAction(input.actionId, { attemptIds: input.attempts.map(attempt => attempt.attemptId) })
    })
  }

  // Kept optional internally to make createAttempt's immutable input ergonomic without widening the public contract.
  private experimentIdForRun(runId: UUID): UUID {
    const row = this.db.prepare('SELECT experiment_id FROM runs WHERE run_id=?').get(runId) as { experiment_id: string } | undefined
    if (row === undefined) fail('NOT_FOUND', 'retry', 'Run 不存在', `run missing ${runId}`)
    return row.experiment_id
  }

  transitionAttempt(attemptId: UUID, input: AttemptTransitionPatch): Attempt {
    return this.transaction(() => {
      const current = this.getAttemptRequired(attemptId)
      if (current.lifecycleVersion !== input.expectedVersion) {
        fail('ACTION_TARGET_STALE', 'lifecycle', 'Attempt 已变化，请刷新后重试', `expected version=${input.expectedVersion}; actual=${current.lifecycleVersion}`)
      }
      assertAttemptTransition(current.state, input.to)
      const next: Attempt = {
        ...current,
        ...input.patch,
        attemptId: current.attemptId,
        runId: current.runId,
        state: input.to,
        lifecycleVersion: current.lifecycleVersion + 1,
      }
      validateAttemptTerminalInvariant(next)
      const result = this.db.prepare(`
        UPDATE attempts SET state=$state,lifecycle_version=$nextVersion,dsh_session_id=$sessionId,
          dispatch_intent_id=$dispatchIntentId,finalization_id=$finalizationId,
          finalization_stage=$finalizationStage,reservation_state=$reservationState,body_json=$body,
          finalized_at=$finalizedAt
        WHERE attempt_id=$id AND lifecycle_version=$expectedVersion AND state=$expectedState
      `).run(bind({
        id: attemptId,
        state: next.state,
        nextVersion: next.lifecycleVersion,
        sessionId: next.dshSessionId,
        dispatchIntentId: next.dispatchIntentId,
        finalizationId: next.finalizationId,
        finalizationStage: next.finalizationStage,
        reservationState: next.executionReservationState,
        body: json(next),
        finalizedAt: next.finalizedAt,
        expectedVersion: input.expectedVersion,
        expectedState: current.state,
      }))
      if (Number(result.changes) !== 1) fail('ACTION_TARGET_STALE', 'lifecycle', 'Attempt 已变化，请刷新后重试', `attempt transition CAS lost ${attemptId}`)
      const experimentId = this.experimentIdForRun(next.runId)
      if (next.state === 'SUCCEEDED') {
        this.db.prepare('UPDATE runs SET last_successful_attempt_id=? WHERE run_id=?').run(attemptId, next.runId)
      }
      this.appendEventInTransaction(experimentId, attemptId, 'ATTEMPT_STATE_CHANGED', {
        from: current.state,
        to: next.state,
        lifecycleVersion: next.lifecycleVersion,
      }, new Date().toISOString())
      if (isTerminalAttemptState(next.state)) {
        this.releaseSlotForAttempt(attemptId, next.finalizedAt ?? new Date().toISOString())
        this.recomputeExperimentSettlement(experimentId)
      }
      return next
    })
  }

  updateAttemptProjection(attemptId: UUID, patch: Partial<Attempt>): Attempt {
    return this.transaction(() => {
      const current = this.getAttemptRequired(attemptId)
      const next: Attempt = {
        ...current,
        ...patch,
        attemptId: current.attemptId,
        runId: current.runId,
        state: current.state,
        lifecycleVersion: current.lifecycleVersion,
      }
      const result = this.db.prepare(`
        UPDATE attempts SET dsh_session_id=$sessionId,dispatch_intent_id=$dispatchIntentId,
          finalization_stage=$finalizationStage,reservation_state=$reservationState,body_json=$body
        WHERE attempt_id=$id AND lifecycle_version=$version AND state=$state
      `).run(bind({
        id: attemptId,
        sessionId: next.dshSessionId,
        dispatchIntentId: next.dispatchIntentId,
        finalizationStage: next.finalizationStage,
        reservationState: next.executionReservationState,
        body: json(next),
        version: current.lifecycleVersion,
        state: current.state,
      }))
      if (Number(result.changes) !== 1) {
        fail('ACTION_TARGET_STALE', 'lifecycle', 'Attempt 已变化，请刷新后重试', `attempt projection CAS lost ${attemptId}`)
      }
      return next
    })
  }

  claimReservation(attemptId: UUID, now: string, preparingDeadlineAt: string, releaseDeadline: string): Attempt {
    return this.transaction(() => {
      const current = this.getAttemptRequired(attemptId)
      if (current.state !== 'QUEUED' || current.executionReservationState !== 'NOT_ACQUIRED') {
        fail('ACTION_TARGET_STALE', 'scheduler', 'Attempt 已不在队列中', `reservation claim invalid state=${current.state}`)
      }
      return this.transitionAttempt(attemptId, {
        expectedVersion: current.lifecycleVersion,
        to: 'PREPARING',
        patch: {
          preparingAt: now,
          preparingDeadlineAt,
          reservationAcquiredAt: now,
          reservationReleaseDeadline: releaseDeadline,
          executionReservationState: 'HELD',
          lastProgressAt: now,
          workerHeartbeatAt: now,
        },
      })
    })
  }

  queuedAttempts(experimentId: UUID, limit: number): Attempt[] {
    const rows = this.db.prepare(`
      SELECT body_json FROM attempts WHERE experiment_id=? AND state='QUEUED' ORDER BY queue_seq LIMIT ?
    `).all(experimentId, limit) as unknown as DbAttemptRow[]
    return rows.map(row => normalizeAttempt(parse<Attempt>(row.body_json)))
  }

  heldReservationCount(experimentId: UUID): number {
    const row = this.db.prepare(`
      SELECT count(*) AS count FROM attempts WHERE experiment_id=? AND reservation_state='HELD'
    `).get(experimentId) as { count: number }
    return Number(row.count)
  }

  recoverableAttempts(): Attempt[] {
    const rows = this.db.prepare(`
      SELECT body_json FROM attempts
      WHERE state IN ('PREPARING','DISPATCHING','RUNNING','CANCELLING','RECOVERING','FINALIZING')
      ORDER BY queue_seq
    `).all() as unknown as DbAttemptRow[]
    return rows.map(row => normalizeAttempt(parse<Attempt>(row.body_json)))
  }

  attemptsInState(states: readonly AttemptState[]): Attempt[] {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT body_json FROM attempts WHERE state IN (${placeholders}) ORDER BY queue_seq`)
      .all(...states) as unknown as DbAttemptRow[]
    return rows.map(row => normalizeAttempt(parse<Attempt>(row.body_json)))
  }

  capacitySlotForAttempt(attemptId: UUID): { slotId: string; path: string; generation: number; byteLength: number } {
    const row = this.db.prepare(`
      SELECT c.slot_id,c.path,c.generation,c.byte_length
      FROM capacity_slots c JOIN attempts a ON a.control_slot_id=c.slot_id
      WHERE a.attempt_id=?
    `).get(attemptId) as { slot_id: string; path: string; generation: number; byte_length: number } | undefined
    if (row === undefined) fail('CONTROL_STORE_UNAVAILABLE', 'capacity', 'Attempt 控制 slot 不存在', `capacity slot missing attempt=${attemptId}`)
    return { slotId: row.slot_id, path: row.path, generation: row.generation, byteLength: row.byte_length }
  }

  commitCapacitySlot(slotId: string, generation: number, checksum: Hash, now = new Date().toISOString()): void {
    const result = this.db.prepare(`
      UPDATE capacity_slots SET generation=?,checksum=?,updated_at=?
      WHERE slot_id=? AND generation<? AND state='CLAIMED'
    `).run(generation, checksum, now, slotId, generation)
    if (Number(result.changes) !== 1) {
      fail('CONTROL_STORE_UNAVAILABLE', 'capacity', '控制 slot generation 提交失败', `slot=${slotId}; generation=${generation}`)
    }
  }

  addActionTarget(actionId: UUID, attemptId: UUID, expectedLifecycleVersion: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO action_targets(action_id,attempt_id,expected_lifecycle_version,result)
      VALUES(?,?,?,NULL)
    `).run(actionId, attemptId, expectedLifecycleVersion)
  }

  updateActionTarget(actionId: UUID, attemptId: UUID, result: string): void {
    this.db.prepare('UPDATE action_targets SET result=? WHERE action_id=? AND attempt_id=?')
      .run(result, actionId, attemptId)
  }

  allEventsThrough(experimentId: UUID, cursor: number): AuditEvent[] {
    return this.eventsAfter(experimentId, -1, Math.max(1000, cursor + 1)).filter(event => event.cursor <= cursor)
  }

  beginSealActivation(input: {
    experimentId: UUID
    expectedGeneration: number
    expectedSemanticCursor: number
    expectedAttemptSetHash: Hash
    activationId: UUID
  }): boolean {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE experiments SET seal_activation_id=?
        WHERE experiment_id=? AND lifecycle_state='SETTLED' AND generation=?
          AND semantic_event_cursor=? AND attempt_set_hash=? AND archive_freshness='STALE'
      `).run(input.activationId, input.experimentId, input.expectedGeneration, input.expectedSemanticCursor, input.expectedAttemptSetHash)
      if (Number(result.changes) !== 1) return false
      this.appendEventInTransaction(input.experimentId, null, 'SEAL_ACTIVATION_REGISTERED', {
        activationId: input.activationId,
        expectedGeneration: input.expectedGeneration,
        expectedSemanticCursor: input.expectedSemanticCursor,
      }, new Date().toISOString())
      return true
    })
  }

  finishSealActivation(input: {
    experimentId: UUID
    expectedGeneration: number
    expectedSemanticCursor: number
    expectedAttemptSetHash: Hash
    activationId: UUID
    archiveRevision: number
    indexHash: Hash
    integrity: 'COMPLETE' | 'PARTIAL' | 'INCOMPLETE'
  }): boolean {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE experiments SET archive_revision=?,latest_seal_hash=?,archive_freshness='CURRENT',
          archive_integrity=?,seal_activation_id=NULL
        WHERE experiment_id=? AND lifecycle_state='SETTLED' AND generation=?
          AND semantic_event_cursor=? AND attempt_set_hash=? AND seal_activation_id=?
      `).run(
        input.archiveRevision, input.indexHash, input.integrity, input.experimentId,
        input.expectedGeneration, input.expectedSemanticCursor, input.expectedAttemptSetHash, input.activationId,
      )
      if (Number(result.changes) !== 1) return false
      this.appendEventInTransaction(input.experimentId, null, 'SEAL_ACTIVATED', {
        activationId: input.activationId,
        archiveRevision: input.archiveRevision,
        indexHash: input.indexHash,
        integrity: input.integrity,
      }, new Date().toISOString())
      return true
    })
  }

  getAttempt(attemptId: UUID): Attempt | null {
    const row = this.db.prepare('SELECT body_json FROM attempts WHERE attempt_id=?').get(attemptId) as DbAttemptRow | undefined
    if (row === undefined) return null
    const attempt = parse<Attempt>(row.body_json)
    return normalizeAttempt(attempt)
  }

  getAttemptRequired(attemptId: UUID): Attempt {
    const attempt = this.getAttempt(attemptId)
    if (attempt === null) fail('NOT_FOUND', 'query', 'Attempt 不存在', `attempt missing ${attemptId}`)
    return attempt
  }

  getExperiment(experimentId: UUID): ExperimentProjection | null {
    const row = this.db.prepare('SELECT * FROM experiments WHERE experiment_id=?').get(experimentId) as DbExperimentRow | undefined
    if (row === undefined) return null
    const parsedExperiment = parse<Experiment>(row.body_json)
    const base = { ...parsedExperiment, resultPath: parsedExperiment.resultPath ?? null }
    const runRows = this.db.prepare('SELECT * FROM runs WHERE experiment_id=? ORDER BY ordinal').all(experimentId) as unknown as DbRunRow[]
    const runs: Run[] = runRows.map(runRow => {
      const runBase = parse<Run>(runRow.body_json)
      const attempts = (this.db.prepare('SELECT body_json FROM attempts WHERE run_id=? ORDER BY attempt_no').all(runRow.run_id) as unknown as DbAttemptRow[])
        .map(attemptRow => {
          const attempt = parse<Attempt>(attemptRow.body_json)
          return normalizeAttempt(attempt)
        })
      return {
        ...runBase,
        latestAttemptId: runRow.latest_attempt_id,
        lastSuccessfulAttemptId: runRow.last_successful_attempt_id,
        attemptCount: runRow.attempt_count,
        attempts,
      }
    })
    const latestAttempts = runs.map(run => run.attempts.find(item => item.attemptId === run.latestAttemptId)).filter(isPresent)
    const activeActions = (this.db.prepare("SELECT * FROM actions WHERE experiment_id=? AND state='PENDING' ORDER BY created_at")
      .all(experimentId) as unknown as DbActionRow[]).map(actionFromRow)
    const cursorRow = this.db.prepare('SELECT coalesce(max(cursor),0) AS cursor FROM audit_events WHERE experiment_id=?')
      .get(experimentId) as { cursor: number }
    return {
      ...base,
      lifecycleState: row.lifecycle_state,
      outcome: row.outcome,
      generation: row.generation,
      semanticEventCursor: row.semantic_event_cursor,
      auditSequence: row.audit_sequence,
      attemptSetHash: row.attempt_set_hash,
      archiveFreshness: row.archive_freshness,
      archiveIntegrity: row.archive_integrity,
      archiveRevision: row.archive_revision,
      latestSealHash: row.latest_seal_hash,
      settledAt: row.settled_at,
      runs,
      counts: deriveCounts(latestAttempts),
      latestCursor: Number(cursorRow.cursor),
      activeActions,
      recoveryNotice: latestAttempts.some(attempt => attempt.state === 'RECOVERING') ? '正在恢复中断的执行' : null,
    }
  }

  getExperimentRequired(experimentId: UUID): ExperimentProjection {
    const experiment = this.getExperiment(experimentId)
    if (experiment === null) fail('NOT_FOUND', 'query', 'Experiment 不存在', `experiment missing ${experimentId}`)
    return experiment
  }

  activeExperiment(): ExperimentProjection | null {
    const row = this.db.prepare("SELECT experiment_id FROM experiments WHERE lifecycle_state IN ('STARTING','ACTIVE') LIMIT 1")
      .get() as { experiment_id: string } | undefined
    return row === undefined ? null : this.getExperiment(row.experiment_id)
  }

  experimentsInState(states: readonly ExperimentLifecycle[]): ExperimentProjection[] {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT experiment_id FROM experiments WHERE lifecycle_state IN (${placeholders}) ORDER BY created_at`)
      .all(...states) as { experiment_id: string }[]
    return rows.map(row => this.getExperimentRequired(row.experiment_id))
  }

  listStorage(): StorageListItem[] {
    const rows = this.db.prepare(`
      SELECT experiment_id,lifecycle_state,outcome,body_json,experiment_path,created_at,settled_at
      FROM experiments WHERE lifecycle_state IN ('START_FAILED','SETTLED') ORDER BY created_at DESC
    `).all() as Pick<DbExperimentRow, 'experiment_id' | 'lifecycle_state' | 'outcome' | 'body_json' | 'experiment_path' | 'created_at' | 'settled_at'>[]
    return rows.map(row => {
      const parsedExperiment = parse<Experiment>(row.body_json)
      const base = { ...parsedExperiment, resultPath: parsedExperiment.resultPath ?? null }
      const action = this.db.prepare("SELECT 1 AS present FROM actions WHERE experiment_id=? AND state='PENDING' LIMIT 1")
        .get(row.experiment_id) as { present: number } | undefined
      const canDelete = row.lifecycle_state === 'SETTLED' && action === undefined
      return {
        experimentId: row.experiment_id,
        name: base.name,
        lifecycleState: row.lifecycle_state,
        outcome: row.outcome,
        createdAt: row.created_at,
        settledAt: row.settled_at,
        byteLength: 0,
        experimentPath: row.experiment_path,
        resultPath: base.resultPath,
        canDelete,
        blockedReason: canDelete ? null : '仅可删除已结束且没有进行中操作的实验',
      }
    })
  }

  appendEvent(
    experimentId: UUID,
    attemptId: UUID | null,
    kind: string,
    payload: Readonly<Record<string, unknown>>,
    occurredAt = new Date().toISOString(),
  ): AuditEvent {
    return this.transaction(() => this.appendEventInTransaction(experimentId, attemptId, kind, payload, occurredAt))
  }

  private appendEventInTransaction(
    experimentId: UUID,
    attemptId: UUID | null,
    kind: string,
    payload: Readonly<Record<string, unknown>>,
    occurredAt: string,
  ): AuditEvent {
    const result = this.db.prepare(`
      INSERT INTO audit_events(experiment_id,attempt_id,kind,payload_json,occurred_at)
      VALUES($experimentId,$attemptId,$kind,$payload,$occurredAt)
    `).run(bind({ experimentId, attemptId, kind, payload: json(payload), occurredAt }))
    const cursor = Number(result.lastInsertRowid)
    this.db.prepare('UPDATE experiments SET audit_sequence=audit_sequence+1 WHERE experiment_id=?').run(experimentId)
    const event: AuditEvent = { cursor, experimentId, attemptId, kind, payload, occurredAt }
    if (this.pendingEvents !== null) this.pendingEvents.push(event)
    else queueMicrotask(() => { for (const listener of this.listeners) listener(event) })
    return event
  }

  eventsAfter(experimentId: UUID, cursor: number, limit = 1000): AuditEvent[] {
    const rows = this.db.prepare(`
      SELECT cursor,experiment_id,attempt_id,kind,payload_json,occurred_at
      FROM audit_events WHERE experiment_id=? AND cursor>? ORDER BY cursor LIMIT ?
    `).all(experimentId, cursor, limit) as {
      cursor: number
      experiment_id: string
      attempt_id: string | null
      kind: string
      payload_json: string
      occurred_at: string
    }[]
    return rows.map(row => ({
      cursor: row.cursor,
      experimentId: row.experiment_id,
      attemptId: row.attempt_id,
      kind: row.kind,
      payload: parse<Record<string, unknown>>(row.payload_json),
      occurredAt: row.occurred_at,
    }))
  }

  private releaseSlotForAttempt(attemptId: UUID, now: string): void {
    this.db.prepare(`
      UPDATE capacity_slots SET state='FREE',owner_attempt_id=NULL,generation=generation+1,updated_at=?
      WHERE owner_attempt_id=?
    `).run(now, attemptId)
  }

  private recomputeExperimentSettlement(experimentId: UUID): void {
    const projection = this.getExperimentRequired(experimentId)
    const latestAttempts = projection.runs
      .map(run => run.attempts.find(attempt => attempt.attemptId === run.latestAttemptId))
      .filter(isPresent)
    if (latestAttempts.length !== projection.runs.length || latestAttempts.some(attempt => !isTerminalAttemptState(attempt.state))) return
    const outcome = deriveExperimentOutcome(projection.runs)
    const settledAt = new Date().toISOString()
    this.db.prepare(`
      UPDATE experiments SET lifecycle_state='SETTLED',outcome=?,settled_at=?,generation=generation+1,
        semantic_event_cursor=semantic_event_cursor+1,archive_freshness='STALE'
      WHERE experiment_id=? AND lifecycle_state='ACTIVE'
    `).run(outcome, settledAt, experimentId)
    this.appendEventInTransaction(experimentId, null, 'EXPERIMENT_SETTLED', { outcome }, settledAt)
  }

  deleteExperimentControlRows(experimentId: UUID, operationId: UUID, requestHash: Hash, receipt: Readonly<Record<string, unknown>>): void {
    this.transaction(() => {
      const experiment = this.getExperimentRequired(experimentId)
      const otherAction = this.db.prepare("SELECT action_id FROM actions WHERE experiment_id=? AND state='PENDING' AND action_id<>? LIMIT 1")
        .get(experimentId, operationId) as { action_id: string } | undefined
      if (experiment.lifecycleState !== 'SETTLED' || otherAction !== undefined) {
        fail('DELETE_NOT_ALLOWED', 'delete', '实验当前不可删除', `lifecycle=${experiment.lifecycleState}; otherAction=${otherAction?.action_id ?? 'none'}`)
      }
      const slotRows = this.db.prepare('SELECT control_slot_id FROM attempts WHERE experiment_id=?').all(experimentId) as { control_slot_id: string }[]
      this.db.prepare('DELETE FROM actions WHERE experiment_id=?').run(experimentId)
      this.db.prepare('DELETE FROM experiments WHERE experiment_id=?').run(experimentId)
      for (const row of slotRows) {
        this.db.prepare("UPDATE capacity_slots SET state='FREE',owner_attempt_id=NULL,generation=generation+1,updated_at=? WHERE slot_id=?")
          .run(new Date().toISOString(), row.control_slot_id)
      }
      this.db.prepare(`
        INSERT INTO deletion_receipts(operation_id,request_hash,experiment_id,deleted_at,receipt_json)
        VALUES(?,?,?,?,?)
      `).run(operationId, requestHash, experimentId, new Date().toISOString(), json(receipt))
    })
  }

  deletionReceipt(operationId: UUID): Readonly<Record<string, unknown>> | null {
    const row = this.db.prepare('SELECT receipt_json FROM deletion_receipts WHERE operation_id=?').get(operationId) as { receipt_json: string } | undefined
    return row === undefined ? null : parse(row.receipt_json)
  }
}

function bind(input: Record<string, unknown>): Bindings {
  const output: Bindings = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) throw new TypeError(`undefined SQL binding ${key}`)
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) {
      output[`$${key}`] = value
      continue
    }
    if (typeof value === 'boolean') {
      output[`$${key}`] = value ? 1 : 0
      continue
    }
    throw new TypeError(`unsupported SQL binding ${key}`)
  }
  return output
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}

function actionFromRow(row: DbActionRow): DurableAction {
  return {
    actionId: row.action_id,
    kind: row.kind,
    experimentId: row.experiment_id,
    requestHash: row.request_hash,
    state: row.state,
    result: row.result_json === null ? null : parse<Record<string, unknown>>(row.result_json),
    error: row.error_json === null ? null : parse<ModelPkError>(row.error_json),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function validateAttemptTerminalInvariant(attempt: Attempt): void {
  if (!isTerminalAttemptState(attempt.state)) return
  if (attempt.finalizedAt === null || attempt.finalizationId === null || attempt.finalizationStage !== 'CONTROL_COMMITTED') {
    fail('INTERNAL_ERROR', 'finalization', 'Attempt 收尾记录不完整', `terminal invariant failed attempt=${attempt.attemptId}`)
  }
  if (attempt.state !== 'SUCCEEDED' && attempt.state !== 'CANCELLED' && attempt.error === null) {
    fail('INTERNAL_ERROR', 'finalization', 'Attempt 错误记录不完整', `terminal error missing attempt=${attempt.attemptId}`)
  }
  if (attempt.state === 'SUCCEEDED' && attempt.archiveCompleteness !== 'COMPLETE') {
    fail('INTERNAL_ERROR', 'finalization', '成功结果归档不完整', `succeeded archive incomplete attempt=${attempt.attemptId}`)
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

function normalizeAttempt(attempt: Attempt): Attempt {
  return {
    ...attempt,
    resultPath: attempt.resultPath ?? null,
    resultExportError: attempt.resultExportError ?? null,
    workspaceSummary: attempt.workspaceSummary ?? null,
    tokenUsage: attempt.tokenUsage ?? null,
  }
}
