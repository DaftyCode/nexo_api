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

Download the repository ZIP and extract it, or clone it:

```bash
git clone https://github.com/DaftyCode/nexo_api.git
cd nexo_api
```

Run the following commands from the repository root, where `package.json` is located. **Build on the operating system and CPU architecture you want to distribute.** Our CI builds Windows x64, macOS Apple Silicon, macOS Intel and Linux x64 separately. The scripts do not implement cross-compilation or a universal macOS bundle.

### One-step install on this computer

Download or clone the repository, open a terminal in its folder and run the script for your operating system. Nothing has to be installed beforehand, and no `.exe` installer is opened, so this also works on company computers that only allow system package tools.

| Goal | Windows (PowerShell) | macOS / Linux (Terminal) |
| --- | --- | --- |
| Install the desktop app | `.\install-desktop.ps1` | `bash install-desktop.sh` |
| Install and open the web version | `.\install-web.ps1` | `bash install-web.sh` |

If PowerShell refuses to run scripts on this computer, start them for this run only with `powershell -ExecutionPolicy Bypass -File .\install-desktop.ps1` (or `install-web.ps1`). If your organization also blocks that, ask IT to deploy the `.msi` from the releases.

**What the scripts prepare when something is missing.** Node (the official archive, checksum verified) and Rustup are downloaded into the project. System prerequisites come from the operating system's package tools:

- Windows: WinGet installs the C++ Build Tools, the WebView2 runtime and Git.
- macOS: the Xcode Command Line Tools.
- Linux: APT or DNF install the compiler, WebKitGTK and the packaging tools.

Administrator prompts, licence agreements or a restart may appear. Accept them and run the same command again. On Windows, WinGet comes with the App Installer from the Microsoft Store. If your organization removed it, install the prerequisites through your IT department or use `-SkipSystemInstall`.

**Desktop** (`install-desktop`) detects the operating system and builds only its package:

- Windows: the `.msi`, installed with `msiexec` (Windows Installer). Windows asks for administrator rights once.
- Linux: the `.deb` with APT, or the `.rpm` with DNF or Zypper. On other distributions the AppImage goes into `~/.local/bin` with a menu entry.
- macOS: the `.app`, copied into Applications.

Then it starts the app. Options: `-Package`/`--package <file>` installs a package you already have, `-NoLaunch`/`--no-launch` does not start it, and `-SkipSystemInstall`/`--skip-system-install` uses the tools already installed.

**Web** (`install-web`) is for computers where the desktop app cannot be installed:

- Not installed yet: builds the interface and the local server, starts it in the background on `http://127.0.0.1:4000` and opens the browser signed in.
- Installed but stopped: starts it in a few seconds without building anything.
- Already running: only opens a new browser session.

When the sources changed since the installation, the script says so; update with `-Rebuild`/`--rebuild`. Other options: `-Stop`/`--stop`, `-Status`/`--status` and `-NoOpen`/`--no-open`, which prints the sign-in link instead of opening the browser. `NEXO_WEB_PORT` changes the port. The web version only listens on this computer and shares its data with the desktop app; logs are in `.nexo-web/logs`.

### Automatic setup and build

You do not have to download Node, Rust or npm dependencies manually. The bootstrap scripts:

1. Reuse the Node version in [.node-version](.node-version), or download the official archive and verify its SHA-256 before extraction.
2. Check the native build tools and prepare missing system dependencies through WinGet on Windows, the Apple installer on macOS, or APT/DNF on Linux.
3. Install Rustup if missing, verifying its official download, and prepare the Rust version in [rust-toolchain.toml](rust-toolchain.toml) for the native compiler host (MSVC on Windows).
4. Run `npm ci --omit=dev` (only the build tools; lint, tests and their servers are for development), build Angular and Rust, and generate native packages.

The first run needs Internet access and may download several GB of SDKs and toolchains. System installers can request administrator permission, license acceptance or a restart. Complete those prompts yourself and rerun the same command if setup pauses. The script does not accept Microsoft or Apple agreements on your behalf. A fresh build is **not an offline build**.

**Windows x64 — PowerShell**

```powershell
.\build.ps1
```

WinGet must be available through Microsoft's [App Installer](https://learn.microsoft.com/en-us/windows/package-manager/winget/). Missing C++ build tools, WebView2 and Git are prepared through it. If your organization blocks PowerShell scripts or software installation, use its approved setup process or the GitHub Actions option below.

An existing GNU/MinGW Rust setup can coexist with this build. The bootstrap selects the pinned `x86_64-pc-windows-msvc` toolchain for itself and its child processes, installing it if missing. It does not change your global Rust default or directory overrides. An existing `RUSTUP_TOOLCHAIN` selection is replaced only inside the build process and reported in the output; conflicting `CARGO_BUILD_TARGET` settings are rejected with a specific message.

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

Install or copy the **generated package**. The packaged desktop app is self-contained, so end users do not need Node or Rust installed.

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

If an older checkout stops with `Node and Rust must use the same native architecture`, update the checkout and rerun the build. That older check also reported Rustup failures or a GNU toolchain as an architecture error. The current script checks `rustc -vV` for the selected native compiler and preserves Rustup's error details when it cannot run. On managed computers, downloads still need access through your organization's approved network/proxy configuration.

When a step fails, the scripts end with what failed and a hint for the usual causes: a proxy or registry mirror that cuts downloads, files held by an editor or a development server, or an antivirus that blocks a Rust build script. The output of the failed step is kept in `.build-tools/last-error.log` (`.nexo-web/logs/install-error.log` for the web version), so you can share it with IT.

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

For desktop development, after `npm ci`, run `npm run desktop:dev`.

For web development, run `npm run dev`. Open [http://localhost:4200/workspace](http://localhost:4200/workspace); the backend listens on loopback port 8080 and keeps its data in `.nexo/`. Stop a web development session before starting `desktop:dev`, because both use port 4200.

### Build all platforms without installing local tools

Fork the repository, open **Actions → Desktop packages → Run workflow**, and select your branch. The existing workflow builds the four native targets on GitHub's Windows, macOS and Linux runners. Download the `nexo-*` artifacts from the completed run; artifact retention is 14 days. A manual run does not publish a release. Actions must be enabled on the fork and GitHub's usage limits apply.

### Node is a build tool only

npm and the Angular CLI build the interface on the developer's machine or in CI, using the version in [.node-version](.node-version). The installed app, the web launcher and the CLI contain no Node runtime: the Rust crate `nexo-engine` runs requests, scripts (QuickJS with memory and time limits and no host access), WebSocket, Socket.IO, MQTT, gRPC, mocks, datasets, OAuth/MCP calls and the encrypted vault. Vaults created by earlier versions remain readable.

### Local web version

When a company computer does not allow installing the desktop app, run `.\install-web.ps1` or `bash install-web.sh`, or start the launcher directly:

```bash
npm run build
npm run backend:build
target/release/nexo-server --web dist/nexo/browser
```

The launcher listens only on `127.0.0.1` and prints a sign-in link valid once for two minutes. Running it again while it is active opens a new session in the existing instance. It is not a multi-user server: do not expose it through a proxy.

### CLI

```bash
npm run nexo -- run collection.json --environment environment.json --iterations 5 --data rows.json --report result.json --junit result.xml
npm run nexo -- request request.json
npm run nexo -- import specification.yaml --report collection.json
```

The CLI runs the same Rust engine in its own process and returns an error exit code when a run or assertion fails.

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
