// End-to-end tests of the built web interface served by the real nexo-server binary.
// Build first: `npm run build` and `cargo build -p nexo-server`; then `npm run e2e`.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
