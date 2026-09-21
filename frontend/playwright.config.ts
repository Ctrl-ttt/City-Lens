import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8000',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1050 },
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${python}" -m uvicorn backend.app:app --host 127.0.0.1 --port 8000`,
    cwd: root,
    url: 'http://localhost:8000/api/health',
    env: { CITYLENS_PROVIDER: 'sample', CITYLENS_SAMPLE_SCENE: 'bicycle' },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
