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
| Requests            | HTTP/HTTPS, methods, query and path parameters, headers and responses; raw, JSON and form bodies, multipart and binary file uploads, and GraphQL with an explorer and autocompletion. |
| Organization        | Collections and folders, tabs, environments, variables, history and documents persisted in SQLite.                        |
| HTTP authentication | Every type of Postman, Bruno and Insomnia: Basic, Bearer, API key, Digest, OAuth 1.0, OAuth 2.0 (all grants, PKCE, sign-in window in the desktop app like Postman's, tokens in the vault, auto-refresh and auto-fetch), AWS Signature v4, Hawk, NTLM, JWT Bearer, Atlassian ASAP, Akamai EdgeGrid, WSSE and Netrc; inherited from folders and collections. |
| Scripts and tests   | Pre-request and response scripts, scoped variables, `nx.test`, `nx.expect`, `nx.sendRequest`, logs and assertion results. |
| Runner              | Collection iterations with JSON/CSV data, inherited scripts, progress, pause, cancellation, PDF reports and JSON/JUnit reports from the CLI. |
| Protocols           | WebSocket, Socket.IO, MQTT, Kafka, gRPC (with a proto or through reflection) and GraphQL subscriptions over WebSocket or SSE. |
| MongoDB             | Connections, explorer, queries, document editing with safeguards, indexes, explain, profiler, stage-by-stage aggregations, schema, JSON/CSV import and export, change streams, shell, code generation, SQL and compare/sync. |
| Import              | Portable JSON collections, environments, OpenAPI/Swagger JSON or YAML, HAR and cURL.                                      |
| Code                | Original generators for cURL, JavaScript/Node, Python, Java, Go, Rust, C# and PowerShell.                                 |
| Tools               | Local HTTP mocks, JSON/CSV datasets with read-only SQL queries, cookie manager, API definitions with a linter, Git with remotes and MCP client/server support. |
| Secrets             | AES-GCM encrypted vault, `{{vault:name}}` references, allowed domains per secret and secret redaction in results.         |
| Workspaces          | Several local workspaces, document history and revisions that prevent lost updates.                                       |
| Desktop and web     | Tauri desktop app, or the same interface in your browser through a local launcher when you cannot install the app.       |

Requests leave from your computer. Set `NEXO_EGRESS=deny-private` to refuse private and loopback destinations, except your own mocks; `NEXO_EGRESS_ALLOW` lists exceptions.

### Workspace layouts

The source includes three layouts, selectable from **Template**: **Aurora** (the default dark workspace), **Studio** (three columns with environment and request context), and **Canvas** (a light workspace with request and response side by side). They share the same collections, environments, variables, history and tools. Switching layouts keeps the active request and saves your preference on that device. Canvas exposes the workspace navigation through **Tools** and **Browse collections**. Classic has been retired. Every HTTP method has its own colour in all layouts (GET green, POST yellow, PUT blue, PATCH purple, DELETE red); colours and sizes can be changed through [CSS variables](#styles-design-tokens).

### Interface languages

The source includes **English and Spanish**, with a language selector on the website, documentation and workspace. Transloco updates labels, menus, forms, accessibility text and known application messages immediately, without reloading. The preference is saved on that device; English is the default and fallback language. Layout and language preferences are independent. Request payloads, responses, scripts, variable values and names you give your resources remain unchanged.

Translations live in `src/app/infrastructure/i18n/en.json` and `es.json`. Simple message IDs use their English source text; interpolated messages use named keys. Add matching entries in both catalogs and run `npm run i18n:check` to check coverage and interpolation parameters. New languages also need registration in the language catalog, providers and selector. Server/engine diagnostics without a translation retain their original text.

## Download and install

Versions are published on [GitHub Releases](https://github.com/DaftyCode/nexo_api/releases). Check each release's assets: a platform configured in CI does not automatically mean an installer has been published for it.

| Operating system | Architecture                              | Packages configured in CI                           |
| ---------------- | ----------------------------------------- | --------------------------------------------------- |
| Windows          | x64                                       | NSIS `.exe` installer and Windows Installer `.msi`. |
| macOS            | Apple Silicon and Intel, built separately | `.app` application inside a `.dmg`.                 |
| Linux            | x64                                       | `.deb`, `.rpm` and `.AppImage`.                     |

Each build runs on a runner for its operating system. Installers are self-contained: end users do not need to install Node or Rust.

### Microsoft Store

[<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200" alt="Get it from Microsoft">](https://apps.microsoft.com/detail/9N6H77VSRDQ4?mode=direct)

Nexo API is in the Microsoft Store: the Store signs the package, installs it and keeps the app updated. On Windows, the button opens the listing directly in the Store app. To build the MSIX package locally, run `npm run desktop:msix` (it needs the Windows SDK).

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

### Styles: design tokens

Every colour and size in the interface is a `--nexo-*` CSS variable. Style rules only read variables; the values live in one place:

- **Global tokens** (`src/styles/tokens/`): the typography, spacing, size, corner, border, shadow, motion and stacking scales; the semantic palette (backgrounds, surfaces, borders, text, accent, states, code); one token per workspace area (top bar, navigation, tabs, URL bar, panels) and the HTTP method colours.
- **Theme tokens** (each template's `_theme.scss`): Aurora, Studio and Canvas only redefine values; they do not repeat rules.

They sit in the `nexo-tokens` CSS layer, so any external stylesheet overrides them without `!important`:

```css
.studio {
  --nexo-color-accent: #2f81f7;
  --nexo-space-unit: 2.5px; /* a looser interface */
}
```

We want changing a theme to mean changing variables, and anyone to be able to make their own. Loading custom themes from the app is the next step. `npm run test:architecture` rejects literal colours or sizes outside the token files. The full guide is in [src/styles/README.md](src/styles/README.md).

## Build the desktop app from a clean checkout

Build on the operating system and CPU architecture you want to distribute: the scripts install the pinned Node and Rust toolchains, build the interface and the desktop app, and leave the installers under `target/release/bundle`. [docs/BUILD.md](docs/BUILD.md) explains the one-step install, the build options, manual builds, the local web version and the CLI.

## Current status and next steps

The current version is **0.6.0**, with the complete MongoDB client. Tests cover real requests, variables, scripts, assertions, cancellation, cookies, secret redaction, OpenAPI imports, executable generated code, data-driven runs, every authorization type (with official vectors and verifying servers), unary and streaming gRPC with a proto or reflection, WebSocket, Socket.IO, MQTT, Kafka, GraphQL subscriptions, real MongoDB and FerretDB, egress policy, local access control and revisions. Contract tests in `tests/contract` drive the real server binary.

Next steps:

- An AI assistant using each user's own API key.
- SSH tunnels and SOCKS5 proxies, protected environments, restoring tabs on start, scheduled runs, response comparison, Excel/CSV export with masked data, JSON Schema inference from responses, and imports from Insomnia, Bruno, Hoppscotch and Thunder Client.
- Custom themes from the app, built on the design tokens.
- Removing the Node left in the development tooling: contract tests and build scripts in Rust.
- Distribution: WinGet, Homebrew, signed APT/YUM repositories and Flatpak; Windows signing outside the Store and macOS notarization; validating the installers on clean machines.
- Publishing startup, memory and latency benchmarks.
- More databases, to be decided.

Current limits include 5 seconds and 128 MB of memory per script evaluation, eight active runs and response size limits for the interface. Cookies are kept per workspace in the data directory. MQTT 5, Socket.IO 2.x (Engine.IO v3) and Kafka consumer groups, transactions and Schema Registry are not supported yet. External OpenAPI `$ref` references must be bundled before import. Unknown authorization types are rejected explicitly. Protocol and format support will grow alongside reproducible test cases.

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

## License

Nexo API is distributed under [MIT](LICENSE): you can use, study, modify, redistribute and contribute to it, including in commercial environments. Dependencies retain their own licenses.
