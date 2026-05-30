import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Network/e2e tests (TLS handshakes, proxy round-trips) need headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each test file spins up its own proxy/origin servers on fixed ports;
    // run files sequentially to avoid port collisions.
    fileParallelism: false,
  },
});
