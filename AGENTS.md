# Nexo API project instructions

## Git workflow agreed with the owner

- The user reviews changes and personally creates commits and pushes them to GitHub.
- Leave changes unstaged. Do not run `git add`, `git commit` or `git push` automatically.
- Do not create commits or upload code through the GitHub API, browser or automation to bypass this workflow.
- At the end of each change, provide a proposed Conventional Commits title and a concise description of the changes and validation.
- Read-only Git commands remain allowed. Only perform commit or push operations if the user explicitly requests that specific operation later.


- This repository contains the original Nexo API application source.
- Preserve Rust hexagonal dependencies: domain → no adapters; application → domain and ports; infrastructure and engine → application; HTTP → application; server and desktop are composition roots.
- Nexo is single-user and local: one person, loopback only, per-run token or one-time link session. Do not reintroduce accounts, members or server hosting unless the owner asks.
- The runtime contains no Node: `nexo-engine` (Rust) runs requests, QuickJS scripts, protocols, mocks, datasets and the vault. Node is a build tool only, pinned by `.node-version`.
- Preserve Angular Clean Architecture: domain and application contain no Angular imports. Presentation calls application-owned contracts. Infrastructure implements those contracts. The composition root binds providers.
- Use the official Angular skills retained at `tools/agent-skills/angular-developer/SKILL.md` and `tools/agent-skills/angular-new-app/SKILL.md`, and read relevant referenced guidance before changing forms, rendering or tests.
- Angular 22 uses Signal Forms, standalone components, signals, OnPush, modern template control flow, and lazy routes. Do not introduce React or NgModules.
- Use the Rust Book, Cargo Book and Rust API Guidelines as official Rust references. No third-party skill is represented as an official Rust skill.
- Preserve document revisions, workspace scoping, secret redaction, the egress policy, the script sandbox limits, engine operation allowlists and loopback-only access.
- The interface is client-rendered only (no SSR). Private API responses must not be cached or persisted by the browser.
- Add adapters through narrow ports; keep vendor packages outside inward layers. Add meaningful contract tests for behavior changes.
- Required checks: `npm run test:architecture`, `npm test -- --watch=false`, `npm run engine:test`, `npm run backend:test`, `npm run backend:clippy`, `npm run build`, `npm run build:desktop`.
- Refresh both dependency lockfiles deliberately. `engine:test` builds `nexo-server` and runs the contract tests in `tests/contract`; behavior changes in the engine need a contract test there.
- The desktop build includes its runtime. A UI preview does not verify the packaged executable; use the native app for release verification.
