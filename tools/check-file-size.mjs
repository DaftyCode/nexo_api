// Fails when a versioned text file is longer than MAX_LINES. A long file is split by what
// it does, with its tests in their own files; only the files in EXCEPTIONS may be longer,
// each with the reason it cannot be split.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_LINES = 300;

/** Files that may pass the limit, and why. Add one only when splitting it is not possible
 * or would make it worse; the owner approves each entry. */
const EXCEPTIONS = [
  {
    pattern: /^src\/app\/infrastructure\/i18n\/[a-z-]+\.json$/,
    reason: 'one catalog per language, with the same keys in the same order (i18n:check)',
  },
  {
    pattern: /^src\/app\/application\/payloads\.ts$/,
    reason: 'generated from payloads.rs by NEXO_UPDATE_CONTRACTS=1; never edited by hand',
  },
  {
    pattern: /^src\/app\/testing\/explain\/mongo-[\d.]+-[a-z]+\.json$/,
    reason: 'explain output recorded from a real MongoDB server, kept as it was answered',
  },
  {
    pattern: /^tools\/agent-skills\//,
    reason: 'official Angular skills, kept verbatim as published',
  },
];

/** Files still to split (docs/tareas/R-01-dividir-componentes.md). Temporary: each one leaves
 * this list in the change that splits it, and nothing is added to it. */
const PENDING = [
  'src/app/application/mongo-use-cases.ts',
  'src/app/application/workspace-use-cases.ts',
  'src/app/presentation/auth-editor.html',
  'src/app/presentation/integration-panel.html',
  'src/app/presentation/integration-panel.ts',
  'src/app/presentation/mongo-explorer.html',
  'src/app/presentation/mongo-explorer.ts',
  'src/app/presentation/mongo-panel.html',
  'src/app/presentation/mongo-writes.ts',
  'src/app/presentation/oauth2-editor.html',
  'src/app/presentation/protocol-panel.html',
  'src/app/presentation/request-editor.html',
  'src/app/presentation/workspace-state.ts',
  'src/app/presentation/workspace.html',
  'src/app/presentation/workspace.ts',
];

/** Written by tools or not text: lockfiles, images, fonts and archives. */
const SKIPPED =
  /(?:^|\/)(?:package-lock\.json|Cargo\.lock)$|\.(?:png|jpe?g|gif|ico|icns|webp|svg|woff2?|ttf|otf|pdf|zip|gz|wasm|exe|dll|der|p12|pfx)$/i;

const lineCount = (text) =>
  text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// Versioned files and new ones not ignored, so a new long file fails before it is committed.
const paths = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .split('\0')
  .filter(Boolean);

const failures = [];
const pending = [];
for (const path of paths) {
  if (SKIPPED.test(path) || EXCEPTIONS.some(({ pattern }) => pattern.test(path))) continue;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue; // Deleted from the working tree but still in the index.
  }
  const lines = lineCount(text);
  if (lines <= MAX_LINES) continue;
  (PENDING.includes(path) ? pending : failures).push({ path, lines });
}
// A pending file that is already short enough must leave the list.
const done = PENDING.filter((path) => !pending.some((entry) => entry.path === path));
if (pending.length > 0) {
  console.warn(`${pending.length} files are still to split (PENDING):`);
  for (const { path, lines } of pending) console.warn(`  ${lines}\t${path}`);
}
if (failures.length > 0 || done.length > 0) {
  failures.sort((a, b) => b.lines - a.lines);
  if (failures.length > 0)
    console.error(
      `${failures.length} files are longer than ${MAX_LINES} lines; split them by what they do:`,
    );
  for (const { path, lines } of failures) console.error(`  ${lines}\t${path}`);
  for (const path of done) console.error(`  ${path} is split: remove it from PENDING.`);
  process.exit(1);
}
console.log(
  pending.length > 0
    ? `File sizes: no other file passes ${MAX_LINES} lines; ${pending.length} still to split.`
    : `File sizes: every file has at most ${MAX_LINES} lines (${EXCEPTIONS.length} exceptions).`,
);
