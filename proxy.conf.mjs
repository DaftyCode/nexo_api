// Development proxy for `ng serve`: forwards /api to the local Rust service and adds the
// per-session token that the local service requires (see tools/dev.mjs).
import { readFileSync } from 'node:fs';

function localToken() {
  if (process.env.NEXO_LOCAL_TOKEN) return process.env.NEXO_LOCAL_TOKEN;
  try {
    return readFileSync(new URL('./.nexo/local-token', import.meta.url), 'utf8').trim();
  } catch {
    return '';
  }
}
const token = localToken();

export default {
  '/api': {
    target: process.env.NEXO_API_URL ?? 'http://127.0.0.1:8080',
    secure: false,
    changeOrigin: true,
    ...(token ? { headers: { 'x-nexo-local-token': token } } : {}),
  },
};
