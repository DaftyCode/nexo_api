// The audit of the production dependencies CI runs (`npm audit --omit=dev`, high and
// critical advisories), with the exceptions of tools/audit-exceptions.json. An exception
// names one advisory of one package and only holds while nothing can fix it: it fails on
// its expiry date, and as soon as the package publishes a version newer than the latest
// one the exception was granted for. Usage: npm run audit:check
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERE = new Set(['high', 'critical']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The high and critical advisories of an `npm audit --json` report, once each. */
export function advisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {}))
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || !SEVERE.has(via.severity)) continue;
      const id = String(via.url ?? via.source)
        .split('/')
        .pop();
      found.set(`${id} ${via.name}`, { id, package: via.name, title: via.title, url: via.url });
    }
  return [...found.values()];
}

/** What is wrong with an exception as written, if anything. */
function malformed(exception) {
  for (const field of ['advisory', 'package', 'latest', 'reason'])
    if (typeof exception[field] !== 'string' || !exception[field].trim())
      return `it has no ${field}`;
  if (!DAY.test(exception.expires ?? '')) return 'its expiry is not a YYYY-MM-DD date';
  return undefined;
}

/**
 * Which advisories fail the audit and which an exception lets through. `latest` gives the
 * newest published version of each package an exception names; `today` is YYYY-MM-DD.
 */
export function review({ report, exceptions, latest, today }) {
  const failures = [];
  const waived = [];
  const used = new Set();
  for (const exception of exceptions) {
    const problem = malformed(exception);
    if (problem)
      failures.push(
        `The exception for ${exception.advisory ?? 'an advisory'} is invalid: ${problem}.`,
      );
  }
  for (const advisory of advisories(report)) {
    const name = `${advisory.package}: ${advisory.title} (${advisory.id})`;
    const exception = exceptions.find(
      (candidate) =>
        candidate.advisory === advisory.id &&
        candidate.package === advisory.package &&
        !malformed(candidate),
    );
    if (!exception) {
      failures.push(`${name} ${advisory.url ?? ''}`.trim());
      continue;
    }
    used.add(exception);
    if (today > exception.expires)
      failures.push(`${name}: its exception expired on ${exception.expires}. Review it.`);
    else if (latest[advisory.package] !== exception.latest)
      failures.push(
        `${name}: ${advisory.package} ${latest[advisory.package] ?? '(unknown)'} is published ` +
          `after ${exception.latest}. Update it and remove the exception if it is fixed.`,
      );
    else waived.push(`${name}, until ${exception.expires}: ${exception.reason}`);
  }
  const unused = exceptions
    .filter((exception) => !used.has(exception) && !malformed(exception))
    .map((exception) => `${exception.package} ${exception.advisory}`);
  return { failures, waived, unused };
}

function npm(args) {
  const cli =
    process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function main() {
  const exceptions = JSON.parse(
    readFileSync(new URL('./audit-exceptions.json', import.meta.url), 'utf8'),
  );
  // npm audit ends with 1 when it finds anything: its report says what.
  const audit = npm(['audit', '--omit=dev', '--json']);
  const report = JSON.parse(audit.stdout || '{}');
  if (report.error || !report.vulnerabilities)
    throw new Error(`npm audit gave no report: ${report.error?.summary ?? audit.stderr}`);
  const latest = {};
  for (const name of new Set(exceptions.map((exception) => exception.package))) {
    const view = npm(['view', name, 'version']);
    if (view.status !== 0) throw new Error(`npm view ${name} failed: ${view.stderr}`);
    latest[name] = view.stdout.trim();
  }
  const today = new Date().toISOString().slice(0, 10);
  const { failures, waived, unused } = review({ report, exceptions, latest, today });
  for (const line of waived) console.log(`Allowed by an exception: ${line}`);
  for (const line of unused)
    console.log(`No longer needed, remove it from tools/audit-exceptions.json: ${line}`);
  if (failures.length) {
    console.error(`The audit found ${failures.length} problem(s):`);
    for (const line of failures) console.error(`- ${line}`);
    process.exitCode = 1;
  } else console.log('Audit passed: no high or critical advisory without a valid exception.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
