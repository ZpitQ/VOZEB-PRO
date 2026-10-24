import { once } from "node:events";
import {
  request,
  type ClientRequest,
  type OutgoingHttpHeaders,
} from "node:http";
import type { Socket } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createWorkerConfig, type WorkerConfig } from "../src/config.js";
import {
  listenEnhancementServer,
  type EnhancementHttpOptions,
  type UploadTimer,
} from "../src/http.js";
import { openStore, type JobDto } from "../src/store.js";
import { configInput, planInput } from "./fixtures.js";
import {
  sha256,
  runnerLimits,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";

export const transportLimits = Object.freeze({
  maxPlanBytes: 16 * 1024,
  maxMultipartOverheadBytes: 64 * 1024,
  maxConcurrentUploads: 2,
  maxConcurrentDownloads: 3,
  maxReceiptBytes: 1024,
  maxConcurrentReceipts: 1,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  maxHeaderBytes: 16 * 1024,
});

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function manualUploadTimer(): UploadTimer & {
  pending: Map<() => void, number>;
  fire(): void;
} {
  const pending = new Map<() => void, number>();
  return {
    pending,
    start(callback, milliseconds) {
      pending.set(callback, milliseconds);
      return () => {
        pending.delete(callback);
      };
    },
    fire() {
      for (const callback of [...pending.keys()]) callback();
    },
  };
}

export type Part = Readonly<{
  name: string;
  bytes: Buffer;
  filename?: string;
  type?: string;
  encoding?: string;
}>;
export const boundary = "fixture-image-enhancement-boundary";

export function multipart(parts: readonly Part[], close = true) {
  return Buffer.concat([
    ...parts.flatMap((part) => [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ""}${part.encoding ? `Content-Transfer-Encoding: ${part.encoding}\r\n` : ""}\r\n`,
      ),
      part.bytes,
      Buffer.from("\r\n"),
    ]),
    Buffer.from(close ? `--${boundary}--\r\n` : ""),
  ]);
}

export function uploadParts(
  bytes: Buffer,
  overrides: Partial<Part> = {},
  plan: unknown = planInput(sha256(bytes)),
) {
  return [
    {
      name: "plan",
      bytes: Buffer.from(JSON.stringify(plan)),
      type: "application/json; charset=utf-8",
    },
    {
      name: "image",
      bytes,
      filename: "source.jpg",
      type: "image/jpeg",
      ...overrides,
    },
  ];
}

export type HttpResult = Readonly<{
  status: number;
  body: { code: string; data: Record<string, unknown>; msg: string };
  raw: string;
}>;
export const jobOf = (result: HttpResult) => result.body.data.job as JobDto;

export async function httpFixture(
  overrides: Partial<
    Omit<EnhancementHttpOptions, "store" | "config" | "submissionLimits">
  > = {},
) {
  const storage = await storageFixture();
  let config: WorkerConfig = createWorkerConfig(configInput());
  let ready = true;
  const sockets = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  const options = (): EnhancementHttpOptions => ({
    store: storage.store,
    config: () => config,
    ready: () => ready,
    submissionLimits,
    runnerLimits,
    transportLimits,
    ...overrides,
  });
  let server = await listenEnhancementServer(options(), 0);
  const observeConnections = () => {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  };
  observeConnections();
  const port = () => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture did not bind TCP");
    return address.port;
  };
  function start(
    method: string,
    path: string,
    headers: OutgoingHttpHeaders | readonly string[] = {},
  ) {
    const targetPort = port();
    const hostHeaders =
      Array.isArray(headers) &&
      !headers.some(
        (value, index) => index % 2 === 0 && value.toLowerCase() === "host",
      )
        ? [...headers, "Host", `127.0.0.1:${targetPort}`]
        : headers;
    const req = request({
      host: "127.0.0.1",
      port: targetPort,
      method,
      path,
      headers: hostHeaders,
      agent: false,
    });
    requests.add(req);
    req.once("close", () => requests.delete(req));
    const result = new Promise<HttpResult>((resolve, reject) => {
      req.once("error", reject);
      req.once("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw), raw });
          } catch {
            reject(
              new Error(
                `HTTP fixture expected JSON; status=${res.statusCode}; responseBytes=${Buffer.byteLength(raw)}`,
              ),
            );
          }
        });
      });
    });
    // Test fault barriers can destroy a socket before awaiting its result.
    void result.catch(() => {});
    return { req, result };
  }
  const auth = () => `Bearer ${storage.initialized.credential.key}`;
  async function call(
    method: string,
    path: string,
    body?: Buffer,
    headers: OutgoingHttpHeaders | readonly string[] = {
      authorization: auth(),
    },
    chunks = false,
  ) {
    const framedHeaders =
      body && !chunks
        ? Array.isArray(headers)
          ? [...headers, "Content-Length", String(body.length)]
          : { ...headers, "content-length": body.length }
        : headers;
    const connection = start(method, path, framedHeaders);
    if (body && chunks) {
      // Deliberately split boundaries, UTF-8 sequences and encoded image chunks.
      for (let i = 0; i < body.length; i += 7) {
        if (!connection.req.write(body.subarray(i, i + 7)))
          await once(connection.req, "drain");
      }
      connection.req.end();
    } else connection.req.end(body);
    return connection.result;
  }
  const uploadHeaders = (key = "http-request-1") => ({
    authorization: auth(),
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "idempotency-key": key,
  });
  async function upload(
    bytes: Buffer,
    key = "http-request-1",
    parts = uploadParts(bytes),
    chunks = false,
  ) {
    return call(
      "POST",
      "/v1/enhancement-jobs",
      multipart(parts),
      uploadHeaders(key),
      chunks,
    );
  }
  async function closeServer() {
    for (const req of requests) req.destroy();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  return {
    storage,
    get server() {
      return server;
    },
    get config() {
      return config;
    },
    setConfig(value: WorkerConfig) {
      config = value;
    },
    setReady(value: boolean) {
      ready = value;
    },
    options,
    auth,
    call,
    start,
    uploadHeaders,
    upload,
    async inputNames() {
      return (await readdir(storage.store.inputDirectory)).sort();
    },
    async original(job: JobDto) {
      return readFile(
        join(
          storage.store.inputDirectory,
          job.jobId,
          `original.${job.source.format}`,
        ),
      );
    },
    async restart() {
      await closeServer();
      storage.store.close();
      storage.setStore(
        openStore({ directory: storage.directory, clock: storage.clock }),
      );
      server = await listenEnhancementServer(options(), 0);
      observeConnections();
    },
    async cleanup() {
      await closeServer();
      await storage.cleanup();
    },
  };
}
