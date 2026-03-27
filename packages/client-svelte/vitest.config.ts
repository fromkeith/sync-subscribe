import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["svelte", "import", "default"],
  },
  test: {
    environment: "node",
    server: {
      deps: {
        // svelteprovider uses extensionless imports (./func) which Node ESM
        // can't resolve natively — bundle it through Vite instead.
        inline: ["svelteprovider"],
      },
    },
  },
});
