import { createHash } from "node:crypto";
import { createServer } from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { imageReferenceToDataUrl } from "@/app/api/image-tasks/image-task-support";
import { MAX_INLINE_IMAGE_BYTES } from "@/app/api/image-tasks/image-task-types";
import { maintenanceWorkerContext } from "./maintenance-auth";

describe("permanent enhancement readback budget", () => {
    let bytes: Buffer;
    let origin: string;
    const requests: Array<{ authorization?: string; user?: string }> = [];
    const server = createServer((request, response) => {
        requests.push({ authorization: request.headers.authorization, user: request.headers["x-vozeb-pro-worker-user-id"] as string | undefined });
        response.writeHead(200, { "content-type": "image/png", ...(request.url?.includes("chunked") ? {} : { "content-length": bytes.length }) });
        response.end(bytes);
    });
    beforeAll(async () => {
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "m".repeat(32));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "w".repeat(32));
        bytes = await sharp({ create: { width: 3200, height: 2400, channels: 3, background: "#736b64" } }).png({ compressionLevel: 0 }).toBuffer();
        expect(bytes.length).toBeGreaterThan(MAX_INLINE_IMAGE_BYTES);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture_not_bound");
        origin = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        vi.unstubAllEnvs();
    });
    for (const transfer of ["length", "chunked"]) {
        const reference = { dataUrl: `/api/generation-log-assets/permanent/enhancement.png?${transfer}` };
        it(`reads complete AI bytes within the frozen budget with ${transfer} transfer`, async () => {
            const value = await imageReferenceToDataUrl(reference, "enhancement.png", origin, maintenanceWorkerContext("enhancement-owner"), bytes.length);
            const actual = Buffer.from(value.split(",")[1], "base64");
            expect(createHash("sha256").update(actual).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
            expect(actual.length).toBe(bytes.length);
            expect(requests.at(-1)).toEqual({ authorization: `Bearer ${"w".repeat(32)}`, user: "enhancement-owner" });
        });
        it(`rejects bytes exceeding the frozen budget with ${transfer} transfer`, async () => {
            await expect(imageReferenceToDataUrl(reference, "enhancement.png", origin, maintenanceWorkerContext("enhancement-owner"), bytes.length - 1)).rejects.toThrow("参考图过大");
        });
    }
    it("keeps the ordinary reference default limit", async () => {
        await expect(imageReferenceToDataUrl({ dataUrl: "/api/generation-log-assets/permanent/enhancement.png" }, "reference.png", origin, maintenanceWorkerContext("enhancement-owner"))).rejects.toThrow("参考图过大");
    });
});
