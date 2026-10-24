import type { IncomingMessage } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Busboy, type BusboyInstance } from "@fastify/busboy";

import { EnhancementError, parsePlanJson } from "./contracts.js";
import { requestByteBudget, type HttpTransportLimits } from "./http-config.js";

export type UploadFiles = Readonly<{
  createDirectory(parent: string): Promise<string>;
  createImageWriter(path: string): Writable;
  readImage(path: string): Promise<Buffer>;
  removeDirectory(path: string): Promise<void>;
}>;
export type UploadTimer = Readonly<{
  start(callback: () => void, milliseconds: number): () => void;
}>;
export const localUploadFiles: UploadFiles = Object.freeze({
  createDirectory: (parent: string) => mkdtemp(join(parent, ".upload-")),
  createImageWriter: (path: string) =>
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  readImage: readFile,
  async removeDirectory(path: string) {
    await rm(path, { recursive: true, force: true });
  },
});

const localUploadTimer: UploadTimer = Object.freeze({
  start(callback: () => void, milliseconds: number) {
    const timeout = setTimeout(callback, milliseconds);
    timeout.unref();
    return () => clearTimeout(timeout);
  },
});

type MultipartOptions = Readonly<{
  directory: string;
  maxImageBytes: number;
  limits: HttpTransportLimits;
  files: UploadFiles;
  timer?: UploadTimer;
  signal: AbortSignal;
}>;

export async function receiveMultipart(
  request: IncomingMessage,
  options: MultipartOptions,
): Promise<Readonly<{ plan: unknown; sourceBytes: Buffer }>> {
  if (options.signal.aborted) throw new EnhancementError("invalid_request");
  const maxRequestBytes = requestByteBudget(
    options.maxImageBytes,
    options.limits,
  );
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string")
    throw new EnhancementError("invalid_request");
  let parser: BusboyInstance;
  try {
    parser = new Busboy({
      headers: { ...request.headers, "content-type": contentType },
      // Preserve raw bytes even for the external plan field; validate roles below.
      isPartAFile: () => true,
      limits: {
        files: 2,
        fields: 0,
        parts: 2,
        fileSize:
          Math.max(options.maxImageBytes, options.limits.maxPlanBytes) + 1,
        headerSize: options.limits.maxMultipartOverheadBytes,
      },
    });
  } catch {
    throw new EnhancementError("invalid_request");
  }

  const fileStreams = new Set<Readable>();
  const outputs = new Set<Writable>();
  const fileTasks: Promise<void>[] = [];
  const planChunks: Buffer[] = [];
  let directory: string | undefined;
  let imagePath: string | undefined;
  let planSeen = false;
  let imageSeen = false;
  let totalBytes = 0;
  let planBytes = 0;
  let imageBytes = 0;
  let requestEnded = false;
  let parserFinished = false;
  let failure: EnhancementError | undefined;
  let settle!: (error: EnhancementError | undefined) => void;
  const completion = new Promise<EnhancementError | undefined>((resolve) => {
    settle = resolve;
  });

  function fail(error: EnhancementError) {
    if (failure) return;
    failure = error;
    request.unpipe(bodyCounter);
    request.pause();
    bodyCounter.destroy();
    parser.destroy();
    for (const stream of fileStreams) stream.destroy(error);
    for (const stream of outputs) stream.destroy(error);
    settle(error);
  }
  function finished() {
    if (requestEnded && parserFinished) settle(undefined);
  }
  const bodyCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.length;
      callback(
        totalBytes > maxRequestBytes
          ? new EnhancementError("budget_exceeded")
          : null,
        chunk,
      );
    },
  });
  bodyCounter.on("error", (error) =>
    fail(
      error instanceof EnhancementError
        ? error
        : new EnhancementError("internal_error"),
    ),
  );
  parser.on("error", () => fail(new EnhancementError("invalid_request")));
  for (const event of ["partsLimit", "filesLimit", "fieldsLimit"] as const)
    parser.on(event, () => fail(new EnhancementError("invalid_request")));
  parser.on("field", () => fail(new EnhancementError("invalid_request")));
  parser.once("finish", () => {
    parserFinished = true;
    finished();
  });

  parser.on("file", (name, stream, filename, encoding, mimeType) => {
    fileStreams.add(stream);
    stream.on("error", (error: unknown) =>
      fail(
        error instanceof EnhancementError
          ? error
          : new EnhancementError("invalid_request"),
      ),
    );
    stream.once("limit", () => fail(new EnhancementError("budget_exceeded")));
    try {
      if (failure) {
        stream.destroy(failure);
        return;
      }
      if (
        (name !== "plan" && name !== "image") ||
        (name === "plan" && (planSeen || filename !== undefined)) ||
        (name === "image" && (imageSeen || filename === undefined))
      )
        throw new EnhancementError("invalid_request");
      if (
        !["7bit", "8bit", "binary"].includes(encoding) ||
        (name === "plan" &&
          !["application/json", "text/plain"].includes(mimeType)) ||
        (name === "image" && !["image/png", "image/jpeg"].includes(mimeType))
      )
        throw new EnhancementError("unsupported_media_type");
      if (name === "plan") planSeen = true;
      else imageSeen = true;
      const partCounter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (name === "plan") planBytes += chunk.length;
          else imageBytes += chunk.length;
          const over =
            name === "plan"
              ? planBytes > options.limits.maxPlanBytes
              : imageBytes > options.maxImageBytes;
          callback(
            over ? new EnhancementError("budget_exceeded") : null,
            chunk,
          );
        },
      });
      const output =
        name === "plan"
          ? new Writable({
              write(chunk: Buffer, _encoding, callback) {
                planChunks.push(Buffer.from(chunk));
                callback();
              },
            })
          : options.files.createImageWriter(imagePath!);
      outputs.add(partCounter);
      outputs.add(output);
      // Observe a filesystem error before pipeline propagates it back to the raw part.
      output.on("error", (error: unknown) =>
        fail(
          error instanceof EnhancementError
            ? error
            : new EnhancementError("internal_error"),
        ),
      );
      fileTasks.push(
        pipeline(stream, partCounter, output).catch((error: unknown) => {
          fail(
            error instanceof EnhancementError
              ? error
              : new EnhancementError("internal_error"),
          );
        }),
      );
    } catch (error) {
      fail(
        error instanceof EnhancementError
          ? error
          : new EnhancementError("internal_error"),
      );
    }
  });

  const ended = () => {
    requestEnded = true;
    finished();
  };
  const aborted = () => fail(new EnhancementError("invalid_request"));
  const closed = () => {
    if (!request.complete) aborted();
  };
  request.once("end", ended);
  request.once("error", aborted);
  request.once("aborted", aborted);
  request.once("close", closed);
  options.signal.addEventListener("abort", aborted, { once: true });
  const cancelTimer = (options.timer ?? localUploadTimer).start(
    () => fail(new EnhancementError("upload_timeout")),
    options.limits.requestTimeoutMs,
  );
  try {
    directory = await options.files.createDirectory(options.directory);
    imagePath = join(directory, "image.part");
    if (failure || options.signal.aborted)
      throw failure ?? new EnhancementError("invalid_request");
    request.pipe(bodyCounter).pipe(parser);
    const error = await completion;
    await Promise.all(fileTasks);
    if (error || failure) throw error ?? failure;
    if (!request.complete || !planSeen || !imageSeen)
      throw new EnhancementError("invalid_request");
    if (
      totalBytes - planBytes - imageBytes >
      options.limits.maxMultipartOverheadBytes
    )
      throw new EnhancementError("budget_exceeded");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(planChunks, planBytes),
      );
    } catch {
      throw new EnhancementError("invalid_request");
    }
    const plan = parsePlanJson(text);
    // B1 currently accepts one Buffer: the sole full-image read is bounded by its frozen limit.
    const sourceBytes = await options.files.readImage(imagePath);
    if (failure || options.signal.aborted)
      throw failure ?? new EnhancementError("invalid_request");
    if (sourceBytes.length !== imageBytes)
      throw new EnhancementError("internal_error");
    if (sourceBytes.length > options.maxImageBytes)
      throw new EnhancementError("budget_exceeded");
    return { plan, sourceBytes };
  } catch (error) {
    const safe =
      error instanceof EnhancementError
        ? error
        : new EnhancementError("internal_error");
    fail(safe);
    throw safe;
  } finally {
    cancelTimer();
    request.off("end", ended);
    request.off("error", aborted);
    request.off("aborted", aborted);
    request.off("close", closed);
    options.signal.removeEventListener("abort", aborted);
    request.unpipe(bodyCounter);
    bodyCounter.unpipe(parser);
    bodyCounter.destroy();
    parser.destroy();
    for (const stream of fileStreams) stream.destroy();
    for (const stream of outputs) stream.destroy();
    await Promise.all(fileTasks);
    if (directory) {
      try {
        await options.files.removeDirectory(directory);
      } catch {
        if (!failure) throw new EnhancementError("internal_error");
      }
    }
  }
}
