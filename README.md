[![English — selected](public/languages/english-active.svg)](README.md)
[![Español](public/languages/spanish.svg)](README.es.md)

# Nexo API

**Your APIs. Your workspace. Your infrastructure.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Desktop packages](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml/badge.svg)](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml)
[![Downloads](https://img.shields.io/badge/Downloads-GitHub_Releases-blue)](https://github.com/DaftyCode/nexo_api/releases)

Nexo API is a **100% open source** application, licensed under MIT, for building, organizing, running and testing APIs on your computer.

We take inspiration from Postman and the convenience of keeping requests, collections, environments and tests in one place. From that inspiration, we are building an independent project with its own implementation and an architecture based on **Tauri + Rust + Angular**.

Our goal is a responsive tool that starts quickly, feels smooth and keeps you in control of your data. Rust runs the native backend, while Tauri integrates the operating system's WebView for the desktop interface. Requests, scripts, protocols, mocks and datasets also run in Rust, inside the same process; scripts run in an embedded QuickJS sandbox. Node is only needed to build the interface, never to run the app. We will publish reproducible startup, memory and latency benchmarks as the project develops.

The project is at an early stage. Contributions, ideas, testing and code reviews are welcome.

## What you can do

| Area                | Available features                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Requests            | HTTP/HTTPS, methods, query parameters, headers and responses; raw, JSON, text form bodies and GraphQL over HTTP.          |
| Organization        | Collections and folders, tabs, environments, variables, history and documents persisted in SQLite.                        |
| HTTP authentication | Every type of Postman, Bruno and Insomnia: Basic, Bearer, API key, Digest, OAuth 1.0, OAuth 2.0 (all grants, PKCE, sign-in window in the desktop app like Postman's, tokens in the vault, auto-refresh and auto-fetch), AWS Signature v4, Hawk, NTLM, JWT Bearer, Atlassian ASAP, Akamai EdgeGrid, WSSE and Netrc; inherited from folders and collections. |
| Scripts and tests   | Pre-request and response scripts, scoped variables, `nx.test`, `nx.expect`, `nx.sendRequest`, logs and assertion results. |
| Runner              | Collection iterations with JSON/CSV data, inherited scripts, progress, cancellation and JSON/JUnit reports from the CLI.  |
| Protocols           | WebSocket, Socket.IO, MQTT and gRPC clients with a supplied proto.                                                        |
| Import              | Portable JSON collections, environments, OpenAPI/Swagger JSON or YAML, HAR and cURL.                                      |
| Code                | Original generators for cURL, JavaScript/Node, Python, Java, Go, Rust, C# and PowerShell.                                 |
| Tools               | Local HTTP mocks, JSON/CSV datasets with read-only SQL queries, local Git and MCP client/server support.                  |
| Secrets             | AES-GCM encrypted vault, `{{vault:name}}` references, allowed domains per secret and secret redaction in results.         |
| Workspaces          | Several local workspaces, document history and revisions that prevent lost updates.                                       |
| Desktop and web     | Tauri desktop app, or the same interface in your browser through a local launcher when you cannot install the app.       |

Requests leave from your computer. Set `NEXO_EGRESS=deny-private` to refuse private and loopback destinations, except your own mocks; `NEXO_EGRESS_ALLOW` lists exceptions.

### Workspace layouts

The source includes three layouts, selectable from **Template**: **Aurora** (the default dark workspace), **Studio** (three columns with environment and request context), and **Canvas** (a light workspace with request and response side by side). They share the same collections, environments, variables, history and tools. Switching layouts keeps the active request and saves your preference on that device. Canvas exposes the workspace navigation through **Tools** and **Browse collections**. Classic has been retired.

These layouts will be included in the next desktop release; the published `v0.1.0` installers retain their original interface.

### Interface languages

The source includes **English and Spanish**, with a language selector on the website, documentation and workspace. Transloco updates labels, menus, forms, accessibility text and known application messages immediately, without reloading. The preference is saved on that device; English is the default and fallback language. Layout and language preferences are independent. Request payloads, responses, scripts, variable values and names you give your resources remain unchanged.

Translations live in `src/app/infrastructure/i18n/en.json` and `es.json`. Simple message IDs use their English source text; interpolated messages use named keys. Add matching entries in both catalogs and run `npm run i18n:check` to check coverage and interpolation parameters. New languages also need registration in the language catalog, providers and selector. Server/engine diagnostics without a translation retain their original text.

## Download and install

Versions are distributed through [GitHub Releases](https://github.com/DaftyCode/nexo_api/releases). Check each release's assets: a platform configured in CI does not automatically mean an installer has been published for it.

| Operating system | Architecture                              | Packages configured in CI                           |
| ---------------- | ----------------------------------------- | --------------------------------------------------- |
| Windows          | x64                                       | NSIS `.exe` installer and Windows Installer `.msi`. |
| macOS            | Apple Silicon and Intel, built separately | `.app` application inside a `.dmg`.                 |
| Linux            | x64                                       | `.deb`, `.rpm` and `.AppImage`.                     |

Each build runs on a runner for its operating system. Installers are self-contained: end users do not need to install Node or Rust.

### Microsoft Store

Publishing in the Microsoft Store is in preparation. The Store signs the package and keeps the app updated, so no code-signing certificate is needed. `npm run desktop:msix` builds the desktop app and packs it as MSIX with `makeappx` from the Windows SDK (`winget install --id Microsoft.WindowsSDK.10.0.26100 --exact` if it is missing). The Store identity comes from Partner Center through `NEXO_MSIX_NAME`, `NEXO_MSIX_PUBLISHER` and `NEXO_MSIX_PUBLISHER_NAME`, which are repository variables in CI. Without them the script produces a local test package.

### WinGet and enterprise deployment

The pipeline generates WinGet manifests with the proposed identifier `DaftyCode.NexoAPI`, release URLs and SHA-256 hashes calculated from the actual MSI. **Public catalog registration is pending**: a version must be published first, then its manifests submitted to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs).

After acceptance, the intended command will be:

```powershell
winget install --exact --id DaftyCode.NexoAPI --source winget
```

The MSI also lets IT teams deploy the application with their usual management tools. WinGet still uses an installer and follows company policies; it does not bypass execution restrictions or publisher trust requirements. Windows signing and enterprise environment validation are pending.

### Homebrew on macOS

Publishing a release triggers `Update package manager index`, which generates a cask with checksums for Apple Silicon and Intel and adds it to this repository. **The cask becomes available after the first release is published and that workflow succeeds.** Then:

```bash
brew tap daftycode/nexo https://github.com/DaftyCode/nexo_api
brew install --cask daftycode/nexo/nexo-api
```

We use our own tap; inclusion in Homebrew's central catalog is a separate step. CI builds use ad hoc signing on macOS. Apple Developer ID signing and notarization require distribution certificates and credentials, which still need to be configured.

### Linux with APT or DNF

Once published, packages downloaded from a release can be installed using your distribution's package manager:

```bash
# Debian / Ubuntu, from your download directory:
sudo apt install ./Nexo*.deb

# Fedora / compatible RPM distributions:
sudo dnf install ./Nexo*.rpm
```

IT teams can distribute these packages through their internal repositories. A public APT/YUM repository with its own indexes and signing is pending; `apt install nexo-api` is not yet available from system repositories. Flatpak and other catalogs are on the roadmap.

## How it works

![Nexo architecture: Angular and Tauri connect to the Rust backend, which coordinates SQLite, the vault and the request and scripting engine.](public/architecture.svg)

Nexo runs for one person on one computer. The desktop application starts a Rust service on a random loopback port and authenticates with a per-run token. The web version uses the same service: its launcher listens only on loopback and opens the browser with a one-time link that becomes an HttpOnly session cookie. Requests need a loopback Host header, an allowed Origin and the Nexo client header, so other websites and computers cannot use the service. Data stays in the app data directory; secrets are encrypted with a key kept in the operating system's credential store.

## Architecture we want to preserve

### Backend: hexagonal architecture

```text
backend/crates/
  nexo-domain/          Domain entities, rules and errors
  nexo-application/     Use cases and ports
  nexo-infrastructure/  SQLite, Git and credential store adapters
  nexo-engine/          Execution adapter: HTTP, QuickJS scripts, protocols, mocks, datasets, vault
  nexo-http/            HTTP adapter
  nexo-server/          Composition root and CLI
src-tauri/             Desktop composition root
```

The domain has no knowledge of HTTP, databases or graphical interfaces. Use cases depend on contracts; adapters implement those contracts. Tauri and the server compose the same capabilities.

### Frontend: Clean Architecture

```text
src/app/
  domain/          Angular-independent models and rules
  application/     Use cases and contracts
  infrastructure/  Contract implementations
  presentation/    Angular components, state and views
  composition/     Dependency injection and configuration
```

Presentation calls use cases. HTTP and file handling stay in infrastructure. We use standalone components, signals, OnPush, Signal Forms and lazy routes.

We follow **SOLID and Clean Code**: clear module responsibilities, small ports, inward dependencies, interchangeable implementations, concrete names and focused functions. Abstractions should solve a real need. `npm run test:architecture` checks layer boundaries.

## Build the desktop app from a clean checkout

Build on the operating system and CPU architecture you want to distribute: the scripts install the pinned Node and Rust toolchains, build the interface and the desktop app, and leave the installers under `target/release/bundle`. [docs/BUILD.md](docs/BUILD.md) explains the one-step install, the build options, manual builds, the local web version and the CLI.

## Current status and next steps

Tests already cover real requests, variables, scripts, assertions, cancellation, cookies, secret redaction, OpenAPI imports, executable generated code, data-driven runs, unary and streaming gRPC, WebSocket, Socket.IO, MQTT, egress policy, local access control and revisions. Contract tests in `tests/contract` drive the real server binary.

Important work remains:

- Validate the new installers on clean Windows, macOS and Linux machines; signing, notarization, automatic updates and catalog publication.
- Publish startup, memory and latency benchmarks.
- Binary file uploads, persistent cookie management and additional authentication helpers.
- Automatic OAuth browser/callback flows, GraphQL introspection/subscriptions, gRPC reflection and more protocol variants.
- Runner pause/resume, expanded scripting APIs and comprehensive proxy/mTLS tests.
- Real-time collaboration, comments, synchronization between installations and scheduled monitoring.
- Signed APT/YUM repositories and Flatpak distribution.

Current limits include 5 seconds and 128 MB of memory per script evaluation, eight active runs and response size limits for the interface. Cookies are kept per workspace in the data directory. Socket.IO binary events and MQTT 5 are not supported yet. External OpenAPI `$ref` references must be bundled before import. Unknown authorization types are rejected explicitly. Protocol and format support will grow alongside reproducible test cases.

## Contributing

You can open an [issue](https://github.com/DaftyCode/nexo_api/issues), propose an improvement, fix a bug, expand tests or submit a pull request. You do not need permission to get started. For larger changes, an issue describing the problem and proposal helps coordinate the work.

1. Fork the repository and create a focused branch, such as `feat/http-history` or `fix/runner-cancel`.
2. Keep each change focused on one problem and respect layer boundaries and responsibilities.
3. Add behavior tests when changing rules or adapters. Include a reproduction test when fixing a bug.
4. Run the relevant checks and explain the problem, resulting behavior and validation in your PR.
5. Preserve dependency notices and licenses. Keep local data, credentials and generated artifacts out of Git.

### Commits

We use Conventional Commits with a short subject and a scope where useful:

```text
feat(runner): support data-driven iterations
fix(vault): redact secrets from execution logs
refactor(domain): separate request validation
test(http): cover cross-origin redirects
docs(readme): explain the local web version
chore(packages): update installer manifests
```

Each commit should have one clear purpose. Explain the motivation in the body when it is not obvious from the change. Use `!` and `BREAKING CHANGE:` for incompatible contract changes. PRs should preserve backend hexagonal architecture, frontend Clean Architecture and SOLID principles.

### Maintainer review

The default branch is currently `master`. Contributions must use pull requests and require one approval from a code owner; [CODEOWNERS](.github/CODEOWNERS) currently assigns that review to **@DaftyCode**. New commits invalidate previous approvals, review conversations must be resolved, and force pushes and branch deletion are blocked for contributors. The personal repository owner retains an administrator bypass. The rules also cover `main` if that name is used later.

To add maintainers, invite them with write access and add their GitHub usernames to the first ownership pattern. Changes to `CODEOWNERS` and workflows continue to require the owner. Other people may leave reviews, but their approval does not replace the required code-owner approval. Package-index automation submits changes for review instead of pushing to the default branch.

### Checks

```bash
npm run test:architecture
npm run lint
npm test -- --watch=false
npm run engine:test
npm run e2e
npm run test:packages
npm run backend:test
npm run backend:clippy
npm run build
npm run build:desktop
npm run test:server
```

`engine:test` builds `nexo-server` and runs the contract tests against it. `e2e` drives the built interface (`npm run build`) with Playwright and checks accessibility with axe; run `npx playwright install chromium` once. `test:server` requires a release backend build. Reports are generated in `.verification`, outside Git. The local `docs/` directory is also excluded from the repository.

## Publishing a version

Run `Desktop packages` manually from Actions to check all four builds without publishing a release. A `vX.Y.Z` tag matching the project versions creates a **GitHub Release draft** with installers, `SHA256SUMS` and WinGet/Homebrew manifests. After reviewing and publishing the draft, the package index workflow proposes the cask and manifests on a separate branch and opens a PR when repository settings permit it. Otherwise it provides the branch and artifacts for the owner to open the PR. The owner reviews and merges those changes.

Public WinGet registration requires a separate PR to its official catalog. Generating packages and manifests does not mean they have been accepted into a package manager.

## License

Nexo API is distributed under [MIT](LICENSE): you can use, study, modify, redistribute and contribute to it, including in commercial environments. Dependencies retain their own licenses.
