import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageProcessingS3Fixture, imageProcessingStreamBytes } from "./image-processing-s3-fixture";
import { getObjectStream, putObjectBytes } from "./object-storage-client";

describe("real S3 original stream lifecycle", () => {
    let fixture: Awaited<ReturnType<typeof imageProcessingS3Fixture>>;
    const key = "fixture/original.png";

    beforeEach(async () => {
        fixture = await imageProcessingS3Fixture();
        await putObjectBytes(fixture.config, { key, bytes: Buffer.from("source-first-tail"), contentType: "image/png" });
    });

    afterEach(async () => {
        await fixture?.close();
    });

    it("keeps the real client open before the slow first byte and closes it after complete EOF", async () => {
        const transfer = fixture.control(key);
        const stream = await getObjectStream(fixture.config, key);
        await transfer.headers;
        expect(transfer.connectionClosed).toBe(false);
        const iterator = stream[Symbol.asyncIterator]();
        transfer.releaseFirst();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(Buffer.from(first.value).toString()).toBe("s");
        expect(transfer.connectionClosed).toBe(false);
        transfer.releaseEnd();
        expect((await imageProcessingStreamBytes(iterator)).toString()).toBe("ource-first-tail");
        await transfer.closed;
        expect(transfer.connectionClosed).toBe(true);
    });

    it("rejects a real truncated response instead of treating its prefix as complete bytes", async () => {
        const transfer = fixture.control(key, true);
        const stream = await getObjectStream(fixture.config, key);
        const iterator = stream[Symbol.asyncIterator]();
        transfer.releaseFirst();
        const first = await iterator.next();
        expect(Buffer.from(first.value).toString()).toBe("s");
        transfer.releaseEnd();
        await expect(imageProcessingStreamBytes(iterator)).rejects.toThrow();
        await transfer.closed;
    });

    it("aborts the real body and closes its socket while the first byte remains gated", async () => {
        const transfer = fixture.control(key);
        const controller = new AbortController();
        const stream = await getObjectStream(fixture.config, key, controller.signal);
        const reading = imageProcessingStreamBytes(stream);
        controller.abort();
        await expect(reading).rejects.toThrow();
        await transfer.closed;
        expect(transfer.connectionClosed).toBe(true);
    });

    it("propagates Response cancellation through the real body and closes the socket", async () => {
        const transfer = fixture.control(key);
        const stream = await getObjectStream(fixture.config, key);
        // Node and DOM type the same WHATWG body differently at pipeThrough/async iteration.
        const response = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
        await response.body!.cancel();
        await transfer.closed;
        expect(transfer.connectionClosed).toBe(true);
    });
});
