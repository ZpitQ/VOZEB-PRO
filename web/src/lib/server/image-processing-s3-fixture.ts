import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ObjectStorageRuntimeConfig } from "./object-storage-config";

export async function imageProcessingS3Fixture() {
    const objects = new Map<string, Buffer>();
    const contentTypes = new Map<string, string | undefined>();
    const controls = new Map<string, ReturnType<typeof controlledTransfer>>();
    const requests: Array<{ method: string; key: string }> = [];
    const rejectedPuts: Array<{ key: string; bytes: Buffer }> = [];
    let putFailure = false;
    const handlers = new Set<Promise<void>>();
    const errors: unknown[] = [];
    const bucket = "fixture-image-processing";
    const server = createServer((request, response) => {
        const operation = (async () => {
            try {
                const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
                const prefix = `/${bucket}/`;
                if (!pathname.startsWith(prefix)) throw new Error("Unexpected fixture S3 bucket");
                const key = decodeURIComponent(pathname.slice(prefix.length));
                requests.push({ method: request.method || "", key });
                if (request.method === "PUT") {
                    contentTypes.set(key, request.headers["content-type"]);
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const bytes = Buffer.concat(chunks);
                    if (putFailure) {
                        rejectedPuts.push({ key, bytes });
                        response.writeHead(503, { "content-type": "application/xml" });
                        response.end("<Error><Code>ServiceUnavailable</Code></Error>");
                        return;
                    }
                    objects.set(key, bytes);
                    response.setHeader("etag", '"fixture-etag"');
                    response.end();
                    return;
                }
                if (request.method !== "GET") throw new Error("Unexpected fixture S3 operation");
                const bytes = objects.get(key);
                if (!bytes) {
                    response.writeHead(404, { "content-type": "application/xml" });
                    response.end("<Error><Code>NoSuchKey</Code></Error>");
                    return;
                }
                const control = controls.get(key);
                request.socket.once("close", () => control?.markClosed());
                response.writeHead(200, { "content-type": "image/png", "content-length": String(bytes.length) });
                response.flushHeaders();
                control?.markHeaders();
                if (!control) {
                    response.end(bytes);
                    return;
                }
                await control.first;
                response.write(bytes.subarray(0, 1));
                await control.end;
                if (control.disconnect) response.destroy();
                else response.end(bytes.subarray(1));
            } catch (error) {
                errors.push(error);
                response.destroy();
            }
        })();
        handlers.add(operation);
        void operation.finally(() => handlers.delete(operation));
    });
    // The peer must close the GET connection; server idle expiry cannot prove cleanup.
    server.keepAliveTimeout = 0;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const config: ObjectStorageRuntimeConfig = {
        id: "default",
        enabled: true,
        endpoint: `http://127.0.0.1:${address.port}`,
        region: "us-east-1",
        bucket,
        prefix: "fixture",
        cdnBaseUrl: "",
        accessKeyId: "fixture-access",
        secretAccessKey: "fixture-secret",
        forcePathStyle: true,
    };
    return {
        config,
        requests,
        contentTypes,
        rejectedPuts,
        failPuts(enabled: boolean) {
            putFailure = enabled;
        },
        control(key: string, disconnect = false) {
            const transfer = controlledTransfer(disconnect);
            controls.set(key, transfer);
            return transfer;
        },
        async close() {
            try {
                for (const transfer of controls.values()) {
                    transfer.releaseFirst();
                    transfer.releaseEnd();
                }
                while (handlers.size) await Promise.allSettled([...handlers]);
            } finally {
                const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
                server.closeAllConnections();
                await closed;
            }
            if (errors.length) throw new AggregateError(errors, "S3 fixture handlers failed");
        },
    };
}

function controlledTransfer(disconnect = false) {
    const headers = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    const end = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let connectionClosed = false;
    return {
        disconnect,
        headers: headers.promise,
        first: first.promise,
        end: end.promise,
        closed: closed.promise,
        get connectionClosed() {
            return connectionClosed;
        },
        markHeaders: () => headers.resolve(),
        markClosed() {
            connectionClosed = true;
            closed.resolve();
        },
        releaseFirst: () => first.resolve(),
        releaseEnd: () => end.resolve(),
    };
}

export async function imageProcessingStreamBytes(stream: AsyncIterable<Uint8Array>) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
