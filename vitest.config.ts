import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("migrations");
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            D1_ADMIN_DEV: "true",
            GOOGLE_HEALTH_CLIENT_ID: "test-client-id",
            GOOGLE_HEALTH_CLIENT_SECRET: "test-client-secret",
            GOOGLE_HEALTH_TOKEN_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
          }
        }
      };
    })
  ]
});
