import { createHash, randomUUID } from "node:crypto";
import fs, { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
  toNamespacedPath,
} from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

import type {
  ArtifactCandidate,
  ArtifactIoStage,
  ArtifactManifest,
  ArtifactObservation,
  ArtifactResult,
  ArtifactWork,
  ArtifactWorkKey,
  ArtifactWorkRead,
} from "./artifacts.js";
import type { SubmissionLimits } from "./config.js";
import {
  EnhancementError,
  INTERNAL_SELF_TEST_KEY_PREFIX,
  isInternalSelfTestKey,
  parseReceiptRequest,
  requestFingerprint,
  type EnhancementPlanRequest,
  type FrozenEnhancementPlan,
} from "./contracts.js";
import {
  createClient,
  credentialDigestsMatch,
  type CredentialIdentity,
} from "./credentials.js";
import type { PreparedEngineInput } from "./image-io.js";
import {
  freezeDurableInterruptionRecords,
  freezeExecutionExit,
  freezeOwnerDescriptor,
  validIdentifier,
  type AttemptIdentity,
  type ActiveAttempt,
  type ClaimedAttempt,
  type DurableInterruptionRecords,
  type ExecutionExit,
  type ExecutionPolicy,
  type ExecutionStopRequest,
  type ExecutionTarget,
  type InterruptionEvidenceReader,
  type InterruptionReadScope,
  type OwnerDescriptor,
  type Inspection,
  type RecoveryControl,
  type RecoveryResolution,
  type RecoverySession,
  type RecoveryStop,
  type StartupRecoveryOutcome,
  type StopReason,
} from "./execution.js";

const principalBrand: unique symbol = Symbol("authenticated-client");
export type AuthenticatedClient = Readonly<{
  serviceId: string;
  clientId: string;
  credentialId: string;
  credentialVersion: number;
  [principalBrand]: true;
}>;
export type StoreMaintenanceCounts = Readonly<{
  queued: number;
  running: number;
  slots: number;
  unreleasedReferences: number;
}>;
export type SourceManifest = Omit<PreparedEngineInput["source"], "bytes">;
export type EngineManifest = Omit<PreparedEngineInput["engineInput"], "bytes">;
export type JobDto = Readonly<{
  serviceId: string;
  jobId: string;
  clientId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  reason:
    | "user_cancel"
    | "queue_timeout"
    | "execution_timeout"
    | "execution_failed"
    | "invalid_output"
    | null;
  result: ArtifactResult | null;
  cancelRequested: boolean;
  createdAt: number;
  queueDeadlineAt: number;
  completedAt: number | null;
  timings?: Readonly<{ workerQueueMs?: number; workerExecutionMs?: number }>;
  source: SourceManifest;
  engineInput: EngineManifest;
  plan: FrozenEnhancementPlan;
}>;
export type ResultReceipt = Readonly<{
  serviceId: string;
  jobId: string;
  clientId: string;
  receiptId: string;
  result: ArtifactResult;
  receivedAt: number;
}>;
export type ResultReceiptOutcome = Readonly<{
  receipt: ResultReceipt;
  applied: boolean;
}>;
export type ResultRetentionInspection = Readonly<{
  serviceId: string;
  jobId: string;
  state:
    "awaiting_receipt" | "retention_pending" | "reference_held" | "eligible";
  checkedAt: number;
  retentionMs: number;
  retainUntil: number;
  receivedAt: number | null;
  heldReferences: number;
}>;
export type ResultRetirement = Readonly<{
  serviceId: string;
  jobId: string;
  candidateId: string;
  attemptNo: number;
  retentionMs: number;
  retiredAt: number;
  cleanedAt: number | null;
}>;
export type ResultCleanupWork = Readonly<{
  retirement: ResultRetirement;
  directory: string;
  pngPath: string;
  manifestPath: string;
}>;
export type ResultRetirementOutcome = Readonly<
  | { kind: "blocked"; inspection: ResultRetentionInspection }
  | {
      kind: "retired";
      retirement: ResultRetirement;
      work: ResultCleanupWork | null;
    }
>;

export type StoredJob = Readonly<{
  job: JobDto;
  requestIdentity: string;
  executionPolicy: ExecutionPolicy;
}>;
export type AcceptedJob = Readonly<{ job: JobDto; replayed: boolean }>;
export type QueuedSelfTestInspection = Readonly<
  | { kind: "absent" }
  | { kind: "reusable"; idempotencyKey: string; job: JobDto }
  | { kind: "blocked"; jobId: string }
>;
export type CancelOutcome = Readonly<{
  job: JobDto;
  status: 200 | 202;
  applied: boolean;
}>;
type StoreOptions = Readonly<{
  directory: string;
  clock: () => number;
  interruptionEvidenceReader?: InterruptionEvidenceReader;
}>;
type CredentialRow = {
  client_id: string;
  credential_id: string;
  version: number;
  key_digest: string;
  revoked_at: number | null;
};
type JobRow = {
  job_id: string;
  client_id: string;
  idempotency_key: string;
  request_identity: string;
  status: JobDto["status"];
  reason: JobDto["reason"];
  created_at: number;
  queue_deadline_at: number;
  completed_at: number | null;
  result_candidate_id: string | null;
  source_json: string;
  engine_json: string;
  plan_json: string;
  execution_policy_json: string;
  queue_sequence: number;
  first_started_at: number | null;
  execution_deadline_at: number | null;
  active_attempt_no: number;
  current_fence: number;
  cancel_requested_at: number | null;
};
type ResultReceiptRow = {
  job_id: string;
  client_id: string;
  receipt_id: string;
  candidate_id: string;
  attempt_no: number;
  received_at: number;
};
type ResultRetirementRow = {
  job_id: string;
  candidate_id: string;
  attempt_no: number;
  retention_ms: number;
  retired_at: number;
  cleaned_at: number | null;
};
type ResultRetentionFacts = Readonly<{
  job: JobDto;
  attempt: AttemptRow;
  candidate: ArtifactCandidateRow;
  receipt: ResultReceiptRow | undefined;
}>;
type ResultCleanupPermit = Readonly<{
  principal: AuthenticatedClient;
  retirement: ResultRetirement;
}>;
type AttemptRow = {
  job_id: string;
  attempt_no: number;
  owner_instance_id: string;
  fence: number;
  lease_expires_at: number;
  producer_identity_json: string;
  producer_incarnation_id: string;
  launch_ticket: string;
  run_directory: string;
  tile: number;
  owner_descriptor_json: string | null;
  prepared_at: number | null;
  authorized_at: number | null;
  execution_deadline_at: number;
  stop_reason: StopReason | null;
  stop_requested_at: number | null;
  terminate_after_at: number | null;
  exit_json: string | null;
  exit_observed_at: number | null;
  sealed_at: number | null;
};
type RecoveryRow = {
  recovery_id: string;
  job_id: string;
  attempt_no: number;
  owner_instance_id: string;
  incarnation_id: string;
  source_incarnation_id: string;
  source_identity_json: string;
  publisher_identity_json: string;
  launch_ticket: string;
  state: "active" | "replaced" | "consumed";
  classification:
    | "inspecting"
    | "unknown"
    | "owned-alive"
    | "tree-exited"
    | "never-authorized";
  created_at: number;
  observed_at: number | null;
  consumed_at: number | null;
};
type RecoveryEventRow = {
  event_id: string;
  kind: "never-authorized" | "authorized-interruption";
  job_id: string;
  source_identity_json: string;
  launch_ticket: string;
  source_incarnation_id: string;
  recovery_incarnation_id: string;
  interrupted_at: number;
  sealed_at: number | null;
  evidence_json: string | null;
  consumed_publisher_identity_json: string | null;
  replacement_attempt_no: number | null;
  consumed_at: number | null;
};
type ArtifactCandidateRow = {
  candidate_id: string;
  job_id: string;
  attempt_no: number;
  producer_identity_json: string;
  launch_ticket: string;
  directory: string;
  manifest_json: string;
  manifest_sha256: string;
  manifest_byte_length: number;
  state: "intent" | "durable";
  created_at: number;
  durable_at: number | null;
};
type ArtifactReferenceRow = {
  reference_id: string;
  job_id: string;
  attempt_no: number;
  publisher_identity_json: string;
  incarnation_id: string;
  purpose: "run" | "recovery";
  candidate_id: string | null;
  acquired_at: number;
  released_at: number | null;
};
type ArtifactObservationRow = {
  reference_id: string;
  observation_no: number;
  candidate_id: string | null;
  code: ArtifactObservation["code"];
  stage: ArtifactIoStage | null;
  checked_engine_sha256: string | null;
  observed_at: number;
};
type InterruptedRecoveryFacts = Readonly<{
  row: AttemptRow;
  job: JobRow;
  recovery: RecoveryRow;
  scope: InterruptionReadScope;
  exit: ExecutionExit;
}>;
type InterruptedRestartFacts = InterruptedRecoveryFacts &
  Readonly<{
    reference: ArtifactReferenceRow;
  }>;
type AuthorizedInterruptionEventEvidence = Readonly<{
  v: 1;
  recoveryId: string;
  referenceId: string;
  records: DurableInterruptionRecords;
}>;

const artifactIoStages = new Set<ArtifactIoStage>([
  "open",
  "stat",
  "read",
  "mkdir",
  "write",
  "file_sync",
  "close",
  "rename",
  "directory_sync",
  "acquire_commit",
  "reserve_commit",
  "candidate_commit",
  "success_commit",
  "observation_commit",
  "release_commit",
]);

function artifactIdentity(value: AttemptIdentity): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    validIdentifier(value.jobId) &&
    validIdentifier(value.ownerInstanceId) &&
    Number.isSafeInteger(value.attemptNo) &&
    value.attemptNo > 0 &&
    Number.isSafeInteger(value.fence) &&
    value.fence > 0 &&
    Object.keys(value).length === 4
  );
}

function artifactTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stopRequestSnapshot(value: ExecutionStopRequest) {
  if (!value) return;
  const request = {
    mode: value.mode,
    stopRequestedAt: value.stopRequestedAt,
    terminateAfterAt: value.terminateAfterAt,
  };
  if (
    (request.mode !== "soft" && request.mode !== "force") ||
    !artifactTime(request.stopRequestedAt) ||
    !artifactTime(request.terminateAfterAt) ||
    request.terminateAfterAt < request.stopRequestedAt
  )
    return;
  return request;
}

function artifactDigest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function safe<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof EnhancementError) throw error;
    throw new EnhancementError("internal_error");
  }
}

function addTime(now: number, duration: number) {
  const value = now + duration;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new EnhancementError("configuration_invalid");
  return value;
}

class Store {
  readonly identity: Readonly<{ serviceId: string }>;
  readonly inputDirectory: string;
  readonly #database: Database.Database;
  readonly #clock: () => number;
  readonly #attemptDirectory: string;
  readonly #incarnationId: string;
  readonly #interruptionEvidenceReader: InterruptionEvidenceReader | undefined;
  readonly #principals = new WeakSet<object>();
  readonly #resultCleanupWorks = new WeakMap<
    ResultCleanupWork,
    ResultCleanupPermit
  >();
  #resultChangeActive = false;
  #closed = false;

  constructor(
    database: Database.Database,
    options: StoreOptions,
    serviceId: string,
    incarnationId: string,
  ) {
    this.#database = database;
    this.#clock = options.clock;
    this.inputDirectory = join(options.directory, "inputs");
    this.#attemptDirectory = join(options.directory, "attempts");
    this.#incarnationId = incarnationId;
    this.#interruptionEvidenceReader = options.interruptionEvidenceReader;
    this.identity = Object.freeze({ serviceId });
  }

  get durability() {
    return safe(() => {
      if (
        this.#database.pragma("synchronous", { simple: true }) !== 2 ||
        this.#database.pragma("locking_mode", { simple: true }) !==
          "exclusive" ||
        this.#database.pragma("journal_mode", { simple: true }) !== "delete"
      )
        throw new EnhancementError("configuration_invalid");
      return Object.freeze({
        synchronous: "full" as const,
        lockingMode: "exclusive" as const,
        journalMode: "delete" as const,
      });
    });
  }

  close() {
    this.#closed = true;
    if (this.#database.open) this.#database.close();
  }

  get closed() {
    return this.#closed;
  }

  inspectMaintenance(): StoreMaintenanceCounts {
    return safe(() => {
      if (this.#closed || this.#database.inTransaction)
        throw new EnhancementError("internal_error");
      return this.#database
        .transaction(() => {
          const row = this.#database
            .prepare(
              `
            SELECT
              (SELECT COUNT(*) FROM jobs WHERE status = 'queued') AS queued,
              (SELECT COUNT(*) FROM jobs WHERE status = 'running') AS running,
              (SELECT COUNT(*) FROM execution_slot) AS slots,
              (SELECT COUNT(*) FROM artifact_references WHERE released_at IS NULL) AS unreleasedReferences
          `,
            )
            .get() as StoreMaintenanceCounts | undefined;
          if (!row) throw new EnhancementError("internal_error");
          const counts = {
            queued: row.queued,
            running: row.running,
            slots: row.slots,
            unreleasedReferences: row.unreleasedReferences,
          };
          if (
            Object.values(counts).some(
              (value) => !Number.isSafeInteger(value) || value < 0,
            ) ||
            counts.slots > 1
          )
            throw new EnhancementError("internal_error");
          return Object.freeze(counts);
        })
        .deferred();
    });
  }

  async restartInterruptedAttempt(
    key: ArtifactWorkKey,
    signal: AbortSignal,
  ): Promise<StartupRecoveryOutcome | undefined> {
    if (this.#closed || signal.aborted) return;
    if (
      !key ||
      !artifactIdentity(key.publisher) ||
      !validIdentifier(key.referenceId) ||
      Reflect.ownKeys(key).length !== 2
    )
      return;
    const ownedKey = freezeTree({
      publisher: { ...key.publisher },
      referenceId: key.referenceId,
    });
    const replay = safe(() => this.#replayInterruptedAttempt(ownedKey));
    if (replay) return replay;
    const reader = this.#interruptionEvidenceReader;
    if (!reader) return;
    const original = safe(() => this.#interruptedRestartFacts(ownedKey));
    if (!original) return;
    const stillCurrent = (): boolean => {
      if (this.#closed || signal.aborted) return false;
      try {
        return !!this.#interruptedRestartFacts(ownedKey, original);
      } catch {
        return false;
      }
    };
    if (!stillCurrent()) return;
    let supplied: DurableInterruptionRecords | undefined;
    try {
      supplied = await reader(original.scope, stillCurrent);
    } catch {
      // Missing or unknown evidence never creates an event. A concurrent,
      // already committed use of this exact key can only be queried.
      if (this.#closed || signal.aborted) return;
      return safe(() => this.#replayInterruptedAttempt(ownedKey));
    }
    if (this.#closed || signal.aborted) return;
    const applied = safe(() => this.#replayInterruptedAttempt(ownedKey));
    if (applied) return applied;
    if (!supplied || !stillCurrent()) return;
    let records: DurableInterruptionRecords;
    try {
      records = freezeDurableInterruptionRecords(supplied, original.scope);
    } catch {
      return;
    }
    if (!this.#interruptionIdsMatch(original.exit, records)) return;
    if (this.#closed || signal.aborted) return;
    try {
      return safe(() =>
        this.#database
          .transaction(() => {
            if (this.#closed || signal.aborted) return;
            const applied = this.#replayInterruptedAttempt(ownedKey);
            if (applied) return applied;
            const current = this.#interruptedRestartFacts(ownedKey, original);
            if (!current || !this.#interruptionIdsMatch(current.exit, records))
              return;
            const { row, job, recovery, reference } = current;
            if (
              this.#database
                .prepare(
                  "SELECT 1 FROM recovery_events WHERE job_id = ? AND launch_ticket = ?",
                )
                .get(row.job_id, row.launch_ticket)
            )
              return;
            const now = this.now();
            if (now > row.lease_expires_at || now > row.execution_deadline_at)
              return;
            const attemptNo = addTime(job.active_attempt_no, 1);
            const fence = addTime(job.current_fence, 1);
            const identity: AttemptIdentity = {
              jobId: row.job_id,
              attemptNo,
              ownerInstanceId: ownedKey.publisher.ownerInstanceId,
              fence,
            };
            const leaseExpiresAt = addTime(
              now,
              (JSON.parse(job.execution_policy_json) as ExecutionPolicy).limits
                .leaseDurationMs,
            );
            const eventId = randomUUID();
            const evidence: AuthorizedInterruptionEventEvidence = {
              v: 1,
              recoveryId: recovery.recovery_id,
              referenceId: reference.reference_id,
              records,
            };
            const evidenceJson = JSON.stringify(evidence);
            this.#database
              .prepare(
                `
          INSERT INTO recovery_events (event_id, kind, job_id, source_identity_json,
            launch_ticket, source_incarnation_id, recovery_incarnation_id,
            interrupted_at, sealed_at, evidence_json)
          VALUES (?, 'authorized-interruption', ?, ?, ?, ?, ?, ?, NULL, ?)
        `,
              )
              .run(
                eventId,
                row.job_id,
                row.producer_identity_json,
                row.launch_ticket,
                row.producer_incarnation_id,
                recovery.incarnation_id,
                now,
                evidenceJson,
              );
            this.#insertRecoveryReplacement(row, identity, leaseExpiresAt);
            const jobMoved = this.#database
              .prepare(
                "UPDATE jobs SET active_attempt_no = ?, current_fence = ? WHERE job_id = ? AND status = 'running' AND active_attempt_no = ? AND current_fence = ? AND cancel_requested_at IS NULL",
              )
              .run(
                attemptNo,
                fence,
                row.job_id,
                row.attempt_no,
                row.fence,
              ).changes;
            const slotMoved = this.#moveRecoverySlot(row, identity);
            const consumed = this.#database
              .prepare(
                `
          UPDATE recovery_events SET consumed_publisher_identity_json = ?, replacement_attempt_no = ?, consumed_at = ?
          WHERE event_id = ? AND job_id = ? AND kind = 'authorized-interruption'
            AND evidence_json = ? AND sealed_at IS NULL AND consumed_at IS NULL
        `,
              )
              .run(
                JSON.stringify(ownedKey.publisher),
                attemptNo,
                now,
                eventId,
                row.job_id,
                evidenceJson,
              ).changes;
            // All artifact and reader handles have completed before this entry.
            // End only this exact ref; the terminal helper would delete the slot.
            const released = this.#database
              .prepare(
                `
          UPDATE artifact_references SET released_at = ?
          WHERE reference_id = ? AND incarnation_id = ? AND job_id = ? AND attempt_no = ?
            AND publisher_identity_json = ? AND purpose = 'recovery' AND candidate_id IS ?
            AND released_at IS NULL
        `,
              )
              .run(
                now,
                reference.reference_id,
                this.#incarnationId,
                row.job_id,
                row.attempt_no,
                reference.publisher_identity_json,
                reference.candidate_id,
              ).changes;
            if (
              jobMoved !== 1 ||
              slotMoved !== 1 ||
              consumed !== 1 ||
              released !== 1
            )
              throw new EnhancementError("internal_error");
            const attempt = this.getActiveAttempt(identity);
            if (!attempt) throw new EnhancementError("internal_error");
            return freezeTree({ kind: "created" as const, attempt });
          })
          .immediate(),
      );
    } catch (error) {
      // A thrown COMMIT is unknown until the same historical facts prove it.
      // This clarification never enters the creation path a second time.
      if (this.#closed || signal.aborted) return;
      try {
        const applied = this.#replayInterruptedAttempt(ownedKey);
        if (applied) return applied;
      } catch {
        /* preserve the original transaction uncertainty */
      }
      throw error;
    }
  }

  now() {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new EnhancementError("configuration_invalid");
    return value;
  }

  issueCredential(
    keyDigest: string,
    options?: Readonly<{ clientId: string; revokeCredentialId?: string }>,
    principal?: AuthenticatedClient,
  ): CredentialIdentity {
    return safe(() => {
      // Finish the external clock before an online write owns its transaction.
      let checkedNow: number | undefined;
      if (principal !== undefined) {
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
        this.assertPrincipal(principal);
        checkedNow = this.now();
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
      }
      return this.#database
        .transaction(() => {
          const now = checkedNow ?? this.now();
          const clientId = options?.clientId ?? randomUUID();
          const revokeCredentialId = options?.revokeCredentialId;
          if (principal !== undefined) {
            if (this.#closed) throw new EnhancementError("internal_error");
            this.assertPrincipal(principal);
            if (
              clientId !== principal.clientId ||
              revokeCredentialId !== undefined
            )
              throw new EnhancementError("invalid_request");
          }
          if (!options) {
            this.#database
              .prepare(
                "INSERT INTO clients (client_id, created_at) VALUES (?, ?)",
              )
              .run(clientId, now);
          } else if (
            !this.#database
              .prepare("SELECT 1 FROM clients WHERE client_id = ?")
              .get(clientId)
          ) {
            throw new EnhancementError("invalid_request");
          }
          if (revokeCredentialId) {
            const revoked = this.#database
              .prepare(
                "UPDATE credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE client_id = ? AND credential_id = ?",
              )
              .run(now, clientId, revokeCredentialId);
            if (revoked.changes !== 1)
              throw new EnhancementError("invalid_request");
          }
          const row = this.#database
            .prepare(
              "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM credentials WHERE client_id = ?",
            )
            .get(clientId) as { next_version: number };
          const credentialId = randomUUID();
          this.#database
            .prepare(
              "INSERT INTO credentials (credential_id, client_id, version, key_digest, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(credentialId, clientId, row.next_version, keyDigest, now);
          return Object.freeze({
            clientId,
            credentialId,
            version: row.next_version,
          });
        })
        .immediate();
    });
  }

  revokeCredential(credentialId: string, principal?: AuthenticatedClient) {
    safe(() => {
      if (principal !== undefined) {
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
        this.assertPrincipal(principal);
      }
      const update = this.#database.prepare(
        "UPDATE credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE credential_id = ?",
      );
      const now = this.now();
      if (principal !== undefined) {
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
        this.assertPrincipal(principal);
        if (credentialId !== principal.credentialId)
          throw new EnhancementError("invalid_request");
      }
      const result = update.run(now, credentialId);
      if (result.changes !== 1) throw new EnhancementError("invalid_request");
    });
  }

  authenticateDigest(candidateDigest: string): AuthenticatedClient {
    return safe(() => {
      const row = this.#database
        .prepare(
          "SELECT client_id, credential_id, version, key_digest, revoked_at FROM credentials WHERE key_digest = ?",
        )
        .get(candidateDigest) as CredentialRow | undefined;
      const matched = credentialDigestsMatch(candidateDigest, row?.key_digest);
      if (!matched || !row || row.revoked_at !== null)
        throw new EnhancementError("authentication_failed");
      const principal: AuthenticatedClient = Object.freeze({
        serviceId: this.identity.serviceId,
        clientId: row.client_id,
        credentialId: row.credential_id,
        credentialVersion: row.version,
        [principalBrand]: true as const,
      });
      this.#principals.add(principal);
      return principal;
    });
  }

  assertPrincipal(principal: AuthenticatedClient) {
    safe(() => {
      if (
        !principal ||
        typeof principal !== "object" ||
        !this.#principals.has(principal)
      )
        throw new EnhancementError("authentication_failed");
      const active = this.#database
        .prepare(
          "SELECT 1 FROM credentials WHERE credential_id = ? AND client_id = ? AND version = ? AND revoked_at IS NULL",
        )
        .get(
          principal.credentialId,
          principal.clientId,
          principal.credentialVersion,
        );
      if (!active) throw new EnhancementError("authentication_failed");
    });
  }

  #fromRow(row: JobRow): StoredJob {
    const timings: { workerQueueMs?: number; workerExecutionMs?: number } = {};
    if (
      artifactTime(row.created_at) &&
      artifactTime(row.first_started_at) &&
      row.first_started_at >= row.created_at
    )
      timings.workerQueueMs = row.first_started_at - row.created_at;
    const attempt = row.active_attempt_no > 0
      ? this.#database
          .prepare("SELECT authorized_at, exit_observed_at FROM attempts WHERE job_id = ? AND attempt_no = ?")
          .get(row.job_id, row.active_attempt_no) as Pick<AttemptRow, "authorized_at" | "exit_observed_at"> | undefined
      : undefined;
    if (
      attempt &&
      artifactTime(attempt.authorized_at) &&
      artifactTime(attempt.exit_observed_at) &&
      attempt.exit_observed_at >= attempt.authorized_at
    )
      timings.workerExecutionMs = attempt.exit_observed_at - attempt.authorized_at;
    return freezeTree({
      requestIdentity: row.request_identity,
      executionPolicy: JSON.parse(row.execution_policy_json) as ExecutionPolicy,
      job: {
        serviceId: this.identity.serviceId,
        jobId: row.job_id,
        clientId: row.client_id,
        status: row.status,
        reason: row.reason,
        result: row.status === "succeeded" ? this.#result(row) : null,
        cancelRequested: row.cancel_requested_at !== null,
        createdAt: row.created_at,
        queueDeadlineAt: row.queue_deadline_at,
        completedAt: row.completed_at,
        ...(Object.keys(timings).length ? { timings } : {}),
        source: JSON.parse(row.source_json) as SourceManifest,
        engineInput: JSON.parse(row.engine_json) as EngineManifest,
        plan: JSON.parse(row.plan_json) as FrozenEnhancementPlan,
      },
    });
  }

  findByKey(principal: AuthenticatedClient, key: string) {
    return safe(() => {
      this.assertPrincipal(principal);
      const row = this.#database
        .prepare(
          "SELECT * FROM jobs WHERE client_id = ? AND idempotency_key = ?",
        )
        .get(principal.clientId, key) as JobRow | undefined;
      return row ? this.#fromRow(row) : undefined;
    });
  }

  inspectQueuedSelfTest(
    principal: AuthenticatedClient,
    expected: Readonly<{
      request: EnhancementPlanRequest;
      plan: FrozenEnhancementPlan;
      executionPolicy: ExecutionPolicy;
      source: SourceManifest;
    }>,
  ): QueuedSelfTestInspection {
    return safe(() => {
      const assertAvailable = () => {
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
      };
      const plainRecord = (value: unknown) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;

      assertAvailable();
      this.assertPrincipal(principal);
      if (
        !plainRecord(expected) ||
        Reflect.ownKeys(expected).length !== 4 ||
        !["request", "plan", "executionPolicy", "source"].every((key) =>
          Object.hasOwn(expected, key),
        )
      )
        throw new EnhancementError("invalid_request");
      const { request, plan, executionPolicy, source } = expected;
      if (![request, plan, executionPolicy, source].every(plainRecord))
        throw new EnhancementError("invalid_request");

      assertAvailable();
      const checkedAt = this.now();
      assertAvailable();
      this.assertPrincipal(principal);
      assertAvailable();
      const inspection = this.#database
        .transaction((): QueuedSelfTestInspection => {
          const rows = this.#database
            .prepare(
              `SELECT * FROM jobs
               WHERE client_id = ? AND instr(idempotency_key, ?) = 1 AND status = 'queued'
               ORDER BY created_at, queue_sequence LIMIT 2`,
            )
            .all(principal.clientId, INTERNAL_SELF_TEST_KEY_PREFIX) as JobRow[];
          const row = rows[0];
          if (!row) return { kind: "absent" };
          const blocked = { kind: "blocked" as const, jobId: row.job_id };
          if (
            rows.length !== 1 ||
            !isInternalSelfTestKey(row.idempotency_key) ||
            row.first_started_at !== null ||
            row.execution_deadline_at !== null ||
            row.active_attempt_no !== 0 ||
            row.current_fence !== 0 ||
            row.cancel_requested_at !== null ||
            row.completed_at !== null ||
            row.result_candidate_id !== null ||
            !(row.queue_deadline_at >= checkedAt) ||
            this.#database
              .prepare("SELECT 1 FROM attempts WHERE job_id = ? LIMIT 1")
              .get(row.job_id) !== undefined
          )
            return blocked;

          // Materialize getters before deep equality can retry a failed read.
          const comparison = structuredClone({
            request,
            plan,
            executionPolicy,
            source,
          });
          const stored = this.#fromRow(row);
          if (
            !Object.hasOwn(comparison.request, "tile") ||
            comparison.request.tile !== comparison.plan.engine.tile ||
            comparison.request.protocolVersion !==
              comparison.plan.protocolVersion ||
            comparison.request.scope !== comparison.plan.scope ||
            comparison.request.sourceSha256 !== comparison.plan.sourceSha256 ||
            comparison.request.sourceSha256 !== comparison.source.sha256 ||
            comparison.request.modelId !== comparison.plan.engine.modelId ||
            comparison.request.normalizationProfile !==
              comparison.plan.normalizationProfile ||
            !isDeepStrictEqual(
              comparison.request.target,
              comparison.plan.target,
            ) ||
            stored.requestIdentity !==
              requestFingerprint(
                comparison.request,
                comparison.plan.engine.tile,
              ) ||
            !isDeepStrictEqual(stored.job.plan, comparison.plan) ||
            !isDeepStrictEqual(
              stored.executionPolicy,
              comparison.executionPolicy,
            ) ||
            !isDeepStrictEqual(stored.job.source, comparison.source)
          )
            return blocked;
          return {
            kind: "reusable",
            idempotencyKey: row.idempotency_key,
            job: stored.job,
          };
        })
        .deferred();
      const result = freezeTree(inspection);
      // Expected getters may reenter; publish only after the read transaction ends.
      assertAvailable();
      this.assertPrincipal(principal);
      assertAvailable();
      return result;
    });
  }

  matchReplay(
    existing: StoredJob,
    request: EnhancementPlanRequest,
  ): AcceptedJob {
    if (
      existing.requestIdentity !==
      requestFingerprint(request, existing.job.plan.engine.tile)
    )
      throw new EnhancementError("idempotency_conflict");
    return Object.freeze({ job: existing.job, replayed: true });
  }

  acceptQueued(
    principal: AuthenticatedClient,
    idempotencyKey: string,
    request: EnhancementPlanRequest,
    candidate: JobDto,
    executionPolicy: ExecutionPolicy,
    limits: SubmissionLimits,
    ready: boolean,
  ): AcceptedJob {
    return safe(() =>
      this.#database
        .transaction(() => {
          this.assertPrincipal(principal);
          const existing = this.findByKey(principal, idempotencyKey);
          if (existing) return this.matchReplay(existing, request);
          this.#expireQueued(this.now());
          if (!ready) throw new EnhancementError("not_ready");
          const { count } = this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'",
            )
            .get() as { count: number };
          if (count >= limits.maxWaitingJobs)
            throw new EnhancementError("queue_full");
          const inserted = this.#database
            .prepare(
              `INSERT INTO jobs (
        job_id, client_id, idempotency_key, request_identity, status, reason,
        created_at, queue_deadline_at, completed_at, source_json, engine_json, plan_json,
        execution_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              candidate.jobId,
              principal.clientId,
              idempotencyKey,
              requestFingerprint(request, candidate.plan.engine.tile),
              candidate.status,
              candidate.reason,
              candidate.createdAt,
              candidate.queueDeadlineAt,
              candidate.completedAt,
              JSON.stringify(candidate.source),
              JSON.stringify(candidate.engineInput),
              JSON.stringify(candidate.plan),
              JSON.stringify(executionPolicy),
            );
          if (!Number.isSafeInteger(Number(inserted.lastInsertRowid)))
            throw new EnhancementError("configuration_invalid");
          return Object.freeze({ job: candidate, replayed: false });
        })
        .immediate(),
    );
  }

  acknowledgeResult(
    principal: AuthenticatedClient,
    jobId: string,
    value: unknown,
    signal?: AbortSignal,
  ): ResultReceiptOutcome {
    return safe(() => {
      if (this.#closed || this.#database.inTransaction)
        throw new EnhancementError("internal_error");
      const assertAvailable = () => {
        if (this.#closed) throw new EnhancementError("internal_error");
        if (signal?.aborted) throw new EnhancementError("invalid_request");
      };
      assertAvailable();
      const input = parseReceiptRequest(value);
      const now = this.now();
      assertAvailable();
      if (this.#database.inTransaction)
        throw new EnhancementError("internal_error");
      return this.#database
        .transaction(() => {
          assertAvailable();
          const job = this.getOwned(principal, jobId);
          if (job.status !== "succeeded")
            throw new EnhancementError("result_not_ready");
          const publisher = this.getPublishedResultPublisher(principal, jobId);
          const attempt = this.#publishedArtifactAttempt(publisher);
          if (!attempt || !job.result)
            throw new EnhancementError("internal_error");
          const candidate = this.#publishedCandidate(attempt);
          const result = job.result;
          if (
            input.serviceId !== this.identity.serviceId ||
            input.result.format !== result.format ||
            input.result.width !== result.width ||
            input.result.height !== result.height ||
            input.result.sha256 !== result.sha256 ||
            input.result.byteLength !== result.byteLength
          )
            throw new EnhancementError("receipt_conflict");
          const existing = this.#database
            .prepare("SELECT * FROM result_receipts WHERE job_id = ?")
            .get(jobId) as ResultReceiptRow | undefined;
          if (
            existing &&
            (existing.client_id !== principal.clientId ||
              existing.receipt_id !== input.receiptId ||
              existing.candidate_id !== candidate.candidate_id ||
              existing.attempt_no !== attempt.attempt_no)
          )
            throw new EnhancementError("receipt_conflict");
          if (existing && !artifactTime(existing.received_at))
            throw new EnhancementError("internal_error");
          if (
            !existing &&
            this.#database
              .prepare(
                "SELECT 1 FROM result_receipts WHERE client_id = ? AND receipt_id = ?",
              )
              .get(principal.clientId, input.receiptId)
          )
            throw new EnhancementError("receipt_conflict");
          assertAvailable();
          this.assertPrincipal(principal);
          if (!existing) {
            this.#database
              .prepare(
                `
          INSERT INTO result_receipts
            (job_id, client_id, receipt_id, candidate_id, attempt_no, received_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
              )
              .run(
                jobId,
                principal.clientId,
                input.receiptId,
                candidate.candidate_id,
                attempt.attempt_no,
                now,
              );
          }
          return freezeTree({
            receipt: {
              serviceId: this.identity.serviceId,
              jobId,
              clientId: principal.clientId,
              receiptId: input.receiptId,
              result,
              receivedAt: existing?.received_at ?? now,
            },
            applied: !existing,
          });
        })
        .immediate();
    });
  }

  inspectResultRetention(
    principal: AuthenticatedClient,
    jobId: string,
    retentionMs: number,
    signal?: AbortSignal,
  ): ResultRetentionInspection {
    return safe(() => {
      const assertAvailable = () => {
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
        const aborted = signal?.aborted;
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
        if (aborted) throw new EnhancementError("invalid_request");
      };
      assertAvailable();
      if (
        typeof retentionMs !== "number" ||
        !Number.isSafeInteger(retentionMs) ||
        retentionMs <= 0
      )
        throw new EnhancementError("invalid_request");
      const checkedAt = this.now();
      assertAvailable();
      this.assertPrincipal(principal);
      if (this.#closed || this.#database.inTransaction)
        throw new EnhancementError("internal_error");
      return this.#database
        .transaction(() => {
          return this.#resultRetentionInspection(
            this.#resultRetentionFacts(principal, jobId),
            retentionMs,
            checkedAt,
          );
        })
        .deferred();
    });
  }

  retireResult(
    principal: AuthenticatedClient,
    jobId: string,
    retentionMs: number,
    signal?: AbortSignal,
  ): ResultRetirementOutcome {
    return safe(() => {
      if (this.#resultChangeActive)
        throw new EnhancementError("internal_error");
      this.#resultChangeActive = true;
      try {
        this.#assertResultAvailable(signal);
        if (
          typeof retentionMs !== "number" ||
          !Number.isSafeInteger(retentionMs) ||
          retentionMs <= 0
        )
          throw new EnhancementError("invalid_request");
        const now = this.now();
        this.#assertResultAvailable(signal);
        this.assertPrincipal(principal);
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
        const outcome = this.#database
          .transaction(() => {
            const facts = this.#resultRetentionFacts(principal, jobId);
            const existing = this.#resultRetirement(facts);
            if (existing)
              return {
                kind: "retired" as const,
                retirement: existing,
                work: null,
              };
            const inspection = this.#resultRetentionInspection(
              facts,
              retentionMs,
              now,
            );
            if (inspection.state !== "eligible")
              return { kind: "blocked" as const, inspection };
            const inserted = this.#database
              .prepare(
                `INSERT INTO result_retirements
                  (job_id, candidate_id, attempt_no, retention_ms, retired_at, cleaned_at)
                 VALUES (?, ?, ?, ?, ?, NULL)`,
              )
              .run(
                jobId,
                facts.candidate.candidate_id,
                facts.attempt.attempt_no,
                retentionMs,
                now,
              );
            if (inserted.changes !== 1)
              throw new EnhancementError("internal_error");
            const retirement = this.#resultRetirement(facts);
            if (!retirement) throw new EnhancementError("internal_error");
            return {
              kind: "created" as const,
              retirement,
              candidate: this.#artifactCandidate(
                facts.candidate,
                facts.attempt,
              ),
            };
          })
          .immediate();
        if (outcome.kind !== "created") return freezeTree(outcome);
        // No capability exists until this first top-level COMMIT returned.
        // A thrown COMMIT only propagates through safe; it is never replayed.
        const work = freezeTree({
          retirement: outcome.retirement,
          directory: outcome.candidate.directory,
          pngPath: outcome.candidate.pngPath,
          manifestPath: outcome.candidate.manifestPath,
        });
        this.#resultCleanupWorks.set(
          work,
          Object.freeze({ principal, retirement: outcome.retirement }),
        );
        return freezeTree({
          kind: "retired" as const,
          retirement: outcome.retirement,
          work,
        });
      } finally {
        this.#resultChangeActive = false;
      }
    });
  }

  readResultRetirement(
    principal: AuthenticatedClient,
    jobId: string,
    signal?: AbortSignal,
  ): ResultRetirement | null {
    return safe(() => {
      this.#assertResultAvailable(signal);
      this.assertPrincipal(principal);
      if (this.#closed || this.#database.inTransaction)
        throw new EnhancementError("internal_error");
      return this.#database
        .transaction(() =>
          this.#resultRetirement(this.#resultRetentionFacts(principal, jobId)),
        )
        .deferred();
    });
  }

  assertResultCleanupWork(work: ResultCleanupWork, signal?: AbortSignal): void {
    safe(() => {
      this.#assertResultAvailable(signal);
      this.#checkedResultCleanupWork(work);
    });
  }

  completeResultCleanup(
    work: ResultCleanupWork,
    signal?: AbortSignal,
  ): ResultRetirement {
    return safe(() => {
      if (this.#resultChangeActive)
        throw new EnhancementError("internal_error");
      this.#resultChangeActive = true;
      try {
        this.#assertResultAvailable(signal);
        // A foreign/copied/revoked work is rejected before any clock callback.
        const existing = this.#checkedResultCleanupWork(work);
        if (existing.cleanedAt !== null) return existing;
        const now = this.now();
        this.#assertResultAvailable(signal);
        const permit = this.#resultCleanupWorks.get(work);
        if (!permit) throw new EnhancementError("invalid_request");
        this.assertPrincipal(permit.principal);
        if (this.#closed || this.#database.inTransaction)
          throw new EnhancementError("internal_error");
        return this.#database
          .transaction(() => {
            const retirement = this.#checkedResultCleanupWork(work);
            if (retirement.cleanedAt !== null) return retirement;
            if (now < retirement.retiredAt)
              throw new EnhancementError("invalid_request");
            const updated = this.#database
              .prepare(
                `UPDATE result_retirements SET cleaned_at = ?
                 WHERE job_id = ? AND candidate_id = ? AND attempt_no = ?
                   AND retention_ms = ? AND retired_at = ? AND cleaned_at IS NULL`,
              )
              .run(
                now,
                retirement.jobId,
                retirement.candidateId,
                retirement.attemptNo,
                retirement.retentionMs,
                retirement.retiredAt,
              );
            if (updated.changes !== 1)
              throw new EnhancementError("internal_error");
            return this.#checkedResultCleanupWork(work);
          })
          .immediate();
      } finally {
        this.#resultChangeActive = false;
      }
    });
  }

  #assertResultAvailable(signal?: AbortSignal) {
    if (this.#closed || this.#database.inTransaction)
      throw new EnhancementError("internal_error");
    const aborted = signal?.aborted;
    if (this.#closed || this.#database.inTransaction)
      throw new EnhancementError("internal_error");
    if (aborted) throw new EnhancementError("invalid_request");
  }

  #resultRetentionFacts(
    principal: AuthenticatedClient,
    jobId: string,
  ): ResultRetentionFacts {
    const job = this.getOwned(principal, jobId);
    if (job.status !== "succeeded")
      throw new EnhancementError("result_not_ready");
    const publisher = this.getPublishedResultPublisher(principal, jobId);
    const attempt = this.#publishedArtifactAttempt(publisher);
    if (!attempt || !job.result || !artifactTime(job.completedAt))
      throw new EnhancementError("internal_error");
    const candidate = this.#publishedCandidate(attempt);
    return {
      job,
      attempt,
      candidate,
      receipt: this.#resultReceipt(job, attempt, candidate),
    };
  }

  #resultReceipt(
    job: JobDto,
    attempt: AttemptRow,
    candidate: ArtifactCandidateRow,
  ): ResultReceiptRow | undefined {
    const receipt = this.#database
      .prepare("SELECT * FROM result_receipts WHERE job_id = ?")
      .get(job.jobId) as ResultReceiptRow | undefined;
    if (
      receipt &&
      (receipt.client_id !== job.clientId ||
        receipt.candidate_id !== candidate.candidate_id ||
        receipt.attempt_no !== attempt.attempt_no ||
        !artifactTime(receipt.received_at))
    )
      throw new EnhancementError("internal_error");
    return receipt;
  }

  #resultHeldReferences(jobId: string, attemptNo: number): number {
    const references = this.#database
      .prepare(
        `SELECT COUNT(*) AS held_references FROM artifact_references
         WHERE job_id = ? AND attempt_no = ? AND released_at IS NULL`,
      )
      .get(jobId, attemptNo) as { held_references: number };
    if (
      !Number.isSafeInteger(references.held_references) ||
      references.held_references < 0
    )
      throw new EnhancementError("internal_error");
    return references.held_references;
  }

  #resultRetentionInspection(
    facts: ResultRetentionFacts,
    retentionMs: number,
    checkedAt: number,
  ): ResultRetentionInspection {
    const { job, attempt, receipt } = facts;
    const retainUntil = job.completedAt! + retentionMs;
    if (!Number.isSafeInteger(retainUntil))
      throw new EnhancementError("invalid_request");
    const heldReferences = this.#resultHeldReferences(
      job.jobId,
      attempt.attempt_no,
    );
    let state: ResultRetentionInspection["state"] = "eligible";
    if (!receipt) state = "awaiting_receipt";
    else if (checkedAt < retainUntil || checkedAt < receipt.received_at)
      state = "retention_pending";
    else if (heldReferences > 0) state = "reference_held";
    return Object.freeze({
      serviceId: this.identity.serviceId,
      jobId: job.jobId,
      state,
      checkedAt,
      retentionMs,
      retainUntil,
      receivedAt: receipt?.received_at ?? null,
      heldReferences,
    });
  }

  #resultRetirement(
    facts: ResultRetentionFacts,
    row = this.#database
      .prepare("SELECT * FROM result_retirements WHERE job_id = ?")
      .get(facts.job.jobId) as ResultRetirementRow | undefined,
  ): ResultRetirement | null {
    if (!row) return null;
    const retainUntil = facts.job.completedAt! + row.retention_ms;
    if (
      !facts.receipt ||
      row.job_id !== facts.job.jobId ||
      row.candidate_id !== facts.candidate.candidate_id ||
      row.attempt_no !== facts.attempt.attempt_no ||
      !Number.isSafeInteger(row.retention_ms) ||
      row.retention_ms <= 0 ||
      !Number.isSafeInteger(retainUntil) ||
      !artifactTime(row.retired_at) ||
      row.retired_at < retainUntil ||
      row.retired_at < facts.receipt.received_at ||
      (row.cleaned_at !== null &&
        (!artifactTime(row.cleaned_at) || row.cleaned_at < row.retired_at))
    )
      throw new EnhancementError("internal_error");
    return Object.freeze({
      serviceId: this.identity.serviceId,
      jobId: row.job_id,
      candidateId: row.candidate_id,
      attemptNo: row.attempt_no,
      retentionMs: row.retention_ms,
      retiredAt: row.retired_at,
      cleanedAt: row.cleaned_at,
    });
  }

  #checkedResultCleanupWork(work: ResultCleanupWork): ResultRetirement {
    const permit = this.#resultCleanupWorks.get(work);
    if (!permit) throw new EnhancementError("invalid_request");
    const facts = this.#resultRetentionFacts(
      permit.principal,
      permit.retirement.jobId,
    );
    const retirement = this.#resultRetirement(facts);
    const candidate = this.#artifactCandidate(facts.candidate, facts.attempt);
    if (
      !retirement ||
      !isDeepStrictEqual(
        { ...retirement, cleanedAt: null },
        permit.retirement,
      ) ||
      work.directory !== candidate.directory ||
      work.pngPath !== candidate.pngPath ||
      work.manifestPath !== candidate.manifestPath ||
      this.#resultHeldReferences(facts.job.jobId, facts.attempt.attempt_no) !==
        0
    )
      throw new EnhancementError("internal_error");
    return retirement;
  }

  getPublishedResultPublisher(
    principal: AuthenticatedClient,
    jobId: string,
  ): AttemptIdentity {
    if (this.#closed) throw new EnhancementError("internal_error");
    return safe(() => {
      const job = this.getOwned(principal, jobId);
      if (job.status !== "succeeded")
        throw new EnhancementError("result_not_ready");
      const row = this.#database
        .prepare(
          `
        SELECT a.*, j.execution_deadline_at FROM attempts a JOIN jobs j ON j.job_id = a.job_id
        WHERE j.job_id = ? AND j.status = 'succeeded'
          AND j.active_attempt_no = a.attempt_no AND j.current_fence = a.fence
      `,
        )
        .get(jobId) as AttemptRow | undefined;
      if (!row) throw new EnhancementError("internal_error");
      const publisher = this.#publisher(row);
      const qualified = this.#publishedArtifactAttempt(publisher);
      if (!qualified) throw new EnhancementError("internal_error");
      this.#publishedCandidate(qualified);
      return Object.freeze(publisher);
    });
  }

  getOwned(principal: AuthenticatedClient, jobId: string): JobDto {
    return safe(() => {
      this.assertPrincipal(principal);
      const row = this.#database
        .prepare("SELECT * FROM jobs WHERE client_id = ? AND job_id = ?")
        .get(principal.clientId, jobId) as JobRow | undefined;
      if (!row) throw new EnhancementError("job_not_found");
      return this.#fromRow(row).job;
    });
  }

  requestCancel(principal: AuthenticatedClient, jobId: string): CancelOutcome {
    return safe(() =>
      this.#database
        .transaction(() => {
          const job = this.getOwned(principal, jobId);
          if (job.status !== "queued" && job.status !== "running")
            return Object.freeze({ job, status: 200 as const, applied: false });
          if (job.cancelRequested)
            return Object.freeze({ job, status: 202 as const, applied: false });
          const now = this.now();
          if (job.status === "queued") {
            this.#database
              .prepare(
                "UPDATE jobs SET status = 'cancelled', reason = 'user_cancel', completed_at = ?, cancel_requested_at = ? WHERE job_id = ? AND client_id = ? AND status = 'queued'",
              )
              .run(now, now, jobId, principal.clientId);
          } else {
            // This authenticated command records intent even when the owner lease expired.
            // It grants no execution authority to that owner.
            const row = this.#database
              .prepare(
                `
          SELECT a.*, j.execution_deadline_at FROM attempts a
          JOIN jobs j ON j.job_id = a.job_id AND j.active_attempt_no = a.attempt_no AND j.current_fence = a.fence
          JOIN execution_slot s ON s.job_id = a.job_id AND s.attempt_no = a.attempt_no AND s.fence = a.fence
          WHERE j.job_id = ? AND j.status = 'running'
        `,
              )
              .get(jobId) as AttemptRow | undefined;
            if (!row) throw new EnhancementError("internal_error");
            this.#persistStop(row, "user_cancel", now);
            this.#database
              .prepare(
                "UPDATE jobs SET cancel_requested_at = ? WHERE job_id = ? AND client_id = ? AND status = 'running' AND cancel_requested_at IS NULL",
              )
              .run(now, jobId, principal.clientId);
          }
          return Object.freeze({
            job: this.getOwned(principal, jobId),
            status: job.status === "running" ? (202 as const) : (200 as const),
            applied: true,
          });
        })
        .immediate(),
    );
  }

  getActiveAttempt(identity: AttemptIdentity): ActiveAttempt | undefined {
    return safe(() => {
      const row = this.#readAttempt(identity);
      if (!row) return;
      return this.#projectAttempt(row);
    });
  }

  canPrepareAttempt(identity: AttemptIdentity, launchTicket: string): boolean {
    if (this.#closed) return false;
    return safe(() =>
      this.#database
        .transaction(() => {
          const row = this.#currentAttempt(identity);
          return Boolean(
            !this.#closed &&
            row &&
            row.launch_ticket === launchTicket &&
            row.owner_descriptor_json === null &&
            row.prepared_at === null &&
            row.authorized_at === null,
          );
        })
        .deferred(),
    );
  }

  canAuthorizeLaunch(
    identity: AttemptIdentity,
    launchTicket: string,
    descriptor: OwnerDescriptor,
  ): boolean {
    if (this.#closed) return false;
    return safe(() => {
      // Validation may synchronously reenter the store. It precedes the final
      // current-row reads, which are the authority for this permission snapshot.
      const owner = freezeOwnerDescriptor(descriptor, launchTicket);
      return this.#database
        .transaction(() => {
          const row = this.#currentAttempt(identity);
          return Boolean(
            !this.#closed &&
            row &&
            row.launch_ticket === launchTicket &&
            row.prepared_at !== null &&
            row.authorized_at !== null &&
            row.owner_descriptor_json !== null &&
            isDeepStrictEqual(JSON.parse(row.owner_descriptor_json), owner),
          );
        })
        .deferred();
    });
  }

  canRequestStop(
    target: ExecutionTarget,
    descriptor: OwnerDescriptor,
    request: ExecutionStopRequest,
  ): boolean {
    if (this.#closed) return false;
    return safe(() => {
      // Finish reentrant argument/clock callbacks before the final authority reads.
      if (!target) return false;
      const identity = { ...target.identity };
      const launchTicket = target.launchTicket;
      const stop = stopRequestSnapshot(request);
      if (
        !artifactIdentity(identity) ||
        !validIdentifier(launchTicket) ||
        !stop
      )
        return false;
      const owner = freezeOwnerDescriptor(descriptor, launchTicket);
      if (this.#closed) return false;
      const now = this.now();
      if (this.#closed) return false;
      return this.#database
        .transaction(() => {
          const row = this.#writableAttempt(identity);
          return Boolean(
            row &&
            row.launch_ticket === launchTicket &&
            now <= row.lease_expires_at &&
            this.#permitsStop(row, owner, stop, now),
          );
        })
        .deferred();
    });
  }

  canRequestRecoveryStop(
    control: RecoveryControl,
    stop: RecoveryStop,
  ): boolean {
    if (this.#closed) return false;
    return safe(() => {
      if (!control || !stop?.target) return false;
      const bound = {
        ...control,
        source: { ...control.source },
        publisher: { ...control.publisher },
      };
      const identity = { ...stop.target.identity };
      const launchTicket = stop.target.launchTicket;
      const request = stopRequestSnapshot(stop);
      if (
        !artifactIdentity(identity) ||
        !validIdentifier(launchTicket) ||
        !request
      )
        return false;
      const owner = freezeOwnerDescriptor(stop.descriptor, launchTicket);
      if (this.#closed) return false;
      const now = this.now();
      if (this.#closed) return false;
      return this.#database
        .transaction(() => {
          const facts = this.#recovery(bound);
          return Boolean(
            facts &&
            facts.recovery.classification === "owned-alive" &&
            facts.row.launch_ticket === launchTicket &&
            isDeepStrictEqual(
              JSON.parse(facts.row.producer_identity_json),
              identity,
            ) &&
            this.#permitsStop(facts.row, owner, request, now),
          );
        })
        .deferred();
    });
  }

  #permitsStop(
    row: AttemptRow,
    owner: OwnerDescriptor,
    request: ExecutionStopRequest,
    now: number,
  ) {
    return (
      row.prepared_at !== null &&
      row.authorized_at !== null &&
      row.stop_reason !== null &&
      row.stop_requested_at === request.stopRequestedAt &&
      row.terminate_after_at === request.terminateAfterAt &&
      row.sealed_at === null &&
      row.exit_json === null &&
      row.owner_descriptor_json !== null &&
      isDeepStrictEqual(JSON.parse(row.owner_descriptor_json), owner) &&
      (request.mode === "soft" || now > request.terminateAfterAt)
    );
  }

  #projectAttempt(row: AttemptRow): ActiveAttempt {
    const job = this.#database
      .prepare("SELECT * FROM jobs WHERE job_id = ?")
      .get(row.job_id) as JobRow;
    const stored = this.#fromRow(job);
    const workingDirectory = join(this.#attemptDirectory, row.run_directory);
    return freezeTree({
      identity: {
        jobId: row.job_id,
        attemptNo: row.attempt_no,
        ownerInstanceId: row.owner_instance_id,
        fence: row.fence,
      },
      producer: JSON.parse(row.producer_identity_json) as AttemptIdentity,
      job: stored.job,
      executionPolicy: stored.executionPolicy,
      firstStartedAt: job.first_started_at!,
      executionDeadlineAt: row.execution_deadline_at,
      leaseExpiresAt: row.lease_expires_at,
      launchTicket: row.launch_ticket,
      inputPath: join(this.inputDirectory, row.job_id, "engine.png"),
      workingDirectory,
      outputPath: join(workingDirectory, "output.part.png"),
      tile: row.tile,
      ownerDescriptor:
        row.owner_descriptor_json === null
          ? null
          : (JSON.parse(row.owner_descriptor_json) as OwnerDescriptor),
      preparedAt: row.prepared_at,
      authorizedAt: row.authorized_at,
      stopReason: row.stop_reason,
      stopRequestedAt: row.stop_requested_at,
      terminateAfterAt: row.terminate_after_at,
      exit:
        row.exit_json === null
          ? null
          : (JSON.parse(row.exit_json) as ExecutionExit),
    });
  }

  #publisher(row: AttemptRow): AttemptIdentity {
    return {
      jobId: row.job_id,
      attemptNo: row.attempt_no,
      ownerInstanceId: row.owner_instance_id,
      fence: row.fence,
    };
  }

  #slot(): AttemptRow | undefined {
    const slot = this.#database
      .prepare(
        "SELECT job_id, attempt_no, fence FROM execution_slot WHERE singleton = 1",
      )
      .get() as
      { job_id: string; attempt_no: number; fence: number } | undefined;
    if (!slot) {
      if (
        this.#database
          .prepare("SELECT 1 FROM jobs WHERE status = 'running'")
          .get()
      )
        throw new EnhancementError("internal_error");
      return;
    }
    const row = this.#database
      .prepare(
        `
      SELECT a.*, j.execution_deadline_at FROM execution_slot s
      JOIN attempts a ON a.job_id = s.job_id AND a.attempt_no = s.attempt_no AND a.fence = s.fence
      JOIN jobs j ON j.job_id = a.job_id AND j.active_attempt_no = a.attempt_no AND j.current_fence = a.fence
      WHERE s.singleton = 1 AND j.status = 'running'
        AND j.first_started_at IS NOT NULL AND j.execution_deadline_at IS NOT NULL
    `,
      )
      .get() as AttemptRow | undefined;
    if (!row) throw new EnhancementError("internal_error");
    const source = JSON.parse(row.producer_identity_json) as AttemptIdentity;
    if (source.jobId !== row.job_id || source.attemptNo !== row.attempt_no)
      throw new EnhancementError("internal_error");
    return row;
  }

  #control(row: RecoveryRow): RecoveryControl {
    return {
      recoveryId: row.recovery_id,
      ownerInstanceId: row.owner_instance_id,
      source: JSON.parse(row.source_identity_json) as AttemptIdentity,
      publisher: JSON.parse(row.publisher_identity_json) as AttemptIdentity,
      launchTicket: row.launch_ticket,
    };
  }

  #session(control: RecoveryControl, row: AttemptRow): RecoverySession {
    const active = this.getActiveAttempt(this.#publisher(row));
    if (!active) throw new EnhancementError("internal_error");
    const queued = this.#database
      .prepare(
        "SELECT MIN(queue_deadline_at) AS deadline FROM jobs WHERE status = 'queued'",
      )
      .get() as { deadline: number | null };
    return freezeTree({
      control,
      active,
      target: { identity: active.producer, launchTicket: active.launchTicket },
      nextQueueDeadlineAt: queued.deadline,
    });
  }

  #recovery(control: RecoveryControl) {
    if (!control || !validIdentifier(control.recoveryId)) return;
    const recovery = this.#database
      .prepare(
        "SELECT * FROM recovery_controls WHERE recovery_id = ? AND state = 'active'",
      )
      .get(control.recoveryId) as RecoveryRow | undefined;
    if (
      !recovery ||
      recovery.incarnation_id !== this.#incarnationId ||
      !isDeepStrictEqual(this.#control(recovery), control)
    )
      return;
    const row = this.#slot();
    if (
      !row ||
      row.job_id !== recovery.job_id ||
      row.attempt_no !== recovery.attempt_no ||
      row.launch_ticket !== recovery.launch_ticket ||
      row.producer_incarnation_id !== recovery.source_incarnation_id ||
      !isDeepStrictEqual(
        JSON.parse(row.producer_identity_json),
        control.source,
      ) ||
      !isDeepStrictEqual(this.#publisher(row), control.publisher)
    )
      return;
    return { row, recovery };
  }

  #recoveryFacts(row: AttemptRow, now: number): AttemptRow {
    if (row.stop_reason === null && now > row.execution_deadline_at) {
      this.#persistStop(row, "execution_timeout", now);
      const latest = this.#readAttempt(this.#publisher(row));
      if (!latest) throw new EnhancementError("internal_error");
      return latest;
    }
    return row;
  }

  beginRecovery(
    ownerInstanceId: string,
    expectedControl?: RecoveryControl,
  ): RecoverySession | undefined {
    return safe(() =>
      this.#database
        .transaction(() => {
          if (!validIdentifier(ownerInstanceId))
            throw new EnhancementError("configuration_invalid");
          if (expectedControl !== undefined) {
            if (
              !expectedControl ||
              expectedControl.ownerInstanceId !== ownerInstanceId
            )
              return;
            const bound = this.#recovery(expectedControl);
            if (!bound) return;
            const now = this.now();
            this.#expireQueued(now);
            return this.#session(
              expectedControl,
              this.#recoveryFacts(bound.row, now),
            );
          }
          const now = this.now();
          this.#expireQueued(now);
          const occupied = this.#slot();
          if (!occupied) return;
          const row = this.#recoveryFacts(occupied, now);
          const publisher = this.#publisher(row);
          const source = JSON.parse(
            row.producer_identity_json,
          ) as AttemptIdentity;
          const previous = this.#database
            .prepare(
              "SELECT * FROM recovery_controls WHERE job_id = ? AND attempt_no = ? AND state = 'active'",
            )
            .get(row.job_id, row.attempt_no) as RecoveryRow | undefined;
          if (
            previous &&
            previous.incarnation_id === this.#incarnationId &&
            previous.owner_instance_id === ownerInstanceId &&
            previous.launch_ticket === row.launch_ticket &&
            previous.source_incarnation_id === row.producer_incarnation_id &&
            isDeepStrictEqual(
              JSON.parse(previous.source_identity_json),
              source,
            ) &&
            isDeepStrictEqual(
              JSON.parse(previous.publisher_identity_json),
              publisher,
            )
          )
            return this.#session(this.#control(previous), row);
          if (previous)
            this.#database
              .prepare(
                "UPDATE recovery_controls SET state = 'replaced' WHERE recovery_id = ? AND state = 'active'",
              )
              .run(previous.recovery_id);
          const control: RecoveryControl = {
            recoveryId: randomUUID(),
            ownerInstanceId,
            source,
            publisher,
            launchTicket: row.launch_ticket,
          };
          this.#database
            .prepare(
              `
        INSERT INTO recovery_controls (recovery_id, job_id, attempt_no, owner_instance_id,
          incarnation_id, source_incarnation_id, source_identity_json, publisher_identity_json,
          launch_ticket, state, classification, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'inspecting', ?)
      `,
            )
            .run(
              control.recoveryId,
              row.job_id,
              row.attempt_no,
              ownerInstanceId,
              this.#incarnationId,
              row.producer_incarnation_id,
              JSON.stringify(source),
              JSON.stringify(publisher),
              row.launch_ticket,
              now,
            );
          return this.#session(control, row);
        })
        .immediate(),
    );
  }

  applyRecoveryInspection(
    control: RecoveryControl,
    inspection: Inspection,
  ): RecoveryResolution | undefined {
    return safe(() =>
      this.#database
        .transaction(() => {
          const facts = this.#recovery(control);
          if (!facts) return;
          if (
            !inspection ||
            ![
              "unknown",
              "owned-alive",
              "tree-exited",
              "never-authorized",
            ].includes(inspection.kind)
          )
            return;
          let { row } = facts;
          const { recovery } = facts;
          const source = JSON.parse(
            row.producer_identity_json,
          ) as AttemptIdentity;
          let terminal: ExecutionExit | undefined;
          if (inspection.kind === "tree-exited") {
            terminal = this.#exitEvidence(row, inspection.exit);
            if (!terminal) return;
            if (row.exit_json !== null) {
              const previous = JSON.parse(row.exit_json) as ExecutionExit;
              if (previous.completion !== undefined) {
                if (!isDeepStrictEqual(previous, terminal)) return;
              } else {
                // Only same-source inspection may enrich a classification-free
                // terminal; the original execution facts cannot change.
                const { completion: _completion, ...facts } = terminal;
                if (!isDeepStrictEqual(previous, facts)) return;
              }
            }
          } else {
            if (
              inspection.launchTicket !== row.launch_ticket ||
              !isDeepStrictEqual(inspection.identity, source)
            )
              return;
            if (
              inspection.kind === "owned-alive" &&
              (row.authorized_at === null ||
                row.owner_descriptor_json === null ||
                row.exit_json !== null ||
                row.sealed_at !== null ||
                !isDeepStrictEqual(
                  inspection.descriptor,
                  JSON.parse(row.owner_descriptor_json),
                ))
            )
              return;
            if (
              inspection.kind === "never-authorized" &&
              row.authorized_at !== null
            )
              return;
          }
          const now = this.now();
          this.#expireQueued(now);
          row = this.#recoveryFacts(row, now);
          if (
            inspection.kind === "unknown" ||
            inspection.kind === "owned-alive"
          ) {
            this.#database
              .prepare(
                "UPDATE recovery_controls SET classification = ?, observed_at = ? WHERE recovery_id = ? AND state = 'active'",
              )
              .run(inspection.kind, now, recovery.recovery_id);
            return freezeTree({
              kind: inspection.kind,
              session: this.#session(control, row),
            });
          }
          const publisher: AttemptIdentity = {
            ...this.#publisher(row),
            ownerInstanceId: control.ownerInstanceId,
            fence: addTime(row.fence, 1),
          };
          const leaseExpiresAt = addTime(
            now,
            this.#policy(row.job_id).limits.leaseDurationMs,
          );
          const sealedAt =
            inspection.kind === "never-authorized"
              ? (row.sealed_at ?? now)
              : null;
          const exit = terminal ? JSON.stringify(terminal) : null;
          const moved = this.#database
            .prepare(
              `
        UPDATE attempts SET owner_instance_id = ?, fence = ?, lease_expires_at = ?,
          exit_json = ?, exit_observed_at = ?, sealed_at = ?
        WHERE job_id = ? AND attempt_no = ? AND owner_instance_id = ? AND fence = ?
      `,
            )
            .run(
              publisher.ownerInstanceId,
              publisher.fence,
              leaseExpiresAt,
              exit,
              exit === null ? null : (row.exit_observed_at ?? now),
              sealedAt,
              row.job_id,
              row.attempt_no,
              row.owner_instance_id,
              row.fence,
            ).changes;
          const jobMoved = this.#database
            .prepare(
              "UPDATE jobs SET current_fence = ? WHERE job_id = ? AND status = 'running' AND active_attempt_no = ? AND current_fence = ?",
            )
            .run(
              publisher.fence,
              row.job_id,
              row.attempt_no,
              row.fence,
            ).changes;
          const consumed = this.#database
            .prepare(
              `
        UPDATE recovery_controls SET state = 'consumed', classification = ?, observed_at = ?, consumed_at = ?
        WHERE recovery_id = ? AND state = 'active'
      `,
            )
            .run(inspection.kind, now, now, recovery.recovery_id).changes;
          if (moved !== 1 || jobMoved !== 1 || consumed !== 1)
            throw new EnhancementError("internal_error");
          let startupEventId: string | null = null;
          if (
            inspection.kind === "never-authorized" &&
            recovery.source_incarnation_id !== recovery.incarnation_id &&
            row.stop_reason === null &&
            now <= row.execution_deadline_at
          ) {
            const job = this.#database
              .prepare("SELECT * FROM jobs WHERE job_id = ?")
              .get(row.job_id) as JobRow;
            if (job.cancel_requested_at === null) {
              const existing = this.#database
                .prepare(
                  "SELECT * FROM recovery_events WHERE job_id = ? AND launch_ticket = ?",
                )
                .get(row.job_id, row.launch_ticket) as
                RecoveryEventRow | undefined;
              if (existing) {
                if (
                  existing.kind !== "never-authorized" ||
                  existing.evidence_json !== null ||
                  !isDeepStrictEqual(
                    JSON.parse(existing.source_identity_json),
                    source,
                  ) ||
                  existing.source_incarnation_id !==
                    row.producer_incarnation_id ||
                  existing.sealed_at !== sealedAt
                )
                  throw new EnhancementError("internal_error");
                if (existing.consumed_at === null)
                  startupEventId = existing.event_id;
              } else {
                startupEventId = randomUUID();
                this.#database
                  .prepare(
                    `
              INSERT INTO recovery_events (event_id, kind, job_id, source_identity_json, launch_ticket,
                source_incarnation_id, recovery_incarnation_id, interrupted_at, sealed_at, evidence_json)
              VALUES (?, 'never-authorized', ?, ?, ?, ?, ?, ?, ?, NULL)
            `,
                  )
                  .run(
                    startupEventId,
                    row.job_id,
                    JSON.stringify(source),
                    row.launch_ticket,
                    row.producer_incarnation_id,
                    recovery.incarnation_id,
                    recovery.created_at,
                    sealedAt,
                  );
              }
            }
          }
          return freezeTree({
            kind: "transferred" as const,
            publisher,
            startupEventId,
          });
        })
        .immediate(),
    );
  }

  prepareRecoveryStop(
    control: RecoveryControl,
    mode: "soft" | "force",
  ): RecoveryStop | undefined {
    return safe(() =>
      this.#database
        .transaction(() => {
          if (mode !== "soft" && mode !== "force") return;
          const facts = this.#recovery(control);
          if (!facts || facts.recovery.classification !== "owned-alive") return;
          const now = this.now();
          const row = this.#recoveryFacts(facts.row, now);
          if (
            row.stop_reason === null ||
            row.stop_requested_at === null ||
            row.terminate_after_at === null ||
            row.authorized_at === null ||
            row.owner_descriptor_json === null ||
            row.exit_json !== null ||
            row.sealed_at !== null ||
            (mode === "force" && now <= row.terminate_after_at)
          )
            return;
          return freezeTree({
            target: {
              identity: JSON.parse(
                row.producer_identity_json,
              ) as AttemptIdentity,
              launchTicket: row.launch_ticket,
            },
            descriptor: JSON.parse(
              row.owner_descriptor_json,
            ) as OwnerDescriptor,
            mode,
            stopRequestedAt: row.stop_requested_at,
            terminateAfterAt: row.terminate_after_at,
          });
        })
        .immediate(),
    );
  }

  restartSealedAttempt(
    publisher: AttemptIdentity,
    eventId: string,
  ): StartupRecoveryOutcome | undefined {
    return safe(() =>
      this.#database
        .transaction(() => {
          const event = this.#database
            .prepare(
              "SELECT * FROM recovery_events WHERE job_id = ? AND event_id = ?",
            )
            .get(publisher.jobId, eventId) as RecoveryEventRow | undefined;
          if (
            !event ||
            event.kind !== "never-authorized" ||
            event.evidence_json !== null ||
            event.sealed_at === null
          )
            return;
          // A replay names the publisher that consumed this event, even after its
          // replacement has become the current slot or the store has reopened.
          if (event.consumed_at !== null) {
            if (
              !isDeepStrictEqual(
                JSON.parse(event.consumed_publisher_identity_json!),
                publisher,
              )
            )
              return;
            return freezeTree({
              kind: "already-applied" as const,
              replacementAttemptNo: event.replacement_attempt_no!,
            });
          }
          const row = this.#writableAttempt(publisher);
          if (
            !row ||
            row.authorized_at !== null ||
            row.sealed_at === null ||
            row.exit_json !== null ||
            row.launch_ticket !== event.launch_ticket ||
            row.sealed_at !== event.sealed_at ||
            row.producer_incarnation_id !== event.source_incarnation_id ||
            event.source_incarnation_id === event.recovery_incarnation_id ||
            !isDeepStrictEqual(
              JSON.parse(row.producer_identity_json),
              JSON.parse(event.source_identity_json),
            )
          )
            return;
          const job = this.#database
            .prepare("SELECT * FROM jobs WHERE job_id = ?")
            .get(row.job_id) as JobRow;
          const now = this.now();
          if (
            row.stop_reason !== null ||
            job.cancel_requested_at !== null ||
            now > row.lease_expires_at ||
            now > row.execution_deadline_at
          )
            return;
          const attemptNo = addTime(job.active_attempt_no, 1);
          const fence = addTime(job.current_fence, 1);
          const identity: AttemptIdentity = {
            jobId: row.job_id,
            attemptNo,
            ownerInstanceId: publisher.ownerInstanceId,
            fence,
          };
          const leaseExpiresAt = addTime(
            now,
            this.#policy(row.job_id).limits.leaseDurationMs,
          );
          this.#insertRecoveryReplacement(row, identity, leaseExpiresAt);
          const jobMoved = this.#database
            .prepare(
              "UPDATE jobs SET active_attempt_no = ?, current_fence = ? WHERE job_id = ? AND status = 'running' AND active_attempt_no = ? AND current_fence = ?",
            )
            .run(
              attemptNo,
              fence,
              row.job_id,
              row.attempt_no,
              row.fence,
            ).changes;
          const slotMoved = this.#moveRecoverySlot(row, identity);
          const consumed = this.#database
            .prepare(
              `
        UPDATE recovery_events SET consumed_publisher_identity_json = ?, replacement_attempt_no = ?, consumed_at = ?
        WHERE job_id = ? AND event_id = ? AND kind = 'never-authorized'
          AND evidence_json IS NULL AND sealed_at IS NOT NULL AND consumed_at IS NULL
      `,
            )
            .run(
              JSON.stringify(publisher),
              attemptNo,
              now,
              row.job_id,
              eventId,
            ).changes;
          if (jobMoved !== 1 || slotMoved !== 1 || consumed !== 1)
            throw new EnhancementError("internal_error");
          const attempt = this.getActiveAttempt(identity);
          if (!attempt) throw new EnhancementError("internal_error");
          return freezeTree({ kind: "created" as const, attempt });
        })
        .immediate(),
    );
  }

  #insertRecoveryReplacement(
    row: AttemptRow,
    identity: AttemptIdentity,
    leaseExpiresAt: number,
  ): void {
    const launchTicket = randomUUID();
    const runDirectory = join(
      row.job_id,
      `attempt-${identity.attemptNo}`,
      `fence-${identity.fence}`,
    );
    this.#database
      .prepare(
        `
        INSERT INTO attempts (job_id, attempt_no, owner_instance_id, fence, lease_expires_at,
          producer_identity_json, producer_incarnation_id, launch_ticket, run_directory, tile)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        row.job_id,
        identity.attemptNo,
        identity.ownerInstanceId,
        identity.fence,
        leaseExpiresAt,
        JSON.stringify(identity),
        this.#incarnationId,
        launchTicket,
        runDirectory,
        row.tile,
      );
  }

  #moveRecoverySlot(row: AttemptRow, identity: AttemptIdentity): number {
    return this.#database
      .prepare(
        "UPDATE execution_slot SET attempt_no = ?, fence = ? WHERE singleton = 1 AND job_id = ? AND attempt_no = ? AND fence = ?",
      )
      .run(
        identity.attemptNo,
        identity.fence,
        row.job_id,
        row.attempt_no,
        row.fence,
      ).changes;
  }

  renewLease(identity: AttemptIdentity): boolean {
    return safe(() =>
      this.#database
        .transaction(() => {
          const row = this.#writableAttempt(identity);
          const now = this.now();
          if (
            !row ||
            now > row.lease_expires_at ||
            (now > row.execution_deadline_at &&
              (row.stop_reason === null || row.authorized_at === null))
          )
            return false;
          const duration = this.#policy(row.job_id).limits.leaseDurationMs;
          const expiresAt = addTime(now, duration);
          return (
            this.#database
              .prepare(
                "UPDATE attempts SET lease_expires_at = ? WHERE job_id = ? AND attempt_no = ? AND owner_instance_id = ? AND fence = ? AND lease_expires_at = ?",
              )
              .run(
                expiresAt,
                row.job_id,
                row.attempt_no,
                row.owner_instance_id,
                row.fence,
                row.lease_expires_at,
              ).changes === 1
          );
        })
        .immediate(),
    );
  }

  requestStop(identity: AttemptIdentity, reason: StopReason): boolean {
    return safe(() =>
      this.#database
        .transaction(() => {
          const row = this.#writableAttempt(identity);
          const now = this.now();
          if (
            !row ||
            now > row.lease_expires_at ||
            (reason === "execution_timeout" && now <= row.execution_deadline_at)
          )
            return false;
          return this.#persistStop(row, reason, now);
        })
        .immediate(),
    );
  }

  registerExit(exit: ExecutionExit): boolean {
    return safe(() =>
      this.#database
        .transaction(() => {
          if (!exit || !exit.identity) return false;
          const row = this.#writableAttempt(exit.identity);
          if (!row || row.exit_json !== null) return false;
          const evidence = this.#exitEvidence(row, exit);
          const now = this.now();
          if (!evidence || now > row.lease_expires_at) return false;
          return (
            this.#database
              .prepare(
                "UPDATE attempts SET exit_json = ?, exit_observed_at = ? WHERE job_id = ? AND attempt_no = ? AND owner_instance_id = ? AND fence = ? AND exit_json IS NULL",
              )
              .run(
                JSON.stringify(evidence),
                now,
                row.job_id,
                row.attempt_no,
                row.owner_instance_id,
                row.fence,
              ).changes === 1
          );
        })
        .immediate(),
    );
  }

  #exitEvidence(
    row: AttemptRow,
    exit: ExecutionExit,
  ): ExecutionExit | undefined {
    if (
      row.authorized_at === null ||
      row.owner_descriptor_json === null ||
      row.sealed_at !== null
    )
      return;
    const source = JSON.parse(row.producer_identity_json) as AttemptIdentity;
    const descriptor = JSON.parse(row.owner_descriptor_json) as OwnerDescriptor;
    try {
      return freezeExecutionExit(
        exit,
        { identity: source, launchTicket: row.launch_ticket },
        descriptor,
      );
    } catch (error) {
      if (
        error instanceof EnhancementError &&
        error.code === "configuration_invalid"
      )
        return;
      throw error;
    }
  }

  acquireArtifactWork(
    publisher: AttemptIdentity,
    purpose: "run" | "recovery",
  ): ArtifactWork | undefined {
    if (
      this.#closed ||
      (purpose !== "run" && purpose !== "recovery") ||
      !artifactIdentity(publisher)
    )
      return;
    return safe(() =>
      this.#database
        .transaction(() => {
          const active =
            this.#artifactAttempt(publisher) ??
            (purpose === "recovery"
              ? this.#interruptedRecoveryAttempt(publisher)?.row
              : undefined);
          const published =
            purpose === "recovery"
              ? this.#publishedArtifactAttempt(publisher)
              : undefined;
          const row = active ?? published;
          if (!row) return;
          const identity = JSON.stringify(this.#publisher(row));
          // Only the Module's in-flight promise reuses a running chain. A fresh
          // acquisition never assumes that an older, unreleased reference ended.
          const existing = active
            ? this.#selectArtifactCandidate(row)
            : this.#publishedCandidate(row);
          const reference: ArtifactReferenceRow = {
            reference_id: randomUUID(),
            job_id: row.job_id,
            attempt_no: row.attempt_no,
            publisher_identity_json: identity,
            incarnation_id: this.#incarnationId,
            purpose,
            candidate_id: existing?.candidate_id ?? null,
            acquired_at: this.now(),
            released_at: null,
          };
          // The clock above may synchronously change durable facts. Only a
          // fresh published recovery acquire turns a matching retirement into
          // 410; the shared publisher/history queries keep their old meaning.
          if (published && !active) {
            const retired = this.#database
              .prepare("SELECT * FROM result_retirements WHERE job_id = ?")
              .get(row.job_id) as ResultRetirementRow | undefined;
            if (retired) {
              const jobRow = this.#database
                .prepare("SELECT * FROM jobs WHERE job_id = ?")
                .get(row.job_id) as JobRow | undefined;
              if (
                !jobRow ||
                !existing ||
                jobRow.status !== "succeeded" ||
                jobRow.result_candidate_id !== existing.candidate_id ||
                jobRow.active_attempt_no !== row.attempt_no ||
                jobRow.current_fence !== row.fence
              )
                throw new EnhancementError("internal_error");
              const job = this.#fromRow(jobRow).job;
              this.#resultRetirement(
                {
                  job,
                  attempt: row,
                  candidate: existing,
                  receipt: this.#resultReceipt(job, row, existing),
                },
                retired,
              );
              throw new EnhancementError("result_gone");
            }
          }
          this.#database
            .prepare(
              `
        INSERT INTO artifact_references (
          reference_id, job_id, attempt_no, publisher_identity_json, incarnation_id,
          purpose, candidate_id, acquired_at, released_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
            )
            .run(
              reference.reference_id,
              row.job_id,
              row.attempt_no,
              identity,
              this.#incarnationId,
              purpose,
              reference.candidate_id,
              reference.acquired_at,
            );
          return this.#artifactWork(
            reference,
            row,
            active ? "active" : "published",
          );
        })
        .immediate(),
    );
  }

  readArtifactWork(key: ArtifactWorkKey): ArtifactWorkRead {
    if (this.#closed) return { kind: "retired" };
    return safe(() => {
      const reference = this.#artifactReference(key);
      if (!reference) return { kind: "retired" };
      const row =
        this.#artifactAttempt(key.publisher) ??
        (reference.purpose === "recovery"
          ? this.#interruptedRecoveryAttempt(key.publisher)?.row
          : undefined);
      if (row && reference.released_at === null)
        return freezeTree({
          kind: "active" as const,
          work: this.#artifactWork(reference, row, "active"),
        });
      const published = this.#publishedArtifactAttempt(key.publisher);
      if (
        !published ||
        reference.candidate_id !==
          this.#publishedCandidate(published).candidate_id
      )
        return { kind: "retired" };
      // A consumed key can query the committed result, but only a newly held
      // recovery reference is allowed to perform the read-only consumer work.
      return freezeTree({
        kind: "published" as const,
        work: this.#artifactWork(reference, published, "published"),
      });
    });
  }

  readArtifactReference(key: ArtifactWorkKey): "held" | "released" | "retired" {
    if (this.#closed) return "retired";
    return safe(() => {
      const reference = this.#artifactReference(key);
      if (!reference || !this.#artifactHolder(key, reference)) return "retired";
      return reference.released_at === null ? "held" : "released";
    });
  }

  reserveArtifactCandidate(
    key: ArtifactWorkKey,
    pngMetadata: ArtifactResult,
  ): ArtifactCandidate | undefined {
    if (this.#closed) return;
    return safe(() =>
      this.#database
        .transaction(() => {
          const read = this.readArtifactWork(key);
          if (read.kind !== "active") return;
          const row = this.#artifactAttempt(key.publisher);
          if (!row) return;
          const manifest = this.#artifactManifest(row, pngMetadata);
          if (!manifest) return;
          if (read.work.candidate) {
            return isDeepStrictEqual(read.work.candidate.manifest, manifest)
              ? read.work.candidate
              : undefined;
          }
          // A null reference is never rebound to a candidate acquired elsewhere.
          // Re-evaluate the selector under this transaction before reserving.
          if (this.#selectArtifactCandidate(row)) return;
          const candidateId = randomUUID();
          const text = JSON.stringify(manifest);
          const candidate: ArtifactCandidateRow = {
            candidate_id: candidateId,
            job_id: row.job_id,
            attempt_no: row.attempt_no,
            producer_identity_json: row.producer_identity_json,
            launch_ticket: row.launch_ticket,
            directory: join(row.run_directory, "artifacts", candidateId),
            manifest_json: text,
            manifest_sha256: artifactDigest(text),
            manifest_byte_length: Buffer.byteLength(text, "utf8"),
            state: "intent",
            created_at: this.now(),
            durable_at: null,
          };
          this.#database
            .prepare(
              `
        INSERT INTO artifact_candidates (
          candidate_id, job_id, attempt_no, producer_identity_json, launch_ticket,
          directory, manifest_json, manifest_sha256, manifest_byte_length, state,
          created_at, durable_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, NULL)
      `,
            )
            .run(
              candidateId,
              row.job_id,
              row.attempt_no,
              row.producer_identity_json,
              row.launch_ticket,
              candidate.directory,
              text,
              candidate.manifest_sha256,
              candidate.manifest_byte_length,
              candidate.created_at,
            );
          const associated = this.#database
            .prepare(
              `
        UPDATE artifact_references SET candidate_id = ?
        WHERE reference_id = ? AND incarnation_id = ? AND candidate_id IS NULL AND released_at IS NULL
      `,
            )
            .run(candidateId, key.referenceId, this.#incarnationId).changes;
          if (associated !== 1) throw new EnhancementError("internal_error");
          return this.#artifactCandidate(candidate, row);
        })
        .immediate(),
    );
  }

  recordArtifactCandidate(key: ArtifactWorkKey, candidateId: string): boolean {
    if (this.#closed) return false;
    return safe(() =>
      this.#database
        .transaction(() => {
          const read = this.readArtifactWork(key);
          if (
            read.kind !== "active" ||
            read.work.candidate?.candidateId !== candidateId ||
            !this.#artifactAttempt(key.publisher)
          )
            return false;
          if (read.work.candidate.state === "durable") return true;
          return (
            this.#database
              .prepare(
                `
        UPDATE artifact_candidates SET state = 'durable', durable_at = ?
        WHERE candidate_id = ? AND job_id = ? AND attempt_no = ? AND state = 'intent'
      `,
              )
              .run(
                this.now(),
                candidateId,
                key.publisher.jobId,
                key.publisher.attemptNo,
              ).changes === 1
          );
        })
        .immediate(),
    );
  }

  recordArtifactObservation(
    key: ArtifactWorkKey,
    observation: ArtifactObservation,
  ): boolean {
    if (this.#closed) return false;
    return safe(() =>
      this.#database
        .transaction(() => {
          const read = this.readArtifactWork(key);
          const reference = this.#artifactReference(key);
          if (
            read.kind === "retired" ||
            !reference ||
            reference.released_at !== null ||
            (read.kind === "published" && reference.purpose !== "recovery") ||
            !observation ||
            typeof observation !== "object"
          )
            return false;
          const allowed =
            observation.code === "io_failure"
              ? ["code", "stage", "candidateId"]
              : ["code", "candidateId", "checkedEngineSha256"];
          if (Object.keys(observation).some((name) => !allowed.includes(name)))
            return false;
          const codes = [
            "io_failure",
            "engine_integrity",
            "candidate_integrity",
            "output_invalid",
            "no_qualified_candidate",
            "publication_unknown",
          ];
          if (!codes.includes(observation.code)) return false;
          if (
            read.kind === "published" &&
            (observation.code === "output_invalid" ||
              observation.code === "no_qualified_candidate")
          )
            return false;
          if (
            observation.candidateId !== undefined &&
            observation.candidateId !== read.work.candidate?.candidateId
          )
            return false;
          if (
            observation.code === "output_invalid" &&
            read.work.candidate !== null
          )
            return false;
          const stage =
            observation.code === "io_failure" ? observation.stage : null;
          if (stage !== null && !artifactIoStages.has(stage)) return false;
          const checked =
            observation.code === "io_failure"
              ? null
              : (observation.checkedEngineSha256 ?? null);
          if (
            checked !== null &&
            checked !== read.work.attempt.job.engineInput.sha256
          )
            return false;
          if (observation.code === "no_qualified_candidate") {
            const candidate = read.work.candidate;
            const sourceWide =
              candidate === null &&
              read.kind === "active" &&
              reference.purpose === "recovery" &&
              read.work.attempt.exit?.completion?.kind === "interrupted" &&
              !Object.hasOwn(observation, "candidateId");
            if (
              checked !== read.work.attempt.job.engineInput.sha256 ||
              (!sourceWide &&
                (!candidate ||
                  observation.candidateId !== candidate.candidateId ||
                  this.#preserveArtifactCandidate(
                    candidate.state,
                    read.work.observations,
                    candidate.candidateId,
                  )))
            )
              return false;
          }
          const { maximum } = this.#database
            .prepare(
              `
        SELECT COALESCE(MAX(observation_no), 0) AS maximum FROM artifact_observations WHERE reference_id = ?
      `,
            )
            .get(key.referenceId) as { maximum: number };
          this.#database
            .prepare(
              `
        INSERT INTO artifact_observations (
          reference_id, observation_no, candidate_id, code, stage, checked_engine_sha256, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
            )
            .run(
              key.referenceId,
              addTime(maximum, 1),
              observation.candidateId ?? null,
              observation.code,
              stage,
              checked,
              this.now(),
            );
          return true;
        })
        .immediate(),
    );
  }

  finishSucceeded(key: ArtifactWorkKey, candidateId: string): boolean {
    if (this.#closed) return false;
    return safe(() =>
      this.#database
        .transaction(() => {
          const read = this.readArtifactWork(key);
          if (
            read.kind !== "active" ||
            read.work.candidate?.candidateId !== candidateId ||
            read.work.candidate.state !== "durable"
          )
            return false;
          const row = this.#artifactAttempt(key.publisher);
          if (!row) return false;
          const now = this.now();
          const changed = this.#database
            .prepare(
              `
        UPDATE jobs SET status = 'succeeded', reason = NULL, completed_at = ?, result_candidate_id = ?
        WHERE job_id = ? AND status = 'running' AND active_attempt_no = ? AND current_fence = ?
      `,
            )
            .run(
              now,
              candidateId,
              row.job_id,
              row.attempt_no,
              row.fence,
            ).changes;
          if (changed !== 1) return false;
          this.#finishArtifactReference(row, key, now);
          return true;
        })
        .immediate(),
    );
  }

  releaseArtifactReference(key: ArtifactWorkKey): boolean {
    if (this.#closed) return false;
    return safe(() =>
      this.#database
        .transaction(() => {
          const reference = this.#artifactReference(key);
          if (!reference) return false;
          if (!this.#artifactHolder(key, reference)) return false;
          if (reference.released_at !== null) return true;
          return (
            this.#database
              .prepare(
                `
        UPDATE artifact_references SET released_at = ? WHERE reference_id = ? AND incarnation_id = ? AND released_at IS NULL
      `,
              )
              .run(this.now(), key.referenceId, this.#incarnationId).changes ===
            1
          );
        })
        .immediate(),
    );
  }

  #artifactHolder(
    key: ArtifactWorkKey,
    reference: ArtifactReferenceRow,
  ): AttemptRow | undefined {
    // Terminal references have no execution slot. Their original current tuple,
    // holder and incarnation remain necessary even for a read-only fact query.
    const row = this.#database
      .prepare(
        `
        SELECT a.*, j.execution_deadline_at FROM attempts a JOIN jobs j ON j.job_id = a.job_id
        WHERE a.job_id = ? AND a.attempt_no = ? AND a.owner_instance_id = ? AND a.fence = ?
          AND j.active_attempt_no = a.attempt_no AND j.current_fence = a.fence
      `,
      )
      .get(
        key.publisher.jobId,
        key.publisher.attemptNo,
        key.publisher.ownerInstanceId,
        key.publisher.fence,
      ) as AttemptRow | undefined;
    if (
      !row ||
      this.#database
        .prepare(
          "SELECT 1 FROM recovery_controls WHERE job_id = ? AND attempt_no = ? AND state = 'active'",
        )
        .get(row.job_id, row.attempt_no)
    )
      return;
    const job = this.#database
      .prepare("SELECT * FROM jobs WHERE job_id = ?")
      .get(row.job_id) as JobRow;
    if (
      job.status === "queued" ||
      (job.status === "running" &&
        !this.#artifactAttempt(key.publisher) &&
        !(
          reference.purpose === "recovery" &&
          this.#interruptedRecoveryAttempt(key.publisher)
        )) ||
      (job.status === "succeeded" &&
        job.result_candidate_id !== reference.candidate_id)
    )
      return;
    return row;
  }

  #publishedArtifactAttempt(
    publisher: AttemptIdentity,
  ): AttemptRow | undefined {
    if (!artifactIdentity(publisher)) return;
    const row = this.#database
      .prepare(
        `
        SELECT a.*, j.execution_deadline_at FROM attempts a JOIN jobs j ON j.job_id = a.job_id
        WHERE a.job_id = ? AND a.attempt_no = ? AND a.owner_instance_id = ? AND a.fence = ?
          AND j.status = 'succeeded' AND j.active_attempt_no = a.attempt_no AND j.current_fence = a.fence
      `,
      )
      .get(
        publisher.jobId,
        publisher.attemptNo,
        publisher.ownerInstanceId,
        publisher.fence,
      ) as AttemptRow | undefined;
    if (
      !row ||
      row.exit_json === null ||
      this.#database
        .prepare(
          "SELECT 1 FROM recovery_controls WHERE job_id = ? AND attempt_no = ? AND state = 'active'",
        )
        .get(row.job_id, row.attempt_no)
    )
      return;
    const exit = this.#exitEvidence(
      row,
      JSON.parse(row.exit_json) as ExecutionExit,
    );
    return exit?.completion?.kind === "success" ? row : undefined;
  }

  #publishedCandidate(row: AttemptRow): ArtifactCandidateRow {
    const candidate = this.#database
      .prepare(
        `
      SELECT c.* FROM artifact_candidates c JOIN jobs j ON j.result_candidate_id = c.candidate_id
      WHERE j.job_id = ? AND j.status = 'succeeded' AND c.job_id = j.job_id
        AND c.attempt_no = j.active_attempt_no AND c.state = 'durable'
    `,
      )
      .get(row.job_id) as ArtifactCandidateRow | undefined;
    if (!candidate) throw new EnhancementError("internal_error");
    this.#artifactCandidate(candidate, row);
    return candidate;
  }

  #artifactObservationRows(
    row: AttemptRow,
    candidateId: string | null,
  ): ArtifactObservationRow[] {
    // attempts keeps the physical producer/ticket immutable. Follow only refs
    // belonging to that source, and only source-wide or this candidate's facts.
    return this.#database
      .prepare(
        `
      SELECT o.* FROM artifact_observations o
      JOIN artifact_references r ON r.reference_id = o.reference_id
      JOIN attempts a ON a.job_id = r.job_id AND a.attempt_no = r.attempt_no
      WHERE r.job_id = ? AND r.attempt_no = ? AND a.producer_identity_json = ? AND a.launch_ticket = ?
        AND (o.candidate_id IS NULL OR o.candidate_id = ?)
      ORDER BY r.acquired_at, r.rowid, o.observation_no
    `,
      )
      .all(
        row.job_id,
        row.attempt_no,
        row.producer_identity_json,
        row.launch_ticket,
        candidateId,
      ) as ArtifactObservationRow[];
  }

  #preserveArtifactCandidate(
    state: ArtifactCandidate["state"],
    observations: readonly ArtifactObservation[],
    candidateId: string,
  ): boolean {
    return (
      state === "durable" ||
      observations.some(
        (observation) =>
          observation.candidateId === candidateId &&
          (observation.code === "candidate_integrity" ||
            (observation.code === "io_failure" &&
              (observation.stage === "directory_sync" ||
                observation.stage === "candidate_commit"))),
      )
    );
  }

  #selectArtifactCandidate(row: AttemptRow): ArtifactCandidateRow | undefined {
    const candidates = this.#database
      .prepare(
        `
      SELECT * FROM artifact_candidates WHERE job_id = ? AND attempt_no = ?
        AND producer_identity_json = ? AND launch_ticket = ?
      ORDER BY CASE state WHEN 'durable' THEN 0 ELSE 1 END, rowid DESC
    `,
      )
      .all(
        row.job_id,
        row.attempt_no,
        row.producer_identity_json,
        row.launch_ticket,
      ) as ArtifactCandidateRow[];
    let ordinary: ArtifactCandidateRow | undefined;
    const engine = this.#database
      .prepare("SELECT engine_json FROM jobs WHERE job_id = ?")
      .get(row.job_id) as { engine_json: string };
    const engineSha256 = (JSON.parse(engine.engine_json) as EngineManifest)
      .sha256;
    for (const candidate of candidates) {
      const observations = this.#artifactObservations(
        row,
        candidate.candidate_id,
      );
      if (
        this.#preserveArtifactCandidate(
          candidate.state,
          observations,
          candidate.candidate_id,
        )
      )
        return candidate;
      const rejected = observations.some(
        (observation) =>
          observation.code === "no_qualified_candidate" &&
          observation.candidateId === candidate.candidate_id &&
          observation.checkedEngineSha256 === engineSha256,
      );
      if (!rejected && !ordinary) ordinary = candidate;
    }
    return ordinary;
  }

  #artifactObservations(
    row: AttemptRow,
    candidateId: string | null,
  ): ArtifactObservation[] {
    return this.#artifactObservationRows(row, candidateId).map(
      (observation): ArtifactObservation => {
        const associated =
          observation.candidate_id === null
            ? {}
            : { candidateId: observation.candidate_id };
        return observation.code === "io_failure"
          ? { code: "io_failure", stage: observation.stage!, ...associated }
          : {
              code: observation.code,
              ...associated,
              ...(observation.checked_engine_sha256 === null
                ? {}
                : { checkedEngineSha256: observation.checked_engine_sha256 }),
            };
      },
    );
  }

  #consumedInterruptionControl(
    row: AttemptRow,
    publisher: AttemptIdentity,
    incarnationId: string,
  ): RecoveryRow | undefined {
    if (!artifactIdentity(publisher) || publisher.fence <= 1) return;
    const source = JSON.parse(row.producer_identity_json) as AttemptIdentity;
    if (
      !artifactIdentity(source) ||
      source.jobId !== row.job_id ||
      source.attemptNo !== row.attempt_no
    )
      return;
    const candidates = this.#database
      .prepare(
        `
      SELECT * FROM recovery_controls
      WHERE job_id = ? AND attempt_no = ? AND launch_ticket = ?
        AND state = 'consumed' AND classification = 'tree-exited'
        AND incarnation_id = ? AND owner_instance_id = ?
        AND json_extract(publisher_identity_json, '$.fence') = ?
    `,
      )
      .all(
        row.job_id,
        row.attempt_no,
        row.launch_ticket,
        incarnationId,
        publisher.ownerInstanceId,
        publisher.fence - 1,
      ) as RecoveryRow[];
    const qualified = candidates.filter((control) => {
      const pre = JSON.parse(
        control.publisher_identity_json,
      ) as AttemptIdentity;
      if (
        !validIdentifier(control.recovery_id) ||
        !validIdentifier(control.owner_instance_id) ||
        control.source_incarnation_id !== row.producer_incarnation_id ||
        control.source_incarnation_id === incarnationId ||
        !artifactIdentity(pre) ||
        pre.jobId !== row.job_id ||
        pre.attemptNo !== row.attempt_no ||
        !isDeepStrictEqual(JSON.parse(control.source_identity_json), source) ||
        !artifactTime(control.created_at) ||
        !artifactTime(control.observed_at) ||
        !artifactTime(control.consumed_at) ||
        control.created_at > control.observed_at ||
        control.observed_at > control.consumed_at
      )
        return false;
      return isDeepStrictEqual(
        {
          ...pre,
          ownerInstanceId: control.owner_instance_id,
          fence: addTime(pre.fence, 1),
        },
        publisher,
      );
    });
    return qualified.length === 1 ? qualified[0] : undefined;
  }

  #interruptedRecoveryAttempt(
    publisher: AttemptIdentity,
  ): InterruptedRecoveryFacts | undefined {
    if (this.#closed || !artifactIdentity(publisher)) return;
    const row = this.#writableAttempt(publisher);
    const now = this.now();
    if (
      !row ||
      row.producer_incarnation_id === this.#incarnationId ||
      !validIdentifier(row.producer_incarnation_id) ||
      !validIdentifier(row.launch_ticket) ||
      !artifactTime(row.prepared_at) ||
      !artifactTime(row.authorized_at) ||
      row.prepared_at > row.authorized_at ||
      !artifactTime(row.exit_observed_at) ||
      row.owner_descriptor_json === null ||
      row.sealed_at !== null ||
      row.exit_json === null ||
      row.stop_reason !== null ||
      now > row.lease_expires_at ||
      now > row.execution_deadline_at
    )
      return;
    const exit = this.#exitEvidence(
      row,
      JSON.parse(row.exit_json) as ExecutionExit,
    );
    if (exit?.completion?.kind !== "interrupted") return;
    const job = this.#database
      .prepare("SELECT * FROM jobs WHERE job_id = ?")
      .get(row.job_id) as JobRow;
    if (
      job.cancel_requested_at !== null ||
      !artifactTime(job.first_started_at) ||
      !artifactTime(job.execution_deadline_at) ||
      job.first_started_at > job.execution_deadline_at
    )
      return;
    const recovery = this.#consumedInterruptionControl(
      row,
      publisher,
      this.#incarnationId,
    );
    if (!recovery) return;
    const scope = freezeTree({
      target: {
        identity: JSON.parse(row.producer_identity_json) as AttemptIdentity,
        launchTicket: row.launch_ticket,
      },
      descriptor: freezeOwnerDescriptor(
        JSON.parse(row.owner_descriptor_json) as OwnerDescriptor,
        row.launch_ticket,
      ),
    });
    return { row, job, recovery, scope, exit };
  }

  #interruptedRestartFacts(
    key: ArtifactWorkKey,
    original?: InterruptedRestartFacts,
  ): InterruptedRestartFacts | undefined {
    if (this.#closed) return;
    const reference = this.#artifactReference(key);
    if (
      !reference ||
      reference.purpose !== "recovery" ||
      reference.released_at !== null
    )
      return;
    const facts = this.#interruptedRecoveryAttempt(key.publisher);
    if (!facts) return;
    if (original) {
      const { lease_expires_at: leaseExpiresAt, ...rowWithoutLease } =
        facts.row;
      const {
        lease_expires_at: originalLeaseExpiresAt,
        ...originalRowWithoutLease
      } = original.row;
      // A heartbeat may extend this lease; all other source facts stay exact.
      if (
        !(leaseExpiresAt >= originalLeaseExpiresAt) ||
        !isDeepStrictEqual(rowWithoutLease, originalRowWithoutLease) ||
        !isDeepStrictEqual(facts.job, original.job) ||
        !isDeepStrictEqual(facts.recovery, original.recovery) ||
        !isDeepStrictEqual(facts.scope, original.scope) ||
        !isDeepStrictEqual(reference, original.reference)
      )
        return;
    }
    const engine = JSON.parse(facts.job.engine_json) as EngineManifest;
    const observations = this.#database
      .prepare(
        `
      SELECT * FROM artifact_observations WHERE reference_id = ? ORDER BY observation_no
    `,
      )
      .all(reference.reference_id) as ArtifactObservationRow[];
    const latest = observations.at(-1);
    if (
      !latest ||
      latest.code !== "no_qualified_candidate" ||
      latest.stage !== null ||
      latest.candidate_id !== reference.candidate_id ||
      latest.checked_engine_sha256 !== engine.sha256 ||
      !artifactTime(latest.observed_at)
    )
      return;
    // Historical no-qualified facts may guide candidate selection, but only
    // the observation on this exact held ref grants this invocation a reader.
    const sourceObservations = this.#artifactObservationRows(
      facts.row,
      reference.candidate_id,
    );
    if (
      sourceObservations.some(
        (observation) => observation.code !== "no_qualified_candidate",
      )
    )
      return;
    const selected = this.#selectArtifactCandidate(facts.row);
    if (selected && selected.candidate_id !== reference.candidate_id) return;
    if (reference.candidate_id !== null) {
      const candidate = this.#database
        .prepare(
          `
        SELECT * FROM artifact_candidates WHERE candidate_id = ? AND job_id = ? AND attempt_no = ?
      `,
        )
        .get(reference.candidate_id, facts.row.job_id, facts.row.attempt_no) as
        ArtifactCandidateRow | undefined;
      if (!candidate) return;
      const checked = this.#artifactCandidate(candidate, facts.row);
      if (
        this.#preserveArtifactCandidate(
          checked.state,
          this.#artifactObservations(facts.row, checked.candidateId),
          checked.candidateId,
        )
      )
        return;
    }
    return { ...facts, reference };
  }

  #interruptionIdsMatch(
    exit: ExecutionExit,
    records: DurableInterruptionRecords,
  ): boolean {
    const completion = exit.completion;
    return (
      completion?.kind === "interrupted" &&
      completion.authorizationRecordId === records.authorization.recordId &&
      completion.controllerLossRecordId === records.controllerLoss.recordId &&
      completion.terminalRecordId === records.terminal.recordId
    );
  }

  #replayInterruptedAttempt(
    key: ArtifactWorkKey,
  ): StartupRecoveryOutcome | undefined {
    if (
      this.#closed ||
      !key ||
      !artifactIdentity(key.publisher) ||
      !validIdentifier(key.referenceId)
    )
      return;
    // Historical replay deliberately has no current-incarnation/slot grant.
    const reference = this.#database
      .prepare("SELECT * FROM artifact_references WHERE reference_id = ?")
      .get(key.referenceId) as ArtifactReferenceRow | undefined;
    if (
      !reference ||
      reference.job_id !== key.publisher.jobId ||
      reference.attempt_no !== key.publisher.attemptNo ||
      reference.purpose !== "recovery" ||
      !isDeepStrictEqual(
        JSON.parse(reference.publisher_identity_json),
        key.publisher,
      )
    )
      return;
    const row = this.#database
      .prepare(
        `
      SELECT a.*, j.execution_deadline_at FROM attempts a JOIN jobs j ON j.job_id = a.job_id
      WHERE a.job_id = ? AND a.attempt_no = ?
    `,
      )
      .get(reference.job_id, reference.attempt_no) as AttemptRow | undefined;
    if (
      !row ||
      row.exit_json === null ||
      row.owner_descriptor_json === null ||
      !isDeepStrictEqual(this.#publisher(row), key.publisher)
    )
      return;
    const event = this.#database
      .prepare(
        "SELECT * FROM recovery_events WHERE job_id = ? AND launch_ticket = ?",
      )
      .get(row.job_id, row.launch_ticket) as RecoveryEventRow | undefined;
    if (
      !event ||
      event.kind !== "authorized-interruption" ||
      event.sealed_at !== null ||
      event.evidence_json === null ||
      !artifactTime(event.interrupted_at) ||
      !artifactTime(event.consumed_at) ||
      event.consumed_at < event.interrupted_at ||
      event.replacement_attempt_no === null ||
      reference.released_at !== event.consumed_at ||
      event.recovery_incarnation_id !== reference.incarnation_id ||
      event.source_incarnation_id !== row.producer_incarnation_id ||
      event.source_incarnation_id === event.recovery_incarnation_id ||
      event.consumed_publisher_identity_json === null ||
      !isDeepStrictEqual(
        JSON.parse(event.source_identity_json),
        JSON.parse(row.producer_identity_json),
      ) ||
      !isDeepStrictEqual(
        JSON.parse(event.consumed_publisher_identity_json),
        key.publisher,
      )
    )
      return;
    const recovery = this.#consumedInterruptionControl(
      row,
      key.publisher,
      reference.incarnation_id,
    );
    if (!recovery || event.interrupted_at < recovery.consumed_at!) return;
    const evidence = JSON.parse(
      event.evidence_json,
    ) as AuthorizedInterruptionEventEvidence;
    if (
      !evidence ||
      Object.getPrototypeOf(evidence) !== Object.prototype ||
      Reflect.ownKeys(evidence).length !== 4 ||
      !["v", "recoveryId", "referenceId", "records"].every((field) =>
        Object.hasOwn(evidence, field),
      ) ||
      evidence.v !== 1 ||
      evidence.referenceId !== reference.reference_id ||
      evidence.recoveryId !== recovery.recovery_id ||
      JSON.stringify(evidence) !== event.evidence_json
    )
      return;
    const exit = this.#exitEvidence(
      row,
      JSON.parse(row.exit_json) as ExecutionExit,
    );
    if (!exit || exit.completion?.kind !== "interrupted") return;
    let records: DurableInterruptionRecords;
    try {
      records = freezeDurableInterruptionRecords(evidence.records, {
        target: {
          identity: JSON.parse(row.producer_identity_json) as AttemptIdentity,
          launchTicket: row.launch_ticket,
        },
        descriptor: JSON.parse(row.owner_descriptor_json) as OwnerDescriptor,
      });
    } catch {
      return;
    }
    if (
      !this.#interruptionIdsMatch(exit, records) ||
      event.replacement_attempt_no !== addTime(row.attempt_no, 1)
    )
      return;
    const replacement = this.#database
      .prepare("SELECT * FROM attempts WHERE job_id = ? AND attempt_no = ?")
      .get(row.job_id, event.replacement_attempt_no) as AttemptRow | undefined;
    const expectedProducer: AttemptIdentity = {
      jobId: row.job_id,
      attemptNo: event.replacement_attempt_no,
      ownerInstanceId: key.publisher.ownerInstanceId,
      fence: addTime(key.publisher.fence, 1),
    };
    if (
      !replacement ||
      replacement.producer_incarnation_id !== event.recovery_incarnation_id ||
      replacement.launch_ticket === row.launch_ticket ||
      !validIdentifier(replacement.launch_ticket) ||
      replacement.run_directory !==
        join(
          row.job_id,
          `attempt-${expectedProducer.attemptNo}`,
          `fence-${expectedProducer.fence}`,
        ) ||
      replacement.tile !== row.tile ||
      !isDeepStrictEqual(
        JSON.parse(replacement.producer_identity_json),
        expectedProducer,
      )
    )
      return;
    return freezeTree({
      kind: "already-applied" as const,
      replacementAttemptNo: expectedProducer.attemptNo,
    });
  }

  #artifactAttempt(publisher: AttemptIdentity): AttemptRow | undefined {
    if (!artifactIdentity(publisher)) return;
    const row = this.#writableAttempt(publisher);
    const now = this.now();
    if (
      !row ||
      now > row.lease_expires_at ||
      now > row.execution_deadline_at ||
      row.stop_reason === "execution_timeout" ||
      row.exit_json === null
    )
      return;
    const exit = this.#exitEvidence(
      row,
      JSON.parse(row.exit_json) as ExecutionExit,
    );
    return exit?.completion?.kind === "success" ? row : undefined;
  }

  #artifactReference(key: ArtifactWorkKey): ArtifactReferenceRow | undefined {
    if (
      !key ||
      !artifactIdentity(key.publisher) ||
      !validIdentifier(key.referenceId)
    )
      return;
    const row = this.#database
      .prepare("SELECT * FROM artifact_references WHERE reference_id = ?")
      .get(key.referenceId) as ArtifactReferenceRow | undefined;
    return row &&
      row.incarnation_id === this.#incarnationId &&
      row.job_id === key.publisher.jobId &&
      row.attempt_no === key.publisher.attemptNo &&
      isDeepStrictEqual(JSON.parse(row.publisher_identity_json), key.publisher)
      ? row
      : undefined;
  }

  #artifactManifest(
    row: AttemptRow,
    png: ArtifactResult,
  ): ArtifactManifest | undefined {
    if (
      !png ||
      typeof png !== "object" ||
      Object.keys(png).length !== 5 ||
      png.format !== "png" ||
      !Number.isSafeInteger(png.width) ||
      png.width <= 0 ||
      !Number.isSafeInteger(png.height) ||
      png.height <= 0 ||
      !Number.isSafeInteger(png.byteLength) ||
      png.byteLength <= 0 ||
      typeof png.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(png.sha256)
    )
      return;
    const job = this.#database
      .prepare("SELECT * FROM jobs WHERE job_id = ?")
      .get(row.job_id) as JobRow;
    const plan = JSON.parse(job.plan_json) as FrozenEnhancementPlan;
    const engine = JSON.parse(job.engine_json) as EngineManifest;
    const policy = JSON.parse(job.execution_policy_json) as ExecutionPolicy;
    if (
      png.width !== engine.width * plan.engine.nativeScale ||
      png.height !== engine.height * plan.engine.nativeScale ||
      png.byteLength > plan.budgets.ai.maxBytes ||
      BigInt(png.width) * BigInt(png.height) > BigInt(plan.budgets.ai.maxPixels)
    )
      return;
    return freezeTree({
      producer: {
        identity: JSON.parse(row.producer_identity_json) as AttemptIdentity,
        launchTicket: row.launch_ticket,
      },
      planFingerprint: plan.planFingerprint,
      engineInputSha256: engine.sha256,
      executionPolicyFingerprint: policy.fingerprint,
      tile: row.tile,
      png: {
        format: "png" as const,
        width: png.width,
        height: png.height,
        sha256: png.sha256,
        byteLength: png.byteLength,
      },
    });
  }

  #artifactCandidate(
    candidate: ArtifactCandidateRow,
    row: AttemptRow,
  ): ArtifactCandidate {
    const manifest = JSON.parse(candidate.manifest_json) as ArtifactManifest;
    const expected = this.#artifactManifest(row, manifest.png);
    if (
      !expected ||
      candidate.job_id !== row.job_id ||
      candidate.attempt_no !== row.attempt_no ||
      candidate.producer_identity_json !== row.producer_identity_json ||
      candidate.launch_ticket !== row.launch_ticket ||
      candidate.directory !==
        join(row.run_directory, "artifacts", candidate.candidate_id) ||
      JSON.stringify(expected) !== candidate.manifest_json ||
      Buffer.byteLength(candidate.manifest_json, "utf8") !==
        candidate.manifest_byte_length ||
      artifactDigest(candidate.manifest_json) !== candidate.manifest_sha256
    )
      throw new EnhancementError("internal_error");
    const directory = join(this.#attemptDirectory, candidate.directory);
    return freezeTree({
      candidateId: candidate.candidate_id,
      state: candidate.state,
      directory,
      pngPartPath: join(directory, "artifact.part.png"),
      pngPath: join(directory, "artifact.png"),
      manifestPartPath: join(directory, "manifest.part.json"),
      manifestPath: join(directory, "manifest.json"),
      manifest: expected,
      manifestSha256: candidate.manifest_sha256,
      manifestByteLength: candidate.manifest_byte_length,
    });
  }

  #artifactWork(
    reference: ArtifactReferenceRow,
    row: AttemptRow,
    access: "active" | "published",
  ): ArtifactWork {
    const attempt = this.#projectAttempt(row);
    const candidate =
      reference.candidate_id === null
        ? null
        : (this.#database
            .prepare(
              `
      SELECT * FROM artifact_candidates WHERE candidate_id = ? AND job_id = ? AND attempt_no = ?
    `,
            )
            .get(reference.candidate_id, row.job_id, row.attempt_no) as
            ArtifactCandidateRow | undefined);
    if (reference.candidate_id !== null && !candidate)
      throw new EnhancementError("internal_error");
    return freezeTree({
      key: {
        publisher: this.#publisher(row),
        referenceId: reference.reference_id,
      },
      purpose: reference.purpose,
      access,
      attempt,
      enginePath: attempt.inputPath,
      outputPath: attempt.outputPath,
      candidate: candidate ? this.#artifactCandidate(candidate, row) : null,
      observations: this.#artifactObservations(row, reference.candidate_id),
    });
  }

  #result(job: JobRow): ArtifactResult {
    const candidate = this.#database
      .prepare(
        `
      SELECT * FROM artifact_candidates WHERE candidate_id = ? AND job_id = ? AND attempt_no = ? AND state = 'durable'
    `,
      )
      .get(job.result_candidate_id, job.job_id, job.active_attempt_no) as
      ArtifactCandidateRow | undefined;
    const row = this.#database
      .prepare(
        "SELECT a.*, j.execution_deadline_at FROM attempts a JOIN jobs j ON j.job_id = a.job_id WHERE a.job_id = ? AND a.attempt_no = ?",
      )
      .get(job.job_id, job.active_attempt_no) as AttemptRow | undefined;
    if (!candidate || !row) throw new EnhancementError("internal_error");
    return this.#artifactCandidate(candidate, row).manifest.png;
  }

  #finishArtifactReference(row: AttemptRow, key: ArtifactWorkKey, now: number) {
    const slot = this.#database
      .prepare(
        "DELETE FROM execution_slot WHERE job_id = ? AND attempt_no = ? AND fence = ?",
      )
      .run(row.job_id, row.attempt_no, row.fence).changes;
    const reference = this.#database
      .prepare(
        `
      UPDATE artifact_references SET released_at = ? WHERE reference_id = ? AND incarnation_id = ? AND released_at IS NULL
    `,
      )
      .run(now, key.referenceId, this.#incarnationId).changes;
    if (slot !== 1 || reference !== 1)
      throw new EnhancementError("internal_error");
  }

  #finishInvalidOutput(
    publisher: AttemptIdentity,
    key: ArtifactWorkKey,
  ): boolean {
    if (this.#closed || !isDeepStrictEqual(publisher, key.publisher))
      return false;
    return safe(() =>
      this.#database
        .transaction(() => {
          const read = this.readArtifactWork(key);
          if (read.kind !== "active" || read.work.candidate !== null)
            return false;
          const invalidOutput = this.#database
            .prepare(
              "SELECT 1 FROM artifact_observations WHERE reference_id = ? AND code = 'output_invalid' LIMIT 1",
            )
            .get(key.referenceId);
          if (!invalidOutput) return false;
          const row = this.#artifactAttempt(publisher);
          if (!row || row.stop_reason !== null) return false;
          const now = this.now();
          const changed = this.#database
            .prepare(
              `
        UPDATE jobs SET status = 'failed', reason = 'invalid_output', completed_at = ?
        WHERE job_id = ? AND status = 'running' AND active_attempt_no = ? AND current_fence = ? AND cancel_requested_at IS NULL
      `,
            )
            .run(now, row.job_id, row.attempt_no, row.fence).changes;
          if (changed !== 1) return false;
          this.#finishArtifactReference(row, key, now);
          return true;
        })
        .immediate(),
    );
  }

  finishFailed(
    publisher: AttemptIdentity,
    invalidWork?: ArtifactWorkKey,
  ): boolean {
    if (invalidWork !== undefined)
      return this.#finishInvalidOutput(publisher, invalidWork);
    return safe(() =>
      this.#database
        .transaction(() => {
          const row = this.#writableAttempt(publisher);
          const now = this.now();
          if (
            !row ||
            now > row.lease_expires_at ||
            now > row.execution_deadline_at ||
            row.stop_reason !== null ||
            row.exit_json === null
          )
            return false;
          const exit = this.#exitEvidence(
            row,
            JSON.parse(row.exit_json) as ExecutionExit,
          );
          if (
            exit?.completion?.kind !== "failure" &&
            exit?.completion?.kind !== "oom"
          )
            return false;
          const changed = this.#database
            .prepare(
              "UPDATE jobs SET status = 'failed', reason = 'execution_failed', completed_at = ? WHERE job_id = ? AND status = 'running' AND active_attempt_no = ? AND current_fence = ? AND cancel_requested_at IS NULL",
            )
            .run(now, row.job_id, row.attempt_no, row.fence).changes;
          if (changed !== 1) return false;
          const released = this.#database
            .prepare(
              "DELETE FROM execution_slot WHERE job_id = ? AND attempt_no = ? AND fence = ?",
            )
            .run(row.job_id, row.attempt_no, row.fence).changes;
          if (released !== 1) throw new EnhancementError("internal_error");
          return true;
        })
        .immediate(),
    );
  }

  finishCancelled(identity: AttemptIdentity): boolean {
    return safe(() =>
      this.#database
        .transaction(() => {
          const row = this.#writableAttempt(identity);
          const now = this.now();
          if (!row || now > row.lease_expires_at || row.stop_reason === null)
            return false;
          const sealed = row.authorized_at === null && row.sealed_at !== null;
          if (!sealed) {
            if (
              row.authorized_at === null ||
              row.owner_descriptor_json === null ||
              row.exit_json === null
            )
              return false;
            const exit = JSON.parse(row.exit_json) as ExecutionExit;
            if (
              exit.treeExited !== true ||
              exit.launchTicket !== row.launch_ticket ||
              !isDeepStrictEqual(
                exit.identity,
                JSON.parse(row.producer_identity_json),
              ) ||
              !isDeepStrictEqual(
                exit.descriptor,
                JSON.parse(row.owner_descriptor_json),
              )
            )
              return false;
          }
          const changed =
            this.#database
              .prepare(
                "UPDATE jobs SET status = 'cancelled', reason = ?, completed_at = ? WHERE job_id = ? AND status = 'running' AND active_attempt_no = ? AND current_fence = ?",
              )
              .run(row.stop_reason, now, row.job_id, row.attempt_no, row.fence)
              .changes === 1;
          if (!changed) return false;
          this.#database
            .prepare(
              "DELETE FROM execution_slot WHERE job_id = ? AND attempt_no = ? AND fence = ?",
            )
            .run(row.job_id, row.attempt_no, row.fence);
          return true;
        })
        .immediate(),
    );
  }

  #policy(jobId: string): ExecutionPolicy {
    const row = this.#database
      .prepare("SELECT execution_policy_json FROM jobs WHERE job_id = ?")
      .get(jobId) as { execution_policy_json: string };
    return JSON.parse(row.execution_policy_json) as ExecutionPolicy;
  }

  #persistStop(row: AttemptRow, reason: StopReason, now: number): boolean {
    if (row.stop_reason !== null) return false;
    const terminateAfterAt = addTime(
      now,
      this.#policy(row.job_id).limits.cancelGraceMs,
    );
    return (
      this.#database
        .prepare(
          "UPDATE attempts SET stop_reason = ?, stop_requested_at = ?, terminate_after_at = ? WHERE job_id = ? AND attempt_no = ? AND owner_instance_id = ? AND fence = ? AND stop_reason IS NULL",
        )
        .run(
          reason,
          now,
          terminateAfterAt,
          row.job_id,
          row.attempt_no,
          row.owner_instance_id,
          row.fence,
        ).changes === 1
    );
  }

  #expireQueued(now: number) {
    this.#database
      .prepare(
        "UPDATE jobs SET status = 'failed', reason = 'queue_timeout', completed_at = ? WHERE status = 'queued' AND queue_deadline_at < ?",
      )
      .run(now, now);
  }

  claimNext(
    ownerInstanceId: string,
    onlyJobId?: string,
  ): ClaimedAttempt | undefined {
    return safe(() =>
      this.#database
        .transaction(() => {
          if (
            !validIdentifier(ownerInstanceId) ||
            (onlyJobId !== undefined && !validIdentifier(onlyJobId))
          )
            throw new EnhancementError("configuration_invalid");
          const now = this.now();
          this.#expireQueued(now);
          if (
            this.#database
              .prepare("SELECT 1 FROM execution_slot WHERE singleton = 1")
              .get()
          )
            return;
          const selection = this.#database.prepare(
            onlyJobId === undefined
              ? "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, queue_sequence LIMIT 1"
              : "SELECT * FROM jobs WHERE status = 'queued' AND job_id = ?",
          );
          const queued = (
            onlyJobId === undefined ? selection.get() : selection.get(onlyJobId)
          ) as JobRow | undefined;
          if (!queued) return;
          const stored = this.#fromRow(queued);
          const attemptNo = addTime(queued.active_attempt_no, 1);
          const fence = addTime(queued.current_fence, 1);
          const firstStartedAt = queued.first_started_at ?? now;
          const executionDeadlineAt =
            queued.execution_deadline_at ??
            addTime(
              firstStartedAt,
              stored.executionPolicy.limits.executionTimeoutMs,
            );
          const leaseExpiresAt = addTime(
            now,
            stored.executionPolicy.limits.leaseDurationMs,
          );
          const launchTicket = randomUUID();
          const runDirectory = join(
            queued.job_id,
            `attempt-${attemptNo}`,
            `fence-${fence}`,
          );
          this.#database
            .prepare(
              "INSERT INTO attempts (job_id, attempt_no, owner_instance_id, fence, lease_expires_at, producer_identity_json, producer_incarnation_id, launch_ticket, run_directory, tile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              queued.job_id,
              attemptNo,
              ownerInstanceId,
              fence,
              leaseExpiresAt,
              JSON.stringify({
                jobId: queued.job_id,
                attemptNo,
                ownerInstanceId,
                fence,
              }),
              this.#incarnationId,
              launchTicket,
              runDirectory,
              stored.job.plan.engine.tile,
            );
          this.#database
            .prepare(
              "UPDATE jobs SET status = 'running', first_started_at = ?, execution_deadline_at = ?, active_attempt_no = ?, current_fence = ? WHERE job_id = ? AND status = 'queued'",
            )
            .run(
              firstStartedAt,
              executionDeadlineAt,
              attemptNo,
              fence,
              queued.job_id,
            );
          this.#database
            .prepare(
              "INSERT INTO execution_slot (singleton, job_id, attempt_no, fence) VALUES (1, ?, ?, ?)",
            )
            .run(queued.job_id, attemptNo, fence);
          const running = this.#database
            .prepare("SELECT * FROM jobs WHERE job_id = ?")
            .get(queued.job_id) as JobRow;
          const workingDirectory = join(this.#attemptDirectory, runDirectory);
          return freezeTree({
            identity: {
              jobId: queued.job_id,
              attemptNo,
              ownerInstanceId,
              fence,
            },
            job: this.#fromRow(running).job,
            executionPolicy: stored.executionPolicy,
            firstStartedAt,
            executionDeadlineAt,
            leaseExpiresAt,
            launchTicket,
            inputPath: join(this.inputDirectory, queued.job_id, "engine.png"),
            workingDirectory,
            outputPath: join(workingDirectory, "output.part.png"),
            tile: stored.job.plan.engine.tile,
          });
        })
        .immediate(),
    );
  }

  #readAttempt(identity: AttemptIdentity): AttemptRow | undefined {
    return this.#database
      .prepare(
        `
      SELECT a.*, j.execution_deadline_at
      FROM attempts a
      JOIN jobs j ON j.job_id = a.job_id
      JOIN execution_slot s ON s.job_id = a.job_id AND s.attempt_no = a.attempt_no AND s.fence = a.fence
      WHERE j.status = 'running' AND j.active_attempt_no = a.attempt_no AND j.current_fence = a.fence
        AND a.job_id = ? AND a.attempt_no = ? AND a.owner_instance_id = ? AND a.fence = ?
    `,
      )
      .get(
        identity.jobId,
        identity.attemptNo,
        identity.ownerInstanceId,
        identity.fence,
      ) as AttemptRow | undefined;
  }

  #currentAttempt(identity: AttemptIdentity): AttemptRow | undefined {
    const now = this.now();
    const row = this.#writableAttempt(identity);
    return row &&
      now <= row.lease_expires_at &&
      now <= row.execution_deadline_at &&
      row.stop_reason === null &&
      row.sealed_at === null &&
      row.exit_json === null
      ? row
      : undefined;
  }

  #writableAttempt(identity: AttemptIdentity): AttemptRow | undefined {
    const row = this.#readAttempt(identity);
    if (
      !row ||
      this.#database
        .prepare(
          "SELECT 1 FROM recovery_controls WHERE job_id = ? AND attempt_no = ? AND state = 'active'",
        )
        .get(row.job_id, row.attempt_no)
    )
      return;
    return row;
  }

  registerPrepared(
    identity: AttemptIdentity,
    descriptor: OwnerDescriptor,
  ): boolean {
    return safe(() =>
      this.#database
        .transaction(() => {
          const row = this.#currentAttempt(identity);
          if (
            !row ||
            row.owner_descriptor_json !== null ||
            row.authorized_at !== null
          )
            return false;
          const owner = freezeOwnerDescriptor(descriptor, row.launch_ticket);
          const text = JSON.stringify(owner);
          const now = this.now();
          if (now > row.lease_expires_at || now > row.execution_deadline_at)
            return false;
          return (
            this.#database
              .prepare(
                "UPDATE attempts SET owner_descriptor_json = ?, prepared_at = ? WHERE job_id = ? AND attempt_no = ? AND fence = ? AND owner_descriptor_json IS NULL AND authorized_at IS NULL",
              )
              .run(
                text,
                now,
                identity.jobId,
                identity.attemptNo,
                identity.fence,
              ).changes === 1
          );
        })
        .immediate(),
    );
  }

  authorizeLaunch(
    identity: AttemptIdentity,
    descriptor: OwnerDescriptor,
  ): boolean {
    return safe(() =>
      this.#database
        .transaction(() => {
          const row = this.#currentAttempt(identity);
          if (
            !row ||
            row.owner_descriptor_json === null ||
            row.authorized_at !== null
          )
            return false;
          const owner = freezeOwnerDescriptor(descriptor, row.launch_ticket);
          if (!isDeepStrictEqual(JSON.parse(row.owner_descriptor_json), owner))
            return false;
          const now = this.now();
          if (now > row.lease_expires_at || now > row.execution_deadline_at)
            return false;
          return (
            this.#database
              .prepare(
                "UPDATE attempts SET authorized_at = ? WHERE job_id = ? AND attempt_no = ? AND fence = ? AND authorized_at IS NULL",
              )
              .run(now, identity.jobId, identity.attemptNo, identity.fence)
              .changes === 1
          );
        })
        .immediate(),
    );
  }

  hasRegisteredInput(jobId: string) {
    return safe(() =>
      Boolean(
        this.#database
          .prepare("SELECT 1 FROM jobs WHERE job_id = ?")
          .get(jobId),
      ),
    );
  }
}

export type EnhancementStore = Store;

// Internal startup classification; the public code/status remain unchanged.
export class StoreSchemaVersionMismatch extends EnhancementError {
  constructor() { super("configuration_invalid"); }
}

function connect(options: StoreOptions, initialize: boolean): Store {
  if (
    !isAbsolute(options.directory) ||
    typeof options.clock !== "function" ||
    (options.interruptionEvidenceReader !== undefined &&
      typeof options.interruptionEvidenceReader !== "function")
  )
    throw new EnhancementError("configuration_invalid");
  const directory = resolve(options.directory);
  const path = join(directory, "worker.sqlite");
  if (!initialize && !existsSync(path))
    throw new EnhancementError("store_not_initialized");
  let firstCreatedDirectory: string | undefined;
  if (initialize) {
    firstCreatedDirectory = mkdirSync(directory, {
      recursive: true,
      mode: 0o700,
    });
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      )
        throw new EnhancementError("store_already_initialized");
      throw new EnhancementError("internal_error");
    }
  }
  let database: Database.Database | undefined;
  try {
    if (!initialize) {
      const schemaProbe = new Database(path, {
        readonly: true,
        fileMustExist: true,
        timeout: 0,
      });
      try {
        if (schemaProbe.pragma("user_version", { simple: true }) !== 7)
          throw new StoreSchemaVersionMismatch();
      } finally {
        schemaProbe.close();
      }
    }
    database = new Database(path, { fileMustExist: true, timeout: 0 });
    database.pragma("locking_mode = EXCLUSIVE");
    database.pragma("journal_mode = DELETE");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    const connection = database;
    let serviceId = "";
    const incarnationId = randomUUID();
    connection
      .transaction(() => {
        const now = options.clock();
        if (!Number.isSafeInteger(now) || now < 0)
          throw new EnhancementError("configuration_invalid");
        if (initialize) {
          serviceId = randomUUID();
          connection.exec(`
          CREATE TABLE service_identity (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            service_id TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE store_incarnations (
            incarnation_id TEXT PRIMARY KEY,
            opened_at INTEGER NOT NULL CHECK (opened_at >= 0 AND opened_at <= 9007199254740991)
          ) STRICT;
          CREATE TABLE clients (
            client_id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE credentials (
            credential_id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL REFERENCES clients(client_id),
            version INTEGER NOT NULL CHECK (version > 0),
            key_digest TEXT NOT NULL UNIQUE CHECK (length(key_digest) = 64),
            created_at INTEGER NOT NULL,
            revoked_at INTEGER,
            UNIQUE (client_id, version)
          ) STRICT;
          CREATE TABLE jobs (
            queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (queue_sequence > 0 AND queue_sequence <= 9007199254740991),
            job_id TEXT NOT NULL UNIQUE,
            client_id TEXT NOT NULL REFERENCES clients(client_id),
            idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
            request_identity TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
            reason TEXT CHECK (reason IS NULL OR reason IN ('user_cancel', 'queue_timeout', 'execution_timeout', 'execution_failed', 'invalid_output')),
            created_at INTEGER NOT NULL,
            queue_deadline_at INTEGER NOT NULL,
            completed_at INTEGER,
            result_candidate_id TEXT,
            cancel_requested_at INTEGER CHECK (cancel_requested_at >= 0 AND cancel_requested_at <= 9007199254740991),
            source_json TEXT NOT NULL,
            engine_json TEXT NOT NULL,
            plan_json TEXT NOT NULL,
            execution_policy_json TEXT NOT NULL,
            first_started_at INTEGER,
            execution_deadline_at INTEGER,
            active_attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (active_attempt_no >= 0 AND active_attempt_no <= 9007199254740991),
            current_fence INTEGER NOT NULL DEFAULT 0 CHECK (current_fence >= 0 AND current_fence <= 9007199254740991),
            CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
            CHECK ((status = 'succeeded') = (result_candidate_id IS NOT NULL)),
            CHECK (status <> 'succeeded' OR reason IS NULL),
            FOREIGN KEY (result_candidate_id, job_id, active_attempt_no)
              REFERENCES artifact_candidates(candidate_id, job_id, attempt_no),
            UNIQUE (client_id, idempotency_key)
          ) STRICT;
          CREATE INDEX jobs_waiting ON jobs(status, created_at, queue_sequence);
          CREATE TABLE attempts (
            job_id TEXT NOT NULL REFERENCES jobs(job_id),
            attempt_no INTEGER NOT NULL CHECK (attempt_no > 0 AND attempt_no <= 9007199254740991),
            owner_instance_id TEXT NOT NULL,
            fence INTEGER NOT NULL CHECK (fence > 0 AND fence <= 9007199254740991),
            lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at >= 0 AND lease_expires_at <= 9007199254740991),
            producer_identity_json TEXT NOT NULL CHECK (json_valid(producer_identity_json)),
            producer_incarnation_id TEXT NOT NULL REFERENCES store_incarnations(incarnation_id),
            launch_ticket TEXT NOT NULL UNIQUE,
            run_directory TEXT NOT NULL UNIQUE,
            tile INTEGER NOT NULL,
            owner_descriptor_json TEXT,
            prepared_at INTEGER,
            authorized_at INTEGER,
            stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('user_cancel', 'execution_timeout')),
            stop_requested_at INTEGER CHECK (stop_requested_at >= 0 AND stop_requested_at <= 9007199254740991),
            terminate_after_at INTEGER CHECK (terminate_after_at >= 0 AND terminate_after_at <= 9007199254740991),
            exit_json TEXT,
            exit_observed_at INTEGER CHECK (exit_observed_at >= 0 AND exit_observed_at <= 9007199254740991),
            sealed_at INTEGER CHECK (sealed_at >= 0 AND sealed_at <= 9007199254740991),
            PRIMARY KEY (job_id, attempt_no),
            UNIQUE (job_id, attempt_no, fence),
            UNIQUE (job_id, attempt_no, launch_ticket),
            CHECK (authorized_at IS NULL OR (owner_descriptor_json IS NOT NULL AND prepared_at IS NOT NULL)),
            CHECK (sealed_at IS NULL OR (authorized_at IS NULL AND exit_json IS NULL)),
            CHECK (json_extract(producer_identity_json, '$.jobId') = job_id
              AND json_extract(producer_identity_json, '$.attemptNo') = attempt_no),
            CHECK ((stop_reason IS NULL AND stop_requested_at IS NULL AND terminate_after_at IS NULL)
              OR (stop_reason IS NOT NULL AND stop_requested_at IS NOT NULL AND terminate_after_at IS NOT NULL AND terminate_after_at >= stop_requested_at)),
            CHECK ((exit_json IS NULL) = (exit_observed_at IS NULL))
          ) STRICT;
          CREATE TRIGGER attempts_source_immutable
          BEFORE UPDATE OF producer_identity_json, producer_incarnation_id, launch_ticket, run_directory, tile ON attempts
          WHEN NEW.producer_identity_json IS NOT OLD.producer_identity_json
            OR NEW.producer_incarnation_id IS NOT OLD.producer_incarnation_id
            OR NEW.launch_ticket IS NOT OLD.launch_ticket
            OR NEW.run_directory IS NOT OLD.run_directory OR NEW.tile IS NOT OLD.tile
          BEGIN SELECT RAISE(ABORT, 'immutable attempt source'); END;
          CREATE TABLE artifact_candidates (
            candidate_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL,
            producer_identity_json TEXT NOT NULL CHECK (json_valid(producer_identity_json)),
            launch_ticket TEXT NOT NULL,
            directory TEXT NOT NULL UNIQUE,
            manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
            manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
            manifest_byte_length INTEGER NOT NULL CHECK (manifest_byte_length > 0 AND manifest_byte_length <= 9007199254740991),
            state TEXT NOT NULL CHECK (state IN ('intent', 'durable')),
            created_at INTEGER NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
            durable_at INTEGER CHECK (durable_at >= 0 AND durable_at <= 9007199254740991),
            UNIQUE (candidate_id, job_id, attempt_no),
            FOREIGN KEY (job_id, attempt_no, launch_ticket) REFERENCES attempts(job_id, attempt_no, launch_ticket),
            CHECK ((state = 'durable') = (durable_at IS NOT NULL)),
            CHECK (json_extract(producer_identity_json, '$.jobId') = job_id
              AND json_extract(producer_identity_json, '$.attemptNo') = attempt_no)
          ) STRICT;
          CREATE UNIQUE INDEX artifact_one_durable ON artifact_candidates(job_id, attempt_no) WHERE state = 'durable';
          CREATE TRIGGER artifact_candidate_immutable
          BEFORE UPDATE ON artifact_candidates
          WHEN NEW.candidate_id IS NOT OLD.candidate_id OR NEW.job_id IS NOT OLD.job_id
            OR NEW.attempt_no IS NOT OLD.attempt_no OR NEW.producer_identity_json IS NOT OLD.producer_identity_json
            OR NEW.launch_ticket IS NOT OLD.launch_ticket OR NEW.directory IS NOT OLD.directory
            OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
            OR NEW.manifest_byte_length IS NOT OLD.manifest_byte_length OR NEW.created_at IS NOT OLD.created_at
            OR (OLD.state = 'durable' AND (NEW.state IS NOT OLD.state OR NEW.durable_at IS NOT OLD.durable_at))
          BEGIN SELECT RAISE(ABORT, 'immutable artifact candidate'); END;
          CREATE TABLE artifact_references (
            reference_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL,
            publisher_identity_json TEXT NOT NULL CHECK (json_valid(publisher_identity_json)),
            incarnation_id TEXT NOT NULL REFERENCES store_incarnations(incarnation_id),
            purpose TEXT NOT NULL CHECK (purpose IN ('run', 'recovery')),
            candidate_id TEXT,
            acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0 AND acquired_at <= 9007199254740991),
            released_at INTEGER CHECK (released_at >= 0 AND released_at <= 9007199254740991),
            FOREIGN KEY (job_id, attempt_no) REFERENCES attempts(job_id, attempt_no),
            FOREIGN KEY (candidate_id, job_id, attempt_no) REFERENCES artifact_candidates(candidate_id, job_id, attempt_no),
            CHECK (json_extract(publisher_identity_json, '$.jobId') = job_id
              AND json_extract(publisher_identity_json, '$.attemptNo') = attempt_no)
          ) STRICT;
          CREATE INDEX artifact_references_source ON artifact_references(job_id, attempt_no, acquired_at);
          CREATE TRIGGER artifact_reference_immutable
          BEFORE UPDATE ON artifact_references
          WHEN NEW.reference_id IS NOT OLD.reference_id OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt_no IS NOT OLD.attempt_no
            OR NEW.publisher_identity_json IS NOT OLD.publisher_identity_json OR NEW.incarnation_id IS NOT OLD.incarnation_id
            OR NEW.purpose IS NOT OLD.purpose OR NEW.acquired_at IS NOT OLD.acquired_at
            OR (OLD.candidate_id IS NOT NULL AND NEW.candidate_id IS NOT OLD.candidate_id)
            OR (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)
          BEGIN SELECT RAISE(ABORT, 'immutable artifact reference'); END;
          CREATE TABLE artifact_observations (
            reference_id TEXT NOT NULL REFERENCES artifact_references(reference_id),
            observation_no INTEGER NOT NULL CHECK (observation_no > 0 AND observation_no <= 9007199254740991),
            candidate_id TEXT REFERENCES artifact_candidates(candidate_id),
            code TEXT NOT NULL CHECK (code IN ('io_failure', 'engine_integrity', 'candidate_integrity', 'output_invalid', 'no_qualified_candidate', 'publication_unknown')),
            stage TEXT CHECK (stage IS NULL OR stage IN ('open', 'stat', 'read', 'mkdir', 'write', 'file_sync', 'close', 'rename', 'directory_sync', 'acquire_commit', 'reserve_commit', 'candidate_commit', 'success_commit', 'observation_commit', 'release_commit')),
            checked_engine_sha256 TEXT CHECK (checked_engine_sha256 IS NULL OR length(checked_engine_sha256) = 64),
            observed_at INTEGER NOT NULL CHECK (observed_at >= 0 AND observed_at <= 9007199254740991),
            PRIMARY KEY (reference_id, observation_no),
            CHECK ((code = 'io_failure' AND stage IS NOT NULL AND checked_engine_sha256 IS NULL)
              OR (code <> 'io_failure' AND stage IS NULL))
          ) STRICT;
          CREATE TABLE result_receipts (
            job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
            client_id TEXT NOT NULL REFERENCES clients(client_id),
            receipt_id TEXT NOT NULL CHECK (length(receipt_id) = 36),
            candidate_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL CHECK (attempt_no > 0 AND attempt_no <= 9007199254740991),
            received_at INTEGER NOT NULL CHECK (received_at >= 0 AND received_at <= 9007199254740991),
            UNIQUE (client_id, receipt_id),
            FOREIGN KEY (candidate_id, job_id, attempt_no)
              REFERENCES artifact_candidates(candidate_id, job_id, attempt_no)
          ) STRICT;
          CREATE TRIGGER result_receipt_immutable
          BEFORE UPDATE ON result_receipts
          BEGIN SELECT RAISE(ABORT, 'immutable result receipt'); END;
          CREATE TABLE result_retirements (
            job_id TEXT PRIMARY KEY REFERENCES result_receipts(job_id),
            candidate_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL CHECK (attempt_no > 0 AND attempt_no <= 9007199254740991),
            retention_ms INTEGER NOT NULL CHECK (retention_ms > 0 AND retention_ms <= 9007199254740991),
            retired_at INTEGER NOT NULL CHECK (retired_at >= 0 AND retired_at <= 9007199254740991),
            cleaned_at INTEGER CHECK (cleaned_at >= 0 AND cleaned_at <= 9007199254740991),
            FOREIGN KEY (candidate_id, job_id, attempt_no)
              REFERENCES artifact_candidates(candidate_id, job_id, attempt_no),
            CHECK (cleaned_at IS NULL OR cleaned_at >= retired_at)
          ) STRICT;
          CREATE TRIGGER result_retirement_immutable
          BEFORE UPDATE ON result_retirements
          WHEN NEW.job_id IS NOT OLD.job_id OR NEW.candidate_id IS NOT OLD.candidate_id
            OR NEW.attempt_no IS NOT OLD.attempt_no OR NEW.retention_ms IS NOT OLD.retention_ms
            OR NEW.retired_at IS NOT OLD.retired_at
            OR (OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS NOT OLD.cleaned_at)
          BEGIN SELECT RAISE(ABORT, 'immutable result retirement'); END;
          CREATE TRIGGER result_retirement_no_delete
          BEFORE DELETE ON result_retirements
          BEGIN SELECT RAISE(ABORT, 'immutable result retirement'); END;
          CREATE TABLE execution_slot (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            job_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL,
            fence INTEGER NOT NULL,
            FOREIGN KEY (job_id, attempt_no, fence) REFERENCES attempts(job_id, attempt_no, fence) ON UPDATE CASCADE
          ) STRICT;
          CREATE TABLE recovery_controls (
            recovery_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL,
            owner_instance_id TEXT NOT NULL,
            incarnation_id TEXT NOT NULL REFERENCES store_incarnations(incarnation_id),
            source_incarnation_id TEXT NOT NULL REFERENCES store_incarnations(incarnation_id),
            source_identity_json TEXT NOT NULL CHECK (json_valid(source_identity_json)),
            publisher_identity_json TEXT NOT NULL CHECK (json_valid(publisher_identity_json)),
            launch_ticket TEXT NOT NULL REFERENCES attempts(launch_ticket),
            state TEXT NOT NULL CHECK (state IN ('active', 'replaced', 'consumed')),
            classification TEXT NOT NULL CHECK (classification IN ('inspecting', 'unknown', 'owned-alive', 'tree-exited', 'never-authorized')),
            created_at INTEGER NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
            observed_at INTEGER CHECK (observed_at >= 0 AND observed_at <= 9007199254740991),
            consumed_at INTEGER CHECK (consumed_at >= 0 AND consumed_at <= 9007199254740991),
            FOREIGN KEY (job_id, attempt_no) REFERENCES attempts(job_id, attempt_no),
            CHECK ((classification = 'inspecting') = (observed_at IS NULL)),
            CHECK ((state = 'consumed' AND consumed_at IS NOT NULL AND classification IN ('tree-exited', 'never-authorized'))
              OR (state IN ('active', 'replaced') AND consumed_at IS NULL AND classification IN ('inspecting', 'unknown', 'owned-alive')))
          ) STRICT;
          CREATE UNIQUE INDEX recovery_control_active ON recovery_controls(job_id, attempt_no) WHERE state = 'active';
          CREATE TABLE recovery_events (
            event_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('never-authorized', 'authorized-interruption')),
            job_id TEXT NOT NULL REFERENCES jobs(job_id),
            source_identity_json TEXT NOT NULL CHECK (json_valid(source_identity_json)),
            launch_ticket TEXT NOT NULL REFERENCES attempts(launch_ticket),
            source_incarnation_id TEXT NOT NULL REFERENCES store_incarnations(incarnation_id),
            recovery_incarnation_id TEXT NOT NULL REFERENCES store_incarnations(incarnation_id),
            interrupted_at INTEGER NOT NULL CHECK (interrupted_at >= 0 AND interrupted_at <= 9007199254740991),
            sealed_at INTEGER CHECK (sealed_at >= 0 AND sealed_at <= 9007199254740991),
            evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
            consumed_publisher_identity_json TEXT CHECK (consumed_publisher_identity_json IS NULL OR json_valid(consumed_publisher_identity_json)),
            replacement_attempt_no INTEGER CHECK (replacement_attempt_no > 0 AND replacement_attempt_no <= 9007199254740991),
            consumed_at INTEGER CHECK (consumed_at >= 0 AND consumed_at <= 9007199254740991),
            UNIQUE (job_id, event_id),
            UNIQUE (job_id, launch_ticket),
            FOREIGN KEY (job_id, replacement_attempt_no) REFERENCES attempts(job_id, attempt_no),
            CHECK (source_incarnation_id <> recovery_incarnation_id),
            CHECK ((kind = 'never-authorized' AND sealed_at IS NOT NULL AND evidence_json IS NULL)
              OR (kind = 'authorized-interruption' AND sealed_at IS NULL AND evidence_json IS NOT NULL
                AND json_type(evidence_json) IS 'object'
                AND json_type(evidence_json, '$.v') IS 'integer' AND json_extract(evidence_json, '$.v') IS 1)),
            CHECK ((consumed_publisher_identity_json IS NULL AND replacement_attempt_no IS NULL AND consumed_at IS NULL)
              OR (consumed_publisher_identity_json IS NOT NULL AND replacement_attempt_no IS NOT NULL AND consumed_at IS NOT NULL))
          ) STRICT;
          PRAGMA user_version = 7;
        `);
          connection
            .prepare("INSERT INTO service_identity VALUES (1, ?, ?)")
            .run(serviceId, now);
        } else {
          if (connection.pragma("user_version", { simple: true }) !== 7)
            throw new EnhancementError("configuration_invalid");
          try {
            connection
              .prepare(
                "SELECT job_id, client_id, receipt_id, candidate_id, attempt_no, received_at FROM result_receipts LIMIT 0",
              )
              .all();
            connection
              .prepare(
                "SELECT job_id, candidate_id, attempt_no, retention_ms, retired_at, cleaned_at FROM result_retirements LIMIT 0",
              )
              .all();
          } catch {
            throw new EnhancementError("configuration_invalid");
          }
          const row = connection
            .prepare(
              "SELECT service_id FROM service_identity WHERE singleton = 1",
            )
            .get() as { service_id: string } | undefined;
          if (!row?.service_id)
            throw new EnhancementError("store_not_initialized");
          serviceId = row.service_id;
        }
        connection
          .prepare(
            "INSERT INTO store_incarnations (incarnation_id, opened_at) VALUES (?, ?)",
          )
          .run(incarnationId, now);
      })
      .exclusive();
    mkdirSync(join(directory, "inputs"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(directory, "attempts"), {
      recursive: true,
      mode: 0o700,
    });
    const lastDirectoryToSync = firstCreatedDirectory
      ? dirname(firstCreatedDirectory)
      : directory;
    for (let current = directory; ; current = dirname(current)) {
      const directoryHandle = openSync(
        current,
        process.platform === "win32" ? "r+" : "r",
      );
      try {
        fs.fsyncSync(directoryHandle);
      } finally {
        closeSync(directoryHandle);
      }
      if (toNamespacedPath(current) === toNamespacedPath(lastDirectoryToSync))
        break;
    }
    return new Store(connection, options, serviceId, incarnationId);
  } catch (error) {
    if (database?.open) database.close();
    if (error instanceof EnhancementError) throw error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
    )
      throw new EnhancementError("store_locked");
    throw new EnhancementError("internal_error");
  }
}

export function initializeStore(options: StoreOptions) {
  const store = safe(() => connect(options, true));
  try {
    return Object.freeze({ store, credential: createClient(store) });
  } catch (error) {
    store.close();
    throw error;
  }
}

export function openStore(options: StoreOptions): EnhancementStore {
  return safe(() => connect(options, false));
}
