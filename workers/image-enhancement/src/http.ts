import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  createSubmissionLimits,
  createWorkerConfig,
  type SubmissionLimits,
  type RunnerLimits,
  type WorkerConfig,
} from "./config.js";
import { createArtifacts, type ArtifactFiles } from "./artifacts.js";
import type { MaintenanceSnapshot } from "./bootstrap.js";
import {
  EnhancementError,
  parseReceiptRequest,
  toErrorResponse,
  type FixedSelfTestSnapshot,
} from "./contracts.js";
import {
  authenticate,
  revokeCredential,
  rotateCredential,
} from "./credentials.js";
import {
  createHttpTransportLimits,
  requestByteBudget,
  type HttpTransportLimits,
} from "./http-config.js";
import { createJobService, type localInputFiles } from "./jobs.js";
import {
  localUploadFiles,
  receiveMultipart,
  type UploadFiles,
  type UploadTimer,
} from "./multipart.js";
import type { AuthenticatedClient, EnhancementStore } from "./store.js";

export { createHttpTransportLimits, localUploadFiles };
export type { HttpTransportLimits, UploadFiles, UploadTimer };
export type HttpFileIoActivity = Readonly<{
  sealed: boolean;
  uploads: number;
  downloads: number;
  receipts: number;
}>;
export type HttpFileIoOwner = Readonly<{
  sealFileIo(): void;
  pendingRequests(): number;
  activity(): HttpFileIoActivity;
}>;
export type EnhancementHandler = RequestListener & HttpFileIoOwner;
export type EnhancementServer = Server & Readonly<{ fileIo: HttpFileIoOwner }>;
export type EnhancementHttpOptions = Readonly<{
  store: EnhancementStore;
  config: () => WorkerConfig;
  submissionLimits: SubmissionLimits;
  runnerLimits: RunnerLimits;
  transportLimits: HttpTransportLimits;
  selfTest?: Readonly<{
    start(principal: AuthenticatedClient): Promise<FixedSelfTestSnapshot>;
    query(principal: AuthenticatedClient): Promise<FixedSelfTestSnapshot>;
  }>;
  maintenance?: Readonly<{
    enter(principal: AuthenticatedClient): MaintenanceSnapshot;
    query(principal: AuthenticatedClient): MaintenanceSnapshot;
  }>;
  ready?: () => boolean;
  onJobCommitted?: () => void | Promise<void>;
  uploadFiles?: UploadFiles;
  inputFiles?: typeof localInputFiles;
  uploadTimer?: UploadTimer;
  resultFiles?: ArtifactFiles;
  downloadTimer?: UploadTimer;
  receiptTimer?: UploadTimer;
}>;

const localDownloadTimer: UploadTimer = Object.freeze({
  start(callback: () => void, milliseconds: number) {
    const timeout = setTimeout(callback, milliseconds);
    timeout.unref();
    return () => clearTimeout(timeout);
  },
});

function singleHeader(
  request: IncomingMessage,
  name: string,
  error: "authentication_failed" | "invalid_request",
) {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]!.toLowerCase() === name)
      values.push(request.rawHeaders[i + 1]!);
  if (values.length !== 1) throw new EnhancementError(error);
  return values[0]!;
}

function closeUnreadInput(
  request: IncomingMessage,
  response: ServerResponse,
  force = false,
) {
  if (!force && request.complete) return;
  request.pause();
  // A zero-byte read can claim the paused request while its buffer has room.
  request.read(0);
  response.shouldKeepAlive = false;
  response.setHeader("connection", "close");
  // Pause Node's scheduled automatic drain; its Connection: close path closes the socket.
  response.once("finish", () => request.pause());
}

function json(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
  closeInput = false,
) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (response.writableEnded) return;
  closeUnreadInput(request, response, closeInput);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function errorResponse(
  request: IncomingMessage,
  response: ServerResponse,
  error: unknown,
  requestId: string,
) {
  try {
    const result = toErrorResponse(error, requestId);
    json(request, response, result.status, result.body, true);
  } catch {
    response.destroy();
  }
}

function ok(
  request: IncomingMessage,
  response: ServerResponse,
  data: unknown,
  status = 200,
) {
  json(request, response, status, { code: "ok", data, msg: "成功。" });
}

async function receiveReceiptJson(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new EnhancementError("invalid_request");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  let finish!: (error: EnhancementError | undefined) => void;
  const completion = new Promise<EnhancementError | undefined>((resolve) => {
    finish = resolve;
  });

  function complete(error?: EnhancementError) {
    if (settled) return;
    settled = true;
    finish(error);
  }

  const ended = () => complete();
  const failed = () => complete(new EnhancementError("invalid_request"));
  const closed = () => {
    if (!request.complete) failed();
  };
  const received = (chunk: Buffer) => {
    if (settled) return;
    if (chunk.length > maxBytes - bytes) {
      complete(new EnhancementError("budget_exceeded"));
      request.pause();
      return;
    }
    bytes += chunk.length;
    chunks.push(Buffer.from(chunk));
  };

  request.once("end", ended);
  request.once("error", failed);
  request.once("aborted", failed);
  request.once("close", closed);
  signal.addEventListener("abort", failed, { once: true });
  try {
    if (signal.aborted) failed();
    if (!settled) request.on("data", received);
    const error = await completion;
    if (error) throw error;
    if (!request.complete) throw new EnhancementError("invalid_request");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      );
      return parseReceiptRequest(JSON.parse(text) as unknown);
    } catch {
      throw new EnhancementError("invalid_request");
    }
  } finally {
    request.off("data", received);
    request.off("end", ended);
    request.off("error", failed);
    request.off("aborted", failed);
    request.off("close", closed);
    signal.removeEventListener("abort", failed);
    request.pause();
  }
}

export function createEnhancementHandler(
  options: EnhancementHttpOptions,
): EnhancementHandler {
  const limits = createHttpTransportLimits(options.transportLimits);
  const submissionLimits = createSubmissionLimits(options.submissionLimits);
  const config = () => createWorkerConfig(options.config());
  let fileIoSealed = false;
  const ready = () =>
    !fileIoSealed && options.ready?.() === true && !fileIoSealed;
  requestByteBudget(config().budgets.input.maxBytes, limits);
  const jobs = createJobService({
    store: options.store,
    config,
    ready,
    limits: submissionLimits,
    runnerLimits: options.runnerLimits,
    files: options.inputFiles,
  });
  const artifacts = createArtifacts({
    store: options.store,
    files: options.resultFiles,
  });
  const downloadTimer = options.downloadTimer ?? localDownloadTimer;
  const receiptTimer = options.receiptTimer ?? localDownloadTimer;
  let uploads = 0;
  let downloads = 0;
  let receipts = 0;
  let requests = 0;

  function notifyJobCommitted() {
    try {
      const pending = options.onJobCommitted?.();
      if (pending)
        void pending.catch(() => console.error("enhancement_wake_failed"));
    } catch {
      console.error("enhancement_wake_failed");
    }
  }

  async function download(
    principal: AuthenticatedClient,
    jobId: string,
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ) {
    if (fileIoSealed) throw new EnhancementError("not_ready");
    if (downloads >= limits.maxConcurrentDownloads)
      throw new EnhancementError("download_capacity_exceeded");
    downloads++;
    const abort = new AbortController();
    let sealed = false;
    let readerSettled = false;
    let responseSettled = false;
    let released = false;
    let cancelTimer = () => {};

    function seal() {
      if (sealed) return false;
      sealed = true;
      abort.abort();
      return true;
    }

    function release() {
      if (released || !readerSettled || !responseSettled) return;
      released = true;
      downloads--;
      request.off("aborted", disconnected);
      request.off("error", disconnected);
      response.off("finish", responseCompleted);
      response.off("close", responseCompleted);
      response.off("error", disconnected);
      cancelTimer();
    }

    function disconnected() {
      seal();
      response.destroy();
    }

    function responseCompleted() {
      seal();
      responseSettled = true;
      release();
    }

    function timedOut() {
      if (!seal()) {
        if (!responseSettled) response.destroy();
        return;
      }
      errorResponse(
        request,
        response,
        new EnhancementError("download_timeout"),
        requestId,
      );
    }

    request.once("aborted", disconnected);
    request.once("error", disconnected);
    response.once("finish", responseCompleted);
    response.once("close", responseCompleted);
    response.once("error", disconnected);
    try {
      cancelTimer = downloadTimer.start(timedOut, limits.requestTimeoutMs);
      if (fileIoSealed) throw new EnhancementError("not_ready");
      if (
        sealed ||
        request.aborted ||
        request.socket.destroyed ||
        !request.socket.writable ||
        response.destroyed ||
        !response.writable ||
        response.writableEnded
      ) {
        disconnected();
        return;
      }
      const artifact = await artifacts.readPublished(
        principal,
        jobId,
        abort.signal,
      );
      if (sealed || abort.signal.aborted) return;
      closeUnreadInput(request, response);
      if (sealed || abort.signal.aborted) return;
      if (options.store.closed) throw new EnhancementError("internal_error");
      options.store.assertPrincipal(principal);
      if (
        request.aborted ||
        request.socket.destroyed ||
        !request.socket.writable ||
        response.destroyed ||
        !response.writable ||
        response.writableEnded ||
        response.headersSent
      ) {
        disconnected();
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": artifact.bytes.byteLength,
        etag: `"${artifact.sha256}"`,
        "cache-control": "no-store",
      });
      response.end(artifact.bytes);
    } catch (error) {
      if (seal()) errorResponse(request, response, error, requestId);
    } finally {
      // Abort or a closed response cannot settle already-issued artifact I/O.
      readerSettled = true;
      release();
    }
  }

  async function receipt(
    principal: AuthenticatedClient,
    jobId: string,
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ) {
    if (fileIoSealed) throw new EnhancementError("not_ready");
    const contentType = singleHeader(
      request,
      "content-type",
      "invalid_request",
    );
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(
        contentType,
      )
    )
      throw new EnhancementError("unsupported_media_type");
    if (
      request.headers["content-encoding"] !== undefined &&
      !/^identity$/i.test(
        singleHeader(request, "content-encoding", "invalid_request"),
      )
    )
      throw new EnhancementError("unsupported_media_type");
    if (
      request.headers["content-length"] !== undefined &&
      Number(request.headers["content-length"]) > limits.maxReceiptBytes
    )
      throw new EnhancementError("budget_exceeded");
    if (receipts >= limits.maxConcurrentReceipts)
      throw new EnhancementError("receipt_capacity_exceeded");
    receipts++;
    const abort = new AbortController();
    let sealed = false;
    let receiverSettled = false;
    let responseSettled = false;
    let released = false;
    let cancelTimer = () => {};

    function seal() {
      if (sealed) return false;
      sealed = true;
      abort.abort();
      return true;
    }

    function release() {
      if (released || !receiverSettled || !responseSettled) return;
      released = true;
      receipts--;
      request.off("aborted", disconnected);
      request.off("error", disconnected);
      response.off("finish", responseCompleted);
      response.off("close", responseCompleted);
      response.off("error", disconnected);
      cancelTimer();
    }

    function disconnected() {
      seal();
      response.destroy();
    }

    function responseCompleted() {
      seal();
      responseSettled = true;
      release();
    }

    function timedOut() {
      if (!seal()) {
        if (!responseSettled) response.destroy();
        return;
      }
      errorResponse(
        request,
        response,
        new EnhancementError("receipt_timeout"),
        requestId,
      );
    }

    request.once("aborted", disconnected);
    request.once("error", disconnected);
    response.once("finish", responseCompleted);
    response.once("close", responseCompleted);
    response.once("error", disconnected);
    try {
      cancelTimer = receiptTimer.start(timedOut, limits.requestTimeoutMs);
      if (sealed) return;
      if (options.store.closed) throw new EnhancementError("internal_error");
      options.store.assertPrincipal(principal);
      if (fileIoSealed) throw new EnhancementError("not_ready");
      if (
        request.aborted ||
        request.socket.destroyed ||
        !request.socket.writable ||
        response.destroyed ||
        !response.writable ||
        response.writableEnded
      ) {
        disconnected();
        return;
      }
      if (request.headers.expect?.toLowerCase() === "100-continue")
        response.writeContinue();
      const value = await receiveReceiptJson(
        request,
        limits.maxReceiptBytes,
        abort.signal,
      );
      if (sealed || abort.signal.aborted) return;
      if (options.store.closed) throw new EnhancementError("internal_error");
      options.store.assertPrincipal(principal);
      if (
        sealed ||
        abort.signal.aborted ||
        request.aborted ||
        request.socket.destroyed ||
        !request.socket.writable ||
        response.destroyed ||
        !response.writable ||
        response.writableEnded ||
        response.headersSent
      ) {
        disconnected();
        return;
      }
      const outcome = options.store.acknowledgeResult(
        principal,
        jobId,
        value,
        abort.signal,
      );
      ok(request, response, outcome);
    } catch (error) {
      if (seal()) errorResponse(request, response, error, requestId);
    } finally {
      receiverSettled = true;
      release();
    }
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ) {
    const principal = authenticate(
      options.store,
      singleHeader(request, "authorization", "authentication_failed"),
    );
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const selfTest = path === "/v1/self-test" ? options.selfTest : undefined;
    const maintenance =
      path === "/v1/maintenance" ? options.maintenance : undefined;
    const jobRoute =
      /^\/v1\/enhancement-jobs\/([^/]+)(?:\/(result|receipt))?$/.exec(path);
    const method =
      path === "/healthz" || path === "/v1/capabilities"
        ? "GET"
        : path === "/v1/enhancement-jobs" || path === "/v1/credentials"
          ? "POST"
          : path === "/v1/credentials/current"
            ? "DELETE"
            : jobRoute
              ? jobRoute[2] === "receipt"
                ? "POST"
                : jobRoute[2] === "result"
                  ? "GET"
                  : "GET|DELETE"
              : selfTest || maintenance
                ? "GET|POST"
                : undefined;
    if (!method) throw new EnhancementError("route_not_found");
    if (!method.split("|").includes(request.method ?? ""))
      throw new EnhancementError("method_not_allowed");
    if (
      selfTest ||
      maintenance ||
      path === "/v1/credentials" ||
      path === "/v1/credentials/current"
    ) {
      if (
        request.url?.includes("?") ||
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          Number(singleHeader(request, "content-length", "invalid_request")) !==
            0)
      )
        throw new EnhancementError("invalid_request");
      response.setHeader("cache-control", "no-store");
      if (maintenance) {
        const data =
          request.method === "POST"
            ? maintenance.enter(principal)
            : maintenance.query(principal);
        options.store.assertPrincipal(principal);
        return ok(request, response, data);
      }
      if (selfTest) {
        const data = await (request.method === "POST"
          ? selfTest.start(principal)
          : selfTest.query(principal));
        options.store.assertPrincipal(principal);
        return ok(
          request,
          response,
          data,
          request.method === "POST" ? 202 : 200,
        );
      }
      if (path === "/v1/credentials") {
        const credential = rotateCredential(
          options.store,
          { clientId: principal.clientId },
          principal,
        );
        return ok(request, response, {
          serviceId: options.store.identity.serviceId,
          credential,
        });
      }
      revokeCredential(options.store, principal.credentialId, principal);
      return ok(request, response, { revoked: true });
    }
    if (path === "/healthz") return ok(request, response, { alive: true });
    if (path === "/v1/capabilities") {
      const controlled = config();
      const isReady = ready();
      return ok(request, response, {
        serviceId: options.store.identity.serviceId,
        protocolVersion: controlled.protocolVersion,
        normalizationProfile: controlled.normalizationProfile,
        features: { expectedStrategyFingerprint: true },
        models: controlled.models.map((model) => ({
          id: model.id,
          binaryVersion: model.binaryVersion,
          binarySha256: model.binarySha256,
          modelVersion: model.modelVersion,
          modelSha256: model.modelSha256,
          nativeScale: model.nativeScale,
          allowedTiles: model.allowedTiles,
          defaultTile: model.defaultTile,
          tta: model.tta,
          ttaModes: [false, true],
          gpuId: model.gpuId,
        })),
        budgets: controlled.budgets,
        ready: isReady,
        reason: isReady ? null : "runner_unavailable",
      });
    }
    if (jobRoute) {
      const id = jobRoute[1]!;
      if (jobRoute[2]) {
        const job = jobs.get(principal, id);
        if (job.status !== "succeeded")
          throw new EnhancementError("result_not_ready");
        if (jobRoute[2] === "receipt")
          return receipt(principal, id, request, response, requestId);
        return download(principal, id, request, response, requestId);
      }
      if (request.method === "DELETE") {
        const outcome = jobs.cancel(principal, id);
        notifyJobCommitted();
        return ok(
          request,
          response,
          { job: outcome.job, applied: outcome.applied },
          outcome.status,
        );
      }
      return ok(request, response, { job: jobs.get(principal, id) });
    }
    const key = singleHeader(request, "idempotency-key", "invalid_request");
    if (
      key.length > submissionLimits.maxIdempotencyKeyLength ||
      !/^[\x21-\x7e]+$/.test(key)
    )
      throw new EnhancementError("invalid_request");
    const existing = options.store.findByKey(principal, key);
    const maxImageBytes =
      existing?.job.plan.budgets.input.maxBytes ??
      config().budgets.input.maxBytes;
    const maxRequestBytes = requestByteBudget(maxImageBytes, limits);
    const contentType = singleHeader(
      request,
      "content-type",
      "invalid_request",
    );
    if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType))
      throw new EnhancementError("unsupported_media_type");
    if (
      request.headers["content-length"] !== undefined &&
      Number(request.headers["content-length"]) > maxRequestBytes
    )
      throw new EnhancementError("budget_exceeded");
    if (fileIoSealed) throw new EnhancementError("not_ready");
    if (uploads >= limits.maxConcurrentUploads)
      throw new EnhancementError("upload_capacity_exceeded");
    uploads++;
    const abort = new AbortController();
    const disconnected = () =>
      abort.abort(new EnhancementError("invalid_request"));
    const responseClosed = () => {
      if (!response.writableFinished) disconnected();
    };
    request.once("aborted", disconnected);
    response.once("close", responseClosed);
    try {
      if (request.headers.expect?.toLowerCase() === "100-continue")
        response.writeContinue();
      const received = await receiveMultipart(request, {
        directory: options.store.inputDirectory,
        maxImageBytes,
        limits,
        files: options.uploadFiles ?? localUploadFiles,
        timer: options.uploadTimer,
        signal: abort.signal,
      });
      if (
        abort.signal.aborted ||
        request.socket.destroyed ||
        response.destroyed
      )
        throw new EnhancementError("invalid_request");
      if (fileIoSealed) throw new EnhancementError("not_ready");
      const accepted = await jobs.submit(
        principal,
        { idempotencyKey: key, ...received },
        abort.signal,
      );
      notifyJobCommitted();
      ok(request, response, accepted, 202);
    } finally {
      uploads--;
      request.off("aborted", disconnected);
      response.off("close", responseClosed);
    }
  }
  const handler: RequestListener = (request, response) => {
    const requestId = randomUUID();
    requests++;
    void (async () => {
      try { await handle(request, response, requestId); }
      catch (error) { errorResponse(request, response, error, requestId); }
      finally { requests--; }
    })();
  };
  return Object.assign(
    handler,
    Object.freeze({
      sealFileIo() {
        fileIoSealed = true;
      },
      pendingRequests() {
        return requests;
      },
      activity(): HttpFileIoActivity {
        return Object.freeze({
          sealed: fileIoSealed,
          uploads,
          downloads,
          receipts,
        });
      },
    }),
  );
}

export async function listenEnhancementServer(
  options: EnhancementHttpOptions,
  port: number,
  host = "127.0.0.1",
): Promise<EnhancementServer> {
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535 ||
    typeof host !== "string" ||
    !isIP(host)
  )
    throw new EnhancementError("configuration_invalid");
  const limits = createHttpTransportLimits(options.transportLimits);
  const handler = createEnhancementHandler(options);
  const server = createServer(
    {
      headersTimeout: limits.headersTimeoutMs,
      // The authenticated receiver owns the body deadline and its JSON response.
      requestTimeout: 0,
      maxHeaderSize: limits.maxHeaderBytes,
    },
    handler,
  );
  server.on("checkContinue", handler);
  server.on("checkExpectation", handler);
  Object.defineProperty(server, "fileIo", {
    value: Object.freeze({
      sealFileIo: handler.sealFileIo,
      pendingRequests: handler.pendingRequests,
      activity: handler.activity,
    }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server as EnhancementServer;
}
