import test from 'node:test';
import assert from 'node:assert/strict';
import { advisories, review } from './check-audit.mjs';

const advisory = (name, id, severity = 'high') => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} is vulnerable`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '<=4.0.7',
});
const report = (...entries) => ({
  vulnerabilities: Object.fromEntries(
    entries.map(([name, ...via]) => [name, { name, severity: 'high', via }]),
  ),
});
const exception = {
  advisory: 'GHSA-1',
  package: 'picomatch',
  latest: '4.0.7',
  expires: '2026-12-17',
  reason: 'No release fixes it.',
};
const picomatch = report(
  ['picomatch', advisory('picomatch', 'GHSA-1')],
  ['vite', 'picomatch'],
  ['vitest', 'vite', 'picomatch'],
);

test('lists each high or critical advisory once, not the packages that depend on it', () => {
  const found = advisories(
    report(
      ['picomatch', advisory('picomatch', 'GHSA-1'), advisory('picomatch', 'GHSA-2', 'low')],
      ['vite', 'picomatch', advisory('vite', 'GHSA-3', 'critical')],
      ['other', advisory('picomatch', 'GHSA-1')],
    ),
  );
  assert.deepEqual(
    found.map((item) => `${item.package} ${item.id}`),
    ['picomatch GHSA-1', 'vite GHSA-3'],
  );
});

test('an exception lets its advisory through while it is valid and nothing can fix it', () => {
  const result = review({
    report: picomatch,
    exceptions: [exception],
    latest: { picomatch: '4.0.7' },
    today: '2026-12-17',
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.waived.length, 1);
  assert.match(result.waived[0], /until 2026-12-17: No release fixes it\./);
});

test('an advisory without an exception, or of another package, fails', () => {
  const result = review({
    report: report(
      ['picomatch', advisory('picomatch', 'GHSA-1')],
      ['vite', advisory('vite', 'GHSA-1')],
      ['yaml', advisory('yaml', 'GHSA-9')],
    ),
    exceptions: [exception],
    latest: { picomatch: '4.0.7' },
    today: '2026-11-17',
  });
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], /^vite: vite is vulnerable \(GHSA-1\)/);
  assert.match(result.failures[1], /^yaml: .*GHSA-9\)/);
});

test('an exception fails once it expires or a newer version of the package is out', () => {
  const expired = review({
    report: picomatch,
    exceptions: [exception],
    latest: { picomatch: '4.0.7' },
    today: '2026-12-18',
  });
  assert.match(expired.failures[0], /expired on 2026-12-17/);
  const released = review({
    report: picomatch,
    exceptions: [exception],
    latest: { picomatch: '4.0.8' },
    today: '2026-11-17',
  });
  assert.match(released.failures[0], /picomatch 4\.0\.8 is published after 4\.0\.7/);
  const unknown = review({
    report: picomatch,
    exceptions: [exception],
    latest: {},
    today: '2026-11-17',
  });
  assert.match(unknown.failures[0], /\(unknown\)/);
});

test('an invalid exception fails and lets nothing through; an unused one is reported', () => {
  const result = review({
    report: picomatch,
    exceptions: [
      { ...exception, expires: 'soon' },
      { ...exception, reason: ' ' },
    ],
    latest: { picomatch: '4.0.7' },
    today: '2026-11-17',
  });
  assert.equal(result.failures.length, 3);
  assert.match(result.failures[0], /GHSA-1 is invalid: its expiry is not a YYYY-MM-DD date/);
  assert.match(result.failures[1], /GHSA-1 is invalid: it has no reason/);
  assert.match(result.failures[2], /^picomatch: .*GHSA-1\) https:/);
  const clean = review({
    report: { vulnerabilities: {} },
    exceptions: [exception, {}],
    latest: {},
    today: '2026-11-17',
  });
  assert.deepEqual(clean.unused, ['picomatch GHSA-1']);
  assert.match(clean.failures[0], /an advisory is invalid: it has no advisory/);
});
