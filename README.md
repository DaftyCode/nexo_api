[![English — selected](public/languages/english-active.svg)](README.md)
[![Español](public/languages/spanish.svg)](README.es.md)

# Nexo API

**Your APIs. Your workspace. Your infrastructure.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Desktop packages](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml/badge.svg)](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml)
[![Downloads](https://img.shields.io/badge/Downloads-GitHub_Releases-blue)](https://github.com/DaftyCode/nexo_api/releases)

Nexo API is a **100% open source** application, licensed under MIT, for building, organizing, running and testing APIs on your computer or your own server.

We take inspiration from Postman and the convenience of keeping requests, collections, environments and tests in one place. From that inspiration, we are building an independent project with its own implementation and an architecture based on **Tauri + Rust + Angular**.

Our goal is a responsive tool that starts quickly, feels smooth and keeps you in control of your data. Rust runs the native backend, while Tauri integrates the operating system's WebView for the desktop interface. The request and scripting engine currently uses an auxiliary Node runtime, included in the installer; moving more work to Rust is part of our roadmap. We will publish reproducible startup, memory and latency benchmarks as the project develops.

The project is at an early stage. Contributions, ideas, testing and code reviews are welcome.

## What you can do

| Area                | Available features                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Requests            | HTTP/HTTPS, methods, query parameters, headers and responses; raw, JSON, text form bodies and GraphQL over HTTP.          |
| Organization        | Collections and folders, tabs, environments, variables, history and documents persisted in SQLite.                        |
| HTTP authentication | Basic, Bearer, API key, MD5/SHA-256 Digest and OAuth2 tokens; token exchange in the integrations panel.                   |
| Scripts and tests   | Pre-request and response scripts, scoped variables, `nx.test`, `nx.expect`, `nx.sendRequest`, logs and assertion results. |
| Runner              | Collection iterations with JSON/CSV data, inherited scripts, progress, cancellation and JSON/JUnit reports from the CLI.  |
| Protocols           | WebSocket, Socket.IO, MQTT and gRPC clients with a supplied proto.                                                        |
| Import              | Portable JSON collections, environments, OpenAPI/Swagger JSON or YAML, HAR and cURL.                                      |
| Code                | Original generators for cURL, JavaScript/Node, Python, Java, Go, Rust, C# and PowerShell.                                 |
| Tools               | Local HTTP mocks, JSON/CSV datasets with read-only SQL queries, local Git and MCP client/server support.                  |
| Secrets             | AES-GCM encrypted vault, `{{vault:name}}` references and secret redaction in results.                                     |
| Server              | Accounts, revocable sessions, workspaces, members, roles and revisions that prevent lost updates.                         |
| Desktop and web     | Local Tauri application; Angular SSR for the public website/documentation and a client-rendered private editor.           |

Requests originate from the local engine or the server where you deploy it. In server mode, private network URLs are resolved from that server's network.

### Workspace layouts

The source includes three layouts, selectable from **Template**: **Aurora** (the default dark workspace), **Studio** (three columns with environment and request context), and **Canvas** (a light workspace with request and response side by side). They share the same collections, environments, variables, history and tools. Switching layouts keeps the active request and saves your preference on that device. Canvas exposes the workspace navigation through **Tools** and **Browse collections**. Classic has been retired.

These layouts will be included in the next desktop release; the published `v0.1.0` installers retain their original interface.

## Download and install

Versions are distributed through [GitHub Releases](https://github.com/DaftyCode/nexo_api/releases). Check each release's assets: a platform configured in CI does not automatically mean an installer has been published for it.

| Operating system | Architecture                              | Packages configured in CI                           |
| ---------------- | ----------------------------------------- | --------------------------------------------------- |
| Windows          | x64                                       | NSIS `.exe` installer and Windows Installer `.msi`. |
| macOS            | Apple Silicon and Intel, built separately | `.app` application inside a `.dmg`.                 |
| Linux            | x64                                       | `.deb`, `.rpm` and `.AppImage`.                     |

Each build runs on a runner for its operating system. Installers include the auxiliary runtime, so end users do not need to install Node or Rust.

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

The desktop application starts a Rust service on a random loopback port and authenticates with its own token. It stores data locally and works without an account. Server mode adds authentication and workspace permissions and can run on your own infrastructure.

The public website and `/docs` use server rendering. The `/workspace` editor uses client rendering, carries `noindex` and excludes private data from Angular's transfer cache.

## Architecture we want to preserve

### Backend: hexagonal architecture

```text
backend/crates/
  nexo-domain/          Domain entities, rules and errors
  nexo-application/     Use cases and ports
  nexo-infrastructure/  SQLite, execution, Git and vault adapters
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

Download the repository ZIP and extract it, or clone it:

```bash
git clone https://github.com/DaftyCode/nexo_api.git
cd nexo_api
```

Run the following commands from the repository root, where `package.json` is located. **Build on the operating system and CPU architecture you want to distribute.** Our CI builds Windows x64, macOS Apple Silicon, macOS Intel and Linux x64 separately. The scripts do not implement cross-compilation or a universal macOS bundle.

### Automatic setup and build

You do not have to download Node, Rust or npm dependencies manually. The bootstrap scripts:

1. Reuse the Node version in [.node-version](.node-version), or download the official archive and verify its SHA-256 before extraction.
2. Check the native build tools and prepare missing system dependencies through WinGet on Windows, the Apple installer on macOS, or APT/DNF on Linux.
3. Install Rustup if missing, verifying its official download, and prepare the Rust version in [rust-toolchain.toml](rust-toolchain.toml).
4. Run `npm ci`, prepare the bundled execution engine, build Angular and Rust, and generate native packages.

The first run needs Internet access and may download several GB of SDKs and toolchains. System installers can request administrator permission, license acceptance or a restart. Complete those prompts yourself and rerun the same command if setup pauses. The script does not accept Microsoft or Apple agreements on your behalf. A fresh build is **not an offline build**.

**Windows x64 — PowerShell**

```powershell
.\build.ps1
```

WinGet must be available through Microsoft's [App Installer](https://learn.microsoft.com/en-us/windows/package-manager/winget/). Missing C++ build tools, WebView2 and Git are prepared through it. If your organization blocks PowerShell scripts or software installation, use its approved setup process or the GitHub Actions option below.

**macOS — Terminal, on Apple Silicon or Intel**

```bash
bash build.sh
```

If the Apple Command Line Tools installer opens, finish installation and rerun the command. The default local build uses ad hoc signing (`APPLE_SIGNING_IDENTITY=-`), matching CI. It does not create a Developer ID signature or notarize the app; see [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) for distribution credentials.

**Linux — Terminal, on Ubuntu/Debian or Fedora**

```bash
bash build.sh
```

The script installs missing compiler, WebKitGTK, OpenSSL, D-Bus and packaging dependencies using APT or DNF and `sudo` when needed. Ubuntu 22.04 x64 is the CI reference. Other distributions need the equivalent [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) installed manually, then the same script with `--skip-system-install`. Build AppImages on the oldest distribution you intend to support; see [Tauri's AppImage compatibility guidance](https://v2.tauri.app/distribute/appimage/).

### Where the packages are generated

| Build host | Output relative to the repository root                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Windows    | `target/release/bundle/nsis/*-setup.exe` and `target/release/bundle/msi/*.msi`                                       |
| macOS      | `target/release/bundle/macos/Nexo API.app` and `target/release/bundle/dmg/*.dmg`                                     |
| Linux      | `target/release/bundle/appimage/*.AppImage`, `target/release/bundle/deb/*.deb` and `target/release/bundle/rpm/*.rpm` |

Install or copy the **generated package**. The raw binary in `target/release/` by itself does not include all runtime resources. The packaged desktop app includes its execution runtime, so end users do not need Node or Rust installed.

Downloaded Node archives and bootstrap tools are cached in `.build-tools/`, which is ignored by Git. Rustup uses its normal user directories; native SDKs use their system installation locations. Dependencies and build outputs are also ignored. Subsequent builds reuse tools and caches; package managers may still access the network.

### Useful build options

| Purpose                                                     | PowerShell                       | macOS/Linux                                                                    |
| ----------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| Check prerequisites without installing or building          | `.\build.ps1 -Check`             | `bash build.sh --check`                                                        |
| Prepare tools without installing npm packages or compiling  | `.\build.ps1 -ToolsOnly`         | `bash build.sh --tools-only`                                                   |
| Prepare tools and npm packages without compiling            | `.\build.ps1 -PrepareOnly`       | `bash build.sh --prepare-only`                                                 |
| Use existing system SDKs without installing system packages | `.\build.ps1 -SkipSystemInstall` | `bash build.sh --skip-system-install`                                          |
| Generate one package format                                 | `.\build.ps1 -Bundles nsis`      | `bash build.sh --bundles dmg` (macOS) or `bash build.sh --bundles deb` (Linux) |

Options can be combined. Check mode reports a missing Node version without downloading it. For MSI packaging, Windows needs the VBScript optional feature; if WiX reports `failed to run light.exe`, follow [Tauri's MSI prerequisites](https://v2.tauri.app/distribute/windows-installer/#building) or build only NSIS with `-Bundles nsis`. For `link.exe` errors, install the C++ desktop workload and Windows SDK. For Linux `pkg-config` errors, check the WebKitGTK **4.1** development packages.

If `npm ci` reports `EBUSY` for Sass or esbuild on Windows, stop this checkout's `npm run dev`, `ng serve`, desktop development and watch/test sessions before retrying. Do not run the bootstrap alongside a development server: `npm ci` replaces `node_modules`. A Node 24 `EBADENGINE` warning means your terminal is using the wrong runtime; `build.ps1` uses the prepared Node 26.13 without replacing your system-wide Node installation.

### Manual build and development

If you manage tools yourself, install Git, Node **26.13.0** with npm, Rustup and your [platform's native prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows select **Desktop development with C++**, a Windows SDK and WebView2. On macOS use `xcode-select --install`. Reopen the terminal after installing tools. From the cloned repository:

```bash
node --version
npm --version
rustup show active-toolchain
npm ci
```

Choose the native build command:

```powershell
# Windows x64:
npm run desktop:build -- --bundles nsis,msi
```

```bash
# macOS (build separately on Apple Silicon and Intel):
APPLE_SIGNING_IDENTITY=- npm run desktop:build -- --bundles app,dmg

# Linux:
NO_STRIP=true npm run desktop:build -- --bundles appimage,deb,rpm
```

`desktop:build` generates native installers. `build:desktop` only compiles the Angular interface and does **not** produce an installer. Do not run multiple builds in the same checkout at the same time.

For desktop development, after `npm ci`:

```bash
npm run engine:build
npm run desktop:prepare
npm run desktop:dev
```

For web development, run `npm run engine:build` and `npm run dev`. Open [http://localhost:4200/workspace](http://localhost:4200/workspace); the backend listens on loopback port 8080. Stop a web development session before starting `desktop:dev`, because both use port 4200.

### Build all platforms without installing local tools

Fork the repository, open **Actions → Desktop packages → Run workflow**, and select your branch. The existing workflow builds the four native targets on GitHub's Windows, macOS and Linux runners. Download the `nexo-*` artifacts from the completed run; artifact retention is 14 days. A manual run does not publish a release. Actions must be enabled on the fork and GitHub's usage limits apply.

### Why Node is still included

| Use                                 | Current role                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build tools                         | npm, Angular CLI and the frontend/engine build pipeline. These run on the developer's machine or CI.                                                                                                                                                                                                                    |
| Installed desktop app / API backend | The private auxiliary engine in `engine/src/`: HTTP/GraphQL requests, authentication helpers, cookies, JavaScript scripts/tests, runner/performance jobs, real-time protocols, import/code generation, mocks, datasets, MCP and vault encryption. Rust currently delegates these operations through `ExecutionGateway`. |
| Self-hosted website                 | Angular SSR and its HTTP proxy run in Node. Public page rendering is separate from the Rust API service.                                                                                                                                                                                                                |

Rust already handles the native desktop shell, API service, SQLite documents/revisions, users/sessions/permissions and local Git adapter. Removing the bundled Node runtime requires implementing the delegated operations in Rust and preserving their contracts. JavaScript scripts need an embedded JavaScript engine or an explicitly supported replacement, and existing vault data needs a compatible migration. Deleting Node today would break those features.

Our migration path is to replace adapters behind the existing ports, starting with native transport and local services, then protocols and scripting, with the current contract tests validating each replacement. A desktop runtime without Node is feasible; Angular development would still use Node, and Angular SSR would continue to need it unless the website rendering approach also changes. **The Node runtime has not been removed by the bootstrap scripts.**

### Self-hosted server

```bash
npm run build
npm run backend:build
npm run preview:server
```

Open [http://localhost:4000](http://localhost:4000). This command starts SSR and a server-mode backend on loopback port 8081, with separate data in `.nexo-server`. The first visit lets you create the owner account; subsequent registration is disabled by default.

You can also run `npm run server:start` and `npm run serve:ssr:nexo` as separate processes. The web server uses `NEXO_API_URL`, defaulting to `http://127.0.0.1:8080`.

```bash
docker compose up --build -d
```

Create `.env` from `.env.example`, configure allowed origins and use an HTTPS reverse proxy for your domain. The `nexo-data` volume persists documents, users, revisions and secrets. The Compose configuration has been validated; running the container still needs verification.

### CLI

```bash
npm run nexo -- run collection.json --environment environment.json --iterations 5 --data rows.json --report result.json --junit result.xml
npm run nexo -- request request.json
npm run nexo -- import specification.yaml --report collection.json
```

The CLI shares the execution engine with the desktop and server and returns an error exit code when a run or assertion fails.

## Current status and next steps

Tests already cover real requests, variables, scripts, assertions, cancellation, cookies, secret redaction, OpenAPI imports, executable generated code, data-driven runs, unary gRPC, WebSocket, Socket.IO, MQTT, permissions, revisions and SSR.

Important work remains:

- Validate the new installers on clean Windows, macOS and Linux machines; signing, notarization, automatic updates and catalog publication.
- Benchmark performance and move more capabilities from the auxiliary runtime into Rust.
- Binary file uploads, persistent cookie management and additional authentication helpers.
- Automatic OAuth browser/callback flows, GraphQL introspection/subscriptions, gRPC reflection and more protocol variants.
- Runner pause/resume, expanded scripting APIs and comprehensive proxy/mTLS tests.
- Real-time collaboration, comments, synchronization between installations and scheduled monitoring.
- Signed APT/YUM repositories and Flatpak distribution.

Current limits include 5 seconds per script evaluation, 256 MB execution processes and response size limits for the interface. Cookies last for the engine's lifetime. External OpenAPI `$ref` references must be bundled before import. Unimplemented HTTP authentication helpers are rejected explicitly. Protocol and format support will grow alongside reproducible test cases.

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
docs(readme): explain self-hosted setup
chore(packages): update installer manifests
```

Each commit should have one clear purpose. Explain the motivation in the body when it is not obvious from the change. Use `!` and `BREAKING CHANGE:` for incompatible contract changes. PRs should preserve backend hexagonal architecture, frontend Clean Architecture and SOLID principles.

### Maintainer review

The default branch is currently `master`. Contributions must use pull requests and require one approval from a code owner; [CODEOWNERS](.github/CODEOWNERS) currently assigns that review to **@DaftyCode**. New commits invalidate previous approvals, review conversations must be resolved, and force pushes and branch deletion are blocked for contributors. The personal repository owner retains an administrator bypass. The rules also cover `main` if that name is used later.

To add maintainers, invite them with write access and add their GitHub usernames to the first ownership pattern. Changes to `CODEOWNERS` and workflows continue to require the owner. Other people may leave reviews, but their approval does not replace the required code-owner approval. Package-index automation submits changes for review instead of pushing to the default branch.

### Checks

```bash
npm run test:architecture
npm test -- --watch=false
npm run engine:test
npm run test:packages
npm run backend:test
npm run backend:clippy
npm run build
npm run build:desktop
npm run test:server
npm run test:ssr
```

`test:server` requires a release backend build. `test:ssr` requires the SSR build, a local backend on port 8080 and port 4000 available. Reports are generated in `.verification`, outside Git. The local `docs/` directory is also excluded from the repository.

## Publishing a version

Run `Desktop packages` manually from Actions to check all four builds without publishing a release. A `vX.Y.Z` tag matching the project versions creates a **GitHub Release draft** with installers, `SHA256SUMS` and WinGet/Homebrew manifests. After reviewing and publishing the draft, the package index workflow proposes the cask and manifests on a separate branch and opens a PR when repository settings permit it. Otherwise it provides the branch and artifacts for the owner to open the PR. The owner reviews and merges those changes.

Public WinGet registration requires a separate PR to its official catalog. Generating packages and manifests does not mean they have been accepted into a package manager.

## License

Nexo API is distributed under [MIT](LICENSE): you can use, study, modify, redistribute and contribute to it, including in commercial environments. Dependencies retain their own licenses.
