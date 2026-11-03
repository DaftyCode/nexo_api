import { spawnSync } from 'node:child_process';
for (const name of [
  'workspace',
  'request-editor',
  'response-view',
  'key-value-editor',
  'tools-panel',
  'home',
]) {
  const r = spawnSync(
    process.execPath,
    [
      'node_modules/@angular/cli/bin/ng.js',
      'generate',
      'component',
      `presentation/${name}`,
      '--flat',
      '--change-detection=OnPush',
      '--interactive=false',
    ],
    { stdio: 'inherit' },
  );
  if (r.status) process.exit(r.status);
}
