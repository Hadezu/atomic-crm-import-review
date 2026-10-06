import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./proof-e2e",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/import-review.xml" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4186",
    trace: "retain-on-failure",
    video: "on",
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4186",
    url: "http://127.0.0.1:4186",
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
