# Nexo API project instructions

- This repository contains the original Nexo API application source.
- Preserve Rust hexagonal dependencies: domain → no adapters; application → domain and ports; infrastructure → application; HTTP → application; server and desktop are composition roots.
- Preserve Angular Clean Architecture: domain and application contain no Angular imports. Presentation calls application-owned contracts. Infrastructure implements those contracts. The composition root binds providers.
- Use the official Angular skills retained at `tools/agent-skills/angular-developer/SKILL.md` and `tools/agent-skills/angular-new-app/SKILL.md`, and read relevant referenced guidance before changing forms, rendering or tests.
- Angular 22 uses Signal Forms, standalone components, signals, OnPush, modern template control flow, and lazy routes. Do not introduce React or NgModules.
- Use the Rust Book, Cargo Book and Rust API Guidelines as official Rust references. No third-party skill is represented as an official Rust skill.
- Preserve document revisions, actor/workspace authorization, secret redaction, engine operation allowlists and loopback-only local mode.
- Never import browser-only code into SSR paths. Private API responses must not enter the Angular transfer cache.
- Add adapters through narrow ports; keep vendor packages outside inward layers. Add meaningful contract tests for behavior changes.
- Required checks: `npm run test:architecture`, `npm test -- --watch=false`, `npm run engine:test`, `npm run backend:test`, `npm run backend:clippy`, `npm run build`, `npm run build:desktop`.
- Refresh both dependency lockfiles deliberately. Node LTS provenance is generated in the ignored `tools/runtime/node-runtime.json` file.
- The desktop build includes its runtime. A UI preview does not verify the packaged executable; use the native app for release verification.
