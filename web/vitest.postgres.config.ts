import { defineConfig, mergeConfig } from "vitest/config";

import config from "./vitest.config";

export default mergeConfig(
    config,
    defineConfig({
        test: {
            setupFiles: ["./scripts/setup-postgres-integration.ts"],
        },
    }),
);
