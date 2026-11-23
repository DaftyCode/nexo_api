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

| Area                | Available features                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests            | HTTP/HTTPS, methods, query and path parameters, headers and responses; raw, JSON and form bodies, multipart and binary file uploads, and GraphQL with an explorer and autocompletion.                                                                                                                                                                                                                                              |
| Organization        | Collections and folders, tabs, environments (with a colour and a protection: ask before sending changes, or read-only, which the engine also applies to scripts, runs and the CLI), variables, history and documents persisted in SQLite. Drag tabs, collections, folders, requests (also into another collection) and the sections of the menu; on start, everything keeps your order and tabs reopen with their unsaved changes. |
| Shared collections  | A collection kept in one `.nexo-collection` file in a folder Google Drive, OneDrive or Dropbox for desktop sync, on a network drive or on a WebDAV server (Nextcloud, ownCloud, a NAS…), so that what one person saves is there for the whole team: Share with the team… from its menu (sealed with AES-256-GCM and a team key that goes to each vault, never in the file; the environments you choose go with it, without their secret values), or Import → From a shared location. Every save reaches the file; every few seconds Nexo looks at its size and time on the disk, without a call to the cloud, and a teammate's change shows on its own with each open tab still on its request; a server is asked only when the workspace opens and on Reload, with nothing sent when nothing changed, and a save never writes over a teammate's (`If-Match`). Changes are joined request by request, and when both changed the same one Nexo keeps theirs and asks which to keep. Credentials are masked as in a Git export and stay yours. |
| HTTP authentication | Every type of Postman, Bruno and Insomnia: Basic, Bearer, API key, Digest, OAuth 1.0, OAuth 2.0 (all grants, PKCE, sign-in window in the desktop app like Postman's, tokens in the vault, auto-refresh and auto-fetch), AWS Signature v4, Hawk, NTLM, JWT Bearer, Atlassian ASAP, Akamai EdgeGrid, WSSE and Netrc; inherited from folders and collections.                                                                         |
| Scripts and tests   | Pre-request and response scripts, scoped variables, `nx.test`, `nx.expect`, `nx.sendRequest`, `nx.mongo` and `nx.sql` (a saved database connection, its parameters always bound), logs and assertion results. JSON Schema read from a response and the history of its request (required fields, formats, short enums), added as a test that checks every run with `pm.response.to.have.jsonSchema`.                                |
| Runner              | Collection iterations with JSON/CSV data, inherited scripts, progress, pause, cancellation, PDF reports and JSON/JUnit reports from the CLI.                                                                                                                                                                                                                                                                                       |
| Monitors            | A collection or one of its folders run on a schedule while Nexo is open (every few minutes or hours, or a cron expression), with an environment and data, its last 100 runs and a system notification when one fails.                                                                                                                                                                                                              |
| Compare responses   | Two responses side by side, from tabs, the history or a collection run, or one request sent with two environments: what changed in the status, the headers and the body, field by field for JSON whatever the order of its fields, leaving out the fields and headers you name (dates, generated ids).                                                                                                                             |
| Export and masking  | A finished run (one row per request and iteration) or a JSON response with an array of objects as an Excel workbook or a CSV file; database tables and MongoDB collections also to Excel. Masking sets hide, truncate, hash, make up or remove the fields you name before any of these exports, and in what MCP agents read; hashes and made-up values use a key of the workspace kept in the vault, so masked data still joins.   |
| Protocols           | WebSocket, Socket.IO, MQTT, Kafka, gRPC (with a proto or through reflection) and GraphQL subscriptions over WebSocket or SSE.                                                                                                                                                                                                                                                                                                      |
| Proxies and tunnels | «Connect through» in requests, collections and folders (inherited), protocols and MongoDB connections: directly, an HTTP proxy, a SOCKS5 proxy (also with names resolved by the proxy) or the SSH tunnel of a reusable profile, with the server's key checked and its secrets in the vault; proxies can be kept as profiles too.                                                                                                   |
| MongoDB             | A downloadable module of the «Databases» section, its connections in the same tree: connections, explorer, queries, document editing with safeguards, indexes, explain, profiler, stage-by-stage aggregations, schema, JSON/CSV import and export to JSON, CSV or Excel, change streams, shell, code generation, SQL and compare/sync.                                                                                             |
| Databases           | PostgreSQL, SQL Server, MySQL, MariaDB, SQLite, and files (CSV, JSON, Parquet, Excel) and DuckDB in a DBeaver-style section: SQL editor, editable data grid, object sheets and structure, entity-relationship diagrams, sessions, locks and server dashboards. Each engine is a module downloaded when its first connection is created. Details in [Databases](#databases).                                                        |
| Import              | Portable JSON collections, environments, OpenAPI/Swagger JSON or YAML, HAR and cURL; and what Insomnia (v4 and the v5 YAML of Insomnia 11), Bruno (its JSON export or the collection folder), Hoppscotch and Thunder Client export, with folders, authorization, variables and environments. Their scripts arrive commented out, and a report says what did not come as it was.                                                    |
| Code                | Original generators for cURL, JavaScript/Node, Python, Java, Go, Rust, C# and PowerShell.                                                                                                                                                                                                                                                                                                                                          |
| Tools               | Local HTTP mocks, JSON/CSV datasets with read-only SQL queries, cookie manager, API definitions with a linter, Git with remotes and MCP client/server support.                                                                                                                                                                                                                                                                     |
| AI assistant        | Off until you turn it on in Settings. First, a model run inside Nexo: one button downloads llama.cpp for your GPU (CUDA, Vulkan or Metal) and the Qwen3.5 model that fits your free memory (9B or 4B), checked against the SHA-256 Nexo carries, with nothing to install or configure and nothing leaving the computer; it starts when you ask, stops when unused and closes with Nexo even when Nexo ends suddenly, takes the GPU memory free when it loads, and a GGUF file of your own can replace it. Or your own key for Anthropic (Claude), OpenAI (ChatGPT), Google (Gemini) or any server compatible with OpenAI's API (Mistral, DeepSeek, Groq, OpenRouter, your own), with your own key kept in the vault and its models listed by the provider. A chat opened by its own button, beside Text and Visual in a SQL tab, and over MongoDB collections and requests, made wider or narrower by dragging its edge: while the model reasons you see Thinking… and its reasoning as it is written (the local model, compatible servers, Claude from 4.6 and Gemini from 2.5; OpenAI does not give it), folded into “Thought for N s” once it answers; it reads what you have open with read-only tools (the request and its last response, the requests of its collection, and the tables, queries and collections of the connection you work with beside the chat, which it reads first, and of those MCP agents may read, listed when the open one is not the one meant, with the columns you hide from agents and the assistant as `[hidden]`, masked as for MCP agents, response bodies optional), each read shown as a step; another provider or model is chosen from the chat itself; each place offers its questions (explain the response, write tests, explain a query or its plan, fix an error, document a collection), and its code has buttons to add tests to the request, open or run a SQL query in a new tab, or use or run a MongoDB filter or pipeline; the answer streams and can be stopped, conversations are kept in the workspace, values of the vault are redacted before anything leaves, and the call goes straight to the provider, also through a proxy profile. |
| Secrets             | AES-GCM encrypted vault, `{{vault:name}}` references, allowed domains per secret and secret redaction in results.                                                                                                                                                                                                                                                                                                                  |
| Workspaces          | Several local workspaces, the one used last opened again, document history and revisions that prevent lost updates.                                                                                                                                                                                                                                                                                                                |
| Desktop and web     | Tauri desktop app, or the same interface in your browser through a local launcher when you cannot install the app.                                                                                                                                                                                                                                                                                                                 |

Requests leave from your computer. Set `NEXO_EGRESS=deny-private` to refuse private and loopback destinations, except your own mocks; `NEXO_EGRESS_ALLOW` lists exceptions. Through a proxy or an SSH tunnel, both the proxy or SSH server and the final destination are checked.

### Databases

- **Modules on demand:** Nexo installs as an API client. Each engine's driver is downloaded from GitHub Releases when the first connection of that type is created, checked against the SHA-256 the app carries and run as a separate process. The engine gallery shows each driver's icon, what it is, whether it is one of the most used and whether it is already installed.
- **Connections and navigator:** a wizard with a pasted URL (JDBC too), TLS, driver settings and connection type (production in red), and «Test connection». A connection goes directly, through a SOCKS5 proxy (written in, or a saved proxy profile) or through the SSH tunnel of a profile, opened by Nexo for the driver, with «Test the tunnel». Connections come from DBeaver, pgAdmin, MySQL Workbench, a list of URLs or Nexo's own export, without their passwords. Its sessions run startup queries and open on a default schema, are kept alive, close sooner when unused and open again on their next use (rerunning only what reads). A connection can ask for its password each time instead of keeping it, or read it from PostgreSQL's `pgpass` file. Besides development, test and production, your own connection types (Settings) say what their sessions do: commit by hand, confirm each change or only changes of structure, only read, a time limit. A keyboard-driven navigator with icons and counts, filters, a simple view, bookmarks and folders: a click expands a row and a double click opens the table on its data. Ctrl+H searches objects, data and saved scripts. A table fills with test data of the same seed every time, its keys and unique columns kept. Results are charted (lines, areas, bars, stacked bars, pies, dots) without setting anything, with a table of the same numbers, and the chart is kept with the script. Geometries show as WKT and on a canvas of their own, without a background map, and export as GeoJSON. A folder of CSV, JSON, Parquet and Excel files, or a DuckDB database, is queried and joined with SQL (the Files and DuckDB module), only read. Cassandra and ScyllaDB clusters are queried with CQL in the same editor: several contact points, every node discovered checked by the egress policy, keyspaces with their tables, views, types, functions, indexes and roles, partition and clustering keys marked, `CONSISTENCY` and `TRACING ON` as in cqlsh, and a question before `ALLOW FILTERING`. Redis and Valkey (one server, Sentinel or a cluster) open each database on its keys: read by pages of `SCAN`, never `KEYS`, grouped by `:` and filtered by pattern and type, each one with its expiry, size and the editor of its type (strings, JSON, lists, sets, sorted sets, hashes and streams; a binary value keeps its bytes), a console with the history and syntax of each command (`FLUSHDB` and the other dangerous ones run only with their name typed), the server's information, clients and slow commands, and channels followed in the realtime panel. Elasticsearch and OpenSearch show their indices with their fields, data streams, aliases, templates and nodes, run SQL through the engine's SQL API (the Data tab of an index too), and have a console of Query DSL as Kibana's: requests by method and path with their JSON body, the one at the cursor with Ctrl+Enter, the hits of a search as a table, history and cURL without the secret; deleting an index asks for its name typed, and no request leaves the node. Apache Hive connects to HiveServer2 in HTTP mode with a user and a password, from its pasted JDBC URL: databases, tables, views and columns, DDL and details, rows by pages of the server cursor, and cancelling. Apache Ignite 3 connects by its client protocol, with TLS and its authentication, from its pasted JDBC URL: schemas, tables with their distribution zone, system views and columns, keys, indexes and a DDL rebuilt from the system views, rows by pages of the server cursor, Ignite's own transactions, and its running queries listed and cancelled. MongoDB connections are in the same tree, with their databases and collections: a collection opens in the explorer of its connection (documents in the same virtualized data grid, where a double click opens an embedded document into columns or enters an array; aggregations, SQL, schema, indexes, explain, profiler and its shell), and a connection saved before MongoDB was a module opens once the module is downloaded. Apache Drill shows its storage plugins (without their credentials), schemas, tables, views and files, and runs SQL on files, Parquet included, through its REST API.
- **SQL editor:** each tab on its own session, as text or on the canvas of the visual query builder (tables, joins by their keys, columns, conditions, grouping, order and page, the SQL written again with every change); the statement at the cursor, a selection or the script with DBeaver's keys, and confirmations before sending. It completes from the schema (an alias's columns, the join of a foreign key), formats, has templates, asks for `:name` parameters and sends them bound, generates a table's SQL and has a SQL console. «Code» writes a whole program that runs the statement in Node.js, Python, Java, C#, Go, Rust, PHP or Ruby with the usual library of its engine, or with its command line, its parameters bound and the connection read from `DATABASE_URL`; also the statement alone as a string of a language, and back. A result tab per query (pin, run again, detach, read more, repeat; one per result of a procedure), messages with the line of an error, estimated or measured execution plans, saved scripts and history.
- **Manual transactions:** they count their statements, keep their log and are listed, with smart commit and a question before closing a tab with changes.
- **Data grid:** virtualized (100 000 rows and 200 columns), with striped rows, column and row menus, a status bar and rows read while scrolling. Keyboard, find, record view, copy as TSV, JSON, CSV, Markdown, `IN` or `INSERT`, Value, Metadata, Calc and Grouping panels, and formats in Settings. Rows are edited with their pending changes until they are all saved together.
- **Moving data:** export to eight formats, import CSV and JSON, and copy data between connections of different engines. In the desktop app, back up and restore PostgreSQL, MySQL and MariaDB databases, or run a large `.sql` script, with the engine's own client tools (`pg_dump`, `pg_restore`, `psql`, `mysqldump`, `mysql`), the password kept off the command line.
- **Objects and structure:** an object's sheet with its figures and views, properties in cards, sections, DDL and data filtered and ordered on the server, with foreign keys followed both ways. Tables are created and changed with forms or in their Columns view, with every type of the engine and its DDL shown before it runs. Views, routines and other objects start from a template of their engine.
- **Comparing and syncing:** two schemas, databases, SQLite files or tables, of the same connection or another, also of another engine (types then compared by what they hold and marked equivalent): tables part by part with both DDLs side by side, and the script that makes the target like the source, opened in a SQL tab. The rows of two tables paired by their key, with counts and the first 1000 differences, synchronized in one transaction once the target table's name is typed, or written as an `INSERT`, `UPDATE` and `DELETE` script.
- **From scripts and agents:** request scripts query and change a saved connection with `nx.sql('Shop').query(sql, params)`, `execute` and `transaction`, with the rules of the SQL editor and a session of their own; MCP agents read the connections you let them read (tables, descriptions, queries that only read, plans), without the columns you hide from them.
- **Tasks:** SQL scripts on several connections, a copy of a query into a table of another connection, a comparison of two schemas or tables, a backup with the local client tools, a query written to a CSV, JSON or JSON Lines file, a file written into a table, a saved MongoDB transfer or comparison, or other tasks in order, saved with their folder and run by hand, every few minutes or hours or on a cron expression while Nexo is open, never two runs at once. Each one keeps its last 100 runs, and a failure or a difference found is notified. Nobody confirms a scheduled run: changes in production, statements on every row or a `DROP` run only if the task authorizes them, shown with a warning.
- **Entity-relationship diagrams:** a table with its neighbours or every table of a schema, in IDEF1X, crow's foot or UML. They move with the mouse or the keyboard, are saved as your own diagrams with notes and export to SVG, PNG or PDF.
- **Administration:** session and lock managers (who is connected and who waits for whom; cancel a query or end a session after asking), users and roles with their memberships and privileges, and a dashboard per server that draws sessions, transactions, reads, size and locks every few seconds, with your own panels from read-only queries.
- **Working session:** tabs come back when reopened, without results. Closing, reloading or leaving the page closes the connections it opened, and the desktop app closes them on exit.

### Workspace layouts

The source includes four templates, selectable from **Template**: **Aurora** (the default: a white background, dark text and light code editors), **Aurora full color** (the same layout in night blue and violet), **Studio** (three columns with environment and request context), and **Canvas** (a light workspace with request and response side by side). They share the same collections, environments, variables, history and tools; both Aurora templates also share their panel sizes. Switching templates keeps the active request, turns the code editors light or dark at once and saves your preference on that device: the app always opens with the last template chosen. The home page and the documentation (with an index and a short guide to every part) also take the colours of the chosen template. Canvas exposes the workspace navigation through **Tools** and **Browse collections**. Classic has been retired. Every HTTP method has its own colour in all layouts (GET green, POST yellow, PUT blue, PATCH purple, DELETE red); colours and sizes can be changed through [CSS variables](#styles-design-tokens).

### Interface languages

The source includes **English and Spanish**, with a language selector on the website, documentation and workspace. Transloco updates labels, menus, forms, accessibility text and known application messages immediately, without reloading. The preference is saved on that device; English is the default and fallback language. Layout and language preferences are independent. Request payloads, responses, scripts, variable values and names you give your resources remain unchanged.

Translations live in `src/app/infrastructure/i18n/en.json` and `es.json`. Simple message IDs use their English source text; interpolated messages use named keys. Add matching entries in both catalogs and run `npm run i18n:check` to check coverage and interpolation parameters. The check fails when a template shows text that does not go through translation; what reads the same in every language (a protocol, a format, code or an example) is declared in `tools/i18n-same-text.json`. New languages also need registration in the language catalog, providers and selector. Server/engine diagnostics without a translation retain their original text.

## Download and install

Versions are published on [GitHub Releases](https://github.com/DaftyCode/nexo_api/releases). Check each release's assets: a platform configured in CI does not automatically mean an installer has been published for it.

| Operating system | Architecture                              | Packages configured in CI                           |
| ---------------- | ----------------------------------------- | --------------------------------------------------- |
| Windows          | x64                                       | NSIS `.exe` installer and Windows Installer `.msi`. |
| macOS            | Apple Silicon and Intel, built separately | `.app` application inside a `.dmg`.                 |
| Linux            | x64                                       | `.deb`, `.rpm` and `.AppImage`.                     |

Each build runs on a runner for its operating system. Installers are self-contained: end users do not need to install Node or Rust. Each release also publishes the database drivers, which the app downloads by itself when they are needed, and a `SHA256SUMS` file to check the downloads.

### Microsoft Store

[<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200" alt="Get it from Microsoft">](https://apps.microsoft.com/detail/9N6H77VSRDQ4?mode=direct)

Nexo API is in the Microsoft Store: the Store signs the package, installs it and keeps the app updated. On Windows, the button opens the listing directly in the Store app. To build the MSIX package locally, run `npm run desktop:msix` (it needs the Windows SDK).

## How it works

![Nexo architecture: Angular and Tauri connect to the Rust backend, which coordinates SQLite, the vault and the request and scripting engine.](public/architecture.svg)

Nexo runs for one person on one computer. The desktop application starts a Rust service on a random loopback port and authenticates with a per-run token. The web version uses the same service: its launcher listens only on loopback and opens the browser with a one-time link that becomes an HttpOnly session cookie. Requests need a loopback Host header, an allowed Origin and the Nexo client header, so other websites and computers cannot use the service. Data stays in the app data directory; secrets are encrypted with a key kept in the operating system's credential store.

Each database has its driver in a separate process. Its SHA-256 is checked when it is installed and again before every start. The driver receives passwords only on its standard input and asks the service for every network destination, so its connections also go through the egress policy.

## Architecture we want to preserve

### Backend: hexagonal architecture

```text
backend/crates/
  nexo-domain/          Domain entities, rules and errors
  nexo-application/     Use cases and ports
  nexo-infrastructure/  SQLite, Git and credential store adapters
  nexo-engine/          Execution adapter: HTTP, QuickJS scripts, protocols, mocks, datasets, vault
  nexo-modules/         Installs the database modules, starts each driver and talks to it
  nexo-driver-sdk/      What a driver and the app share: protocol, typed values and the driver runtime
  nexo-http/            HTTP adapter
  nexo-server/          Composition root and CLI
backend/drivers/       One executable per engine (PostgreSQL, SQL Server, MySQL and MariaDB, SQLite, files, Cassandra, Redis, Elasticsearch, Drill, Hive, Ignite, MongoDB), depending only on the SDK
src-tauri/             Desktop composition root
```

The domain has no knowledge of HTTP, databases or graphical interfaces. Use cases depend on contracts; adapters implement those contracts. Tauri and the server compose the same capabilities. Drivers are never dependencies of the app and are not part of its installers.

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

The current version is **0.10.0**, with HTTP and SOCKS5 proxies and SSH tunnels in requests, collections, protocols and MongoDB, PostgreSQL, SQL Server, MySQL, MariaDB, SQLite, files with DuckDB, Cassandra, ScyllaDB, Redis, Valkey, Elasticsearch, OpenSearch, Apache Drill, Apache Hive, Apache Ignite and MongoDB in the «Databases» section, every one a module downloaded the first time it is used (MongoDB too, since this version: its connections and queries stay as they were), and an AI assistant with your own key of Anthropic, OpenAI, Google or a server compatible with OpenAI's API. Tests cover real requests, variables, scripts, assertions, cancellation, cookies, secret redaction, OpenAPI imports, executable generated code, data-driven runs, every authorization type (with official vectors and verifying servers), unary and streaming gRPC with a proto or reflection, WebSocket, Socket.IO, MQTT, Kafka, GraphQL subscriptions, real MongoDB and FerretDB, real PostgreSQL, SQL Server, MySQL, MariaDB, Cassandra, Redis, Valkey, Elasticsearch, OpenSearch, Drill, Hive and Ignite servers and SQLite files, egress policy, local access control and revisions. Contract tests in `tests/contract` drive the real server binary. The interface's unit tests cover at least 90% of its statements, branches, functions and lines (`npm run test:coverage`, which CI runs): every change comes with its tests. It is built with Rust 1.100, Angular 22.2 and Tauri 2.12, with every dependency at the latest version they accept. The audit of the production dependencies in CI (`npm run audit:check`) accepts only the exceptions of `tools/audit-exceptions.json`, each with a reason and an expiry date: today one, picomatch, used only by the build tools and with no fixed release yet, until 2026-12-17.

Current limits include 5 seconds and 128 MB of memory per script evaluation, eight active runs and response size limits for the interface. Cookies are kept per workspace in the data directory. MQTT 5, Socket.IO 2.x (Engine.IO v3) and Kafka consumer groups, transactions and Schema Registry are not supported yet. External OpenAPI `$ref` references must be bundled before import. Unknown authorization types are rejected explicitly. Error messages from the engine and the drivers still arrive in English. Protocol and format support will grow alongside reproducible test cases.

What Nexo keeps by itself is capped, so it never fills the disk: the request history (200 entries and 20 MB per workspace, each response cut at 256 KB), the last 20 collection runs (20 MB) and the last 100 runs of each monitor, 500 SQL statements and 100 MongoDB queries, 25 revisions per document, 180 cookies per domain and 3000 per workspace, and the desktop log (`nexo.log` and the one before it, 10 MB at most). Database results and protocol messages are not kept: they are fetched again. The app's database gives the disk back the room of what is deleted.

### Next steps

In the planned order:

1. **More databases:** Oracle, which waits for a stable release of its Rust driver.
2. **Engine messages translated** (next): the errors and notices of the backend and the drivers, in every language, with codes and parameters; the interface is already fully translated.
3. **Development tooling without Node outside Angular:** contract tests and build scripts in Rust.
4. **Custom themes** from the app, built on the design tokens.
5. **Distribution:** WinGet, Homebrew, signed APT/YUM repositories and Flatpak. Signing the installers and drivers outside the Store on Windows, macOS notarization and validating the installers on clean machines.
6. **Reproducible benchmarks** of startup, memory and latency.

This section is updated with every change, always in both READMEs (`README.md` and `README.es.md`) at once:

- What is finished leaves «Next steps» and moves to [What you can do](#what-you-can-do) or to the current status.
- Every new task enters «Next steps», in its place in the planned order.
- What is dropped is removed from the list.

## Contributing

You can open an [issue](https://github.com/DaftyCode/nexo_api/issues), propose an improvement, fix a bug, expand tests or submit a pull request. You do not need permission to get started. For larger changes, an issue describing the problem and proposal helps coordinate the work.

2. Fork the repository and create a focused branch, such as `feat/http-history` or `fix/runner-cancel`.
3. Keep each change focused on one problem and respect layer boundaries and responsibilities.
4. Add behavior tests when changing rules or adapters. Include a reproduction test when fixing a bug.
5. Run the relevant checks and explain the problem, resulting behavior and validation in your PR.
6. If your change finishes or adds something, update [Current status and next steps](#current-status-and-next-steps) in both READMEs.
7. Preserve dependency notices and licenses. Keep local data, credentials and generated artifacts out of Git.

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
