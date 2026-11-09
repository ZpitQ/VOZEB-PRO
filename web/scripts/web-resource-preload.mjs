import { imageProcessingResourceConfig } from "../.image-processing-runtime/lib/image-processing/resource-config.js";

imageProcessingResourceConfig(process.env);

const webHeapMb = process.env.VOZEB_PRO_WEB_HEAP_MB ?? "384";
if (!/^[1-9]\d*$/.test(webHeapMb) || !Number.isSafeInteger(Number(webHeapMb))) throw new Error("VOZEB_PRO_WEB_HEAP_MB must be a positive integer");
