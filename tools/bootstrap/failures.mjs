// Explains why a build step failed. The installers run npm and Cargo on computers they do
// not control (company proxies, registry mirrors, antivirus); the raw output rarely says
// what to do, so each failure ends with one actionable hint.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How much of a failed command's output is kept to look for a hint. */
const KEPT_OUTPUT = 64 * 1024;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const NETWORK_CODE =
  /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up)\b/;
const CARGO_NETWORK =
  /spurious network error|failed to download|Couldn't resolve host|SSL connect error|\[28\] Timeout was reached|failed to get `[^`]+` as a dependency/;

/** A build step that failed; `hint` says what the user can do about it. */
export class StepError extends Error {
  constructor(step, status, hint, log) {
    super(`${step} failed (exit code ${status}).`);
    this.hint = hint;
    this.log = log;
  }
}

/** The URL a failed download was fetching, when the output names it. */
function failedUrl(text, code) {
  const named = text.match(/\b(?:request to|GET|fetching|downloading)\s+(https?:\/\/[^\s'",]+)/i);
  if (named) return named[1];
  const line = text
    .split(/\r?\n/)
    .find((entry) => entry.includes(code) && /https?:\/\//.test(entry));
  return line?.match(/https?:\/\/[^\s'",]+/)?.[0];
}

function networkHint(text, platform) {
  const code = text.match(NETWORK_CODE)?.[1] ?? 'network error';
  const url = failedUrl(text, code);
  const cargo = !/\bnpm (?:error|ERR!)/.test(text) && CARGO_NETWORK.test(text);
  const check = url
    ? platform === 'win32'
      ? ` Check the address with: Invoke-WebRequest -Method Head ${url}`
      : ` Check the address with: curl -I ${url}`
    : '';
  const retries = cargo
    ? 'To wait and retry longer, set CARGO_NET_RETRY=10 and CARGO_HTTP_TIMEOUT=120.'
    : 'To wait and retry longer, set npm_config_fetch_retries=5 and npm_config_fetch_retry_maxtimeout=120000.';
  return (
    `The download failed (${code})${url ? ` while fetching ${url}` : ''}. Rerun the same command: ` +
    `on a company network the proxy or registry mirror may be cutting the connection. ${retries}` +
    `${check}${url ? '. If it keeps failing, give IT that exact URL.' : ''}`
  );
}

/**
 * One actionable hint for a failed command's output, or undefined when the cause is not one
 * of the known installation problems. `platform` is a Node `process.platform` value.
 */
export function hintFor(output, platform = process.platform) {
  const text = String(output ?? '').replace(ANSI, '');
  const buildScript = text.match(/could not execute process `([^`]*build-script-\w+)`/);
  if (buildScript) {
    const target = buildScript[1].match(/^(.*?[\\/]target)[\\/]/)?.[1] ?? 'target';
    return (
      `Something stopped a Rust build script from running, usually the antivirus. ` +
      `Check its log (Windows Security > Protection history on Windows) and ask IT to exclude ` +
      `the build folder ${target}, then rerun.`
    );
  }
  if (NETWORK_CODE.test(text) || CARGO_NETWORK.test(text)) return networkHint(text, platform);
  if (/\b(?:EPERM|EBUSY)\b/.test(text) && /node_modules/.test(text))
    return (
      'Files in node_modules are in use. Close VS Code, ng serve, npm run dev and test watchers ' +
      'that use this folder (an antivirus scan can also hold them), delete node_modules and rerun.'
    );
  if (/\(os error (?:5|32)\)|being used by another process|Text file busy/.test(text))
    return (
      'A program is using a file the build has to replace, usually a running Nexo API or an ' +
      'antivirus scan. Close the app or stop the web version, then rerun.'
    );
  return undefined;
}

/**
 * Runs a build step, showing its output as it arrives and keeping the end of it. On failure
 * it writes that output to `log` and rejects with a StepError carrying the hint.
 */
export function runStep(step, command, args, { log, env = process.env } = {}) {
  console.log(`> ${[command, ...args].join(' ')}`);
  const interactive = Boolean(process.stdout.isTTY);
  const childEnv = interactive
    ? // Piped output would turn off colours and Cargo's progress bar; keep them.
      {
        FORCE_COLOR: '1',
        npm_config_color: 'always',
        CARGO_TERM_COLOR: 'always',
        CARGO_TERM_PROGRESS_WHEN: 'always',
        CARGO_TERM_PROGRESS_WIDTH: String(process.stdout.columns ?? 100),
        ...env,
      }
    : env;
  return new Promise((resolvePromise, reject) => {
    let kept = '';
    const child = spawn(command, args, {
      env: childEnv,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const forward = (stream, target) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        target.write(chunk);
        kept = (kept + chunk).slice(-KEPT_OUTPUT);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (status === 0) return resolvePromise();
      if (log) {
        try {
          mkdirSync(dirname(log), { recursive: true });
          writeFileSync(log, kept.replace(ANSI, ''));
        } catch {
          log = undefined;
        }
      }
      reject(new StepError(step, status ?? signal, hintFor(kept), log));
    });
  });
}

/** Prints why the installation stopped, without a stack trace for expected failures. */
export function report(prefix, error) {
  console.error(`\n${prefix}: ${error.message}`);
  if (error.hint) console.error(`Hint: ${error.hint}`);
  if (error.log) console.error(`Output of the failed step: ${error.log}`);
}
