# Microsoft Store listing · Ficha de Microsoft Store

Texts to paste into Partner Center → Store listings (one listing per language), plus the submission notes. Screenshots: `store/screenshots/` (1920×1080, PNG).

---

## English (en-us)

### Description

Nexo API is a fast, open source workspace for building, organizing and testing APIs, built to run entirely on your computer.

Send HTTP and GraphQL requests, organize them in collections and folders, switch between environments and keep your secrets encrypted on your device. Write pre-request and test scripts, run whole collections with data files and check every assertion. Connect to WebSocket, Socket.IO, MQTT, Kafka and gRPC services, browse and edit MongoDB databases, spin up local mock servers and query JSON or CSV datasets with SQL.

Nexo API has no accounts, no cloud sync and no telemetry: your collections, environments and history never leave your computer. Requests go only where you send them.

It is built with Rust and Tauri, so it starts quickly and uses little memory, and it is free and open source under the MIT license.

### Product features (one per line)

- HTTP, HTTPS and GraphQL requests with params, headers, bodies and authentication
- Collections and folders with inherited variables, authentication and scripts
- Environments, global and collection variables with a live preview of every value
- Encrypted vault for secrets, referenced as {{vault:name}} and redacted from results
- Pre-request and test scripts in a sandbox, with assertions and logs
- Collection runner with iterations and JSON/CSV data
- WebSocket, Socket.IO, MQTT, Kafka and gRPC clients
- MongoDB explorer: queries, table, tree and JSON views, and writes with undo
- Local mock servers and SQL queries over JSON/CSV datasets
- Import cURL, OpenAPI/Swagger, HAR and portable collections; generate code in 8 languages
- Works offline, without an account; English and Spanish; three visual themes

### What's new in this version

MongoDB next to your API, Kafka, and editors with autocompletion.

- MongoDB: connections with the password in the vault (TLS, X.509, replica sets, Atlas, import from Compass), an explorer of databases and collections, queries in the shell syntax with table, tree and JSON views, and writes that keep BSON types, count before changing many documents, respect read-only connections and can be undone.
- Kafka client, Socket.IO, gRPC server reflection, and a GraphQL schema explorer with autocompletion and subscriptions over SSE.
- Code editors with highlighting and autocompletion of the pm and nx script APIs.
- Files in form-data and binary bodies; each request tab keeps its own response.
- Cookie manager, Git remotes (clone, pull, push), MCP resources and prompts, PDF reports, OpenAPI linting and comparison, pause and resume of runs, and drag and drop in the collection tree.
- Many fixes and security improvements.

### Search terms

- API client
- REST client
- HTTP requests
- GraphQL
- API testing
- gRPC
- WebSocket

### Screenshot captions

1. `en-1-request.png` — Send requests with environment variables and inspect formatted responses.
2. `en-2-light-theme.png` — A light layout with the request and the response side by side.
3. `en-3-runner.png` — Run a whole collection and check every assertion.
4. `en-4-environments.png` — Environments and variables, with secrets kept in an encrypted vault.

### Copyright and trademark info

© 2026 DaftyCode. Released under the MIT license.

---

## Español (es-es)

### Descripción

Nexo API es un espacio de trabajo rápido y de código abierto para crear, organizar y probar APIs, pensado para funcionar por completo en tu equipo.

Envía peticiones HTTP y GraphQL, organízalas en colecciones y carpetas, cambia de entorno con un clic y guarda tus secretos cifrados en tu dispositivo. Escribe scripts previos y de pruebas, ejecuta colecciones completas con archivos de datos y comprueba cada aserción. Conéctate a servicios WebSocket, Socket.IO, MQTT, Kafka y gRPC, explora y edita bases de datos MongoDB, arranca servidores mock locales y consulta datasets JSON o CSV con SQL.

Nexo API no tiene cuentas, ni sincronización en la nube, ni telemetría: tus colecciones, entornos e historial nunca salen de tu equipo. Las peticiones solo van adonde tú las envías.

Está hecho con Rust y Tauri, así que arranca rápido y consume poca memoria, y es gratuito y de código abierto con licencia MIT.

### Características del producto (una por línea)

- Peticiones HTTP, HTTPS y GraphQL con parámetros, cabeceras, cuerpos y autenticación
- Colecciones y carpetas que heredan variables, autenticación y scripts
- Entornos, variables globales y de colección con vista previa de cada valor
- Vault cifrado para secretos, usados como {{vault:nombre}} y ocultos en los resultados
- Scripts previos y de pruebas en un entorno aislado, con aserciones y registros
- Runner de colecciones con iteraciones y datos JSON/CSV
- Clientes de WebSocket, Socket.IO, MQTT, Kafka y gRPC
- Explorador de MongoDB: consultas, vistas de tabla, árbol y JSON, y escritura con deshacer
- Servidores mock locales y consultas SQL sobre datasets JSON/CSV
- Importa cURL, OpenAPI/Swagger, HAR y colecciones portables; genera código en 8 lenguajes
- Funciona sin conexión y sin cuenta; en español e inglés; tres temas visuales

### Novedades de esta versión

MongoDB junto a tu API, Kafka y editores con autocompletado.

- MongoDB: conexiones con la contraseña en el vault (TLS, X.509, replica sets, Atlas, importar de Compass), explorador de bases de datos y colecciones, consultas con la sintaxis de la shell y vistas de tabla, árbol y JSON, y escritura que conserva los tipos BSON, cuenta antes de cambiar muchos documentos, respeta las conexiones de solo lectura y se puede deshacer.
- Cliente de Kafka, Socket.IO, reflexión de servidores gRPC y explorador del esquema GraphQL con autocompletado y subscriptions por SSE.
- Editores de código con resaltado y autocompletado de las API de scripts pm y nx.
- Ficheros en cuerpos form-data y binarios; cada pestaña de petición conserva su respuesta.
- Gestor de cookies, remotos Git (clonar, pull, push), recursos y prompts MCP, informes en PDF, linter y comparación de OpenAPI, pausar y reanudar ejecuciones, y arrastrar y soltar en el árbol de colecciones.
- Muchas correcciones y mejoras de seguridad.

### Términos de búsqueda

- cliente API
- cliente REST
- peticiones HTTP
- GraphQL
- pruebas de API
- gRPC
- WebSocket

### Pies de las capturas

1. `es-1-request.png` — Envía peticiones con variables de entorno y revisa respuestas formateadas.
2. `es-2-light-theme.png` — Una vista clara con la petición y la respuesta lado a lado.
3. `es-3-runner.png` — Ejecuta una colección completa y comprueba cada aserción.
4. `es-4-environments.png` — Entornos y variables, con los secretos en un vault cifrado.

### Copyright y marcas

© 2026 DaftyCode. Publicado con licencia MIT.

---

## Submission options → Restricted capabilities (runFullTrust)

> Nexo API is a Win32 desktop application built with Tauri and packaged as MSIX. It requires runFullTrust to start its own local HTTP service on the loopback interface (127.0.0.1) and to host its interface in WebView2. The service only accepts connections from this computer and requires a per-session token. The app does not install drivers or services, and does not modify system settings.

## Notes for certification (Información adicional sobre pruebas)

> No account or sign-in is required. To test: open the app, click "New", enter https://httpbin.org/get as the URL and click "Send"; the response appears below. Collections, environments and history are stored locally in the app data folder. The app needs internet access only for the requests the user sends.

## Age rating questionnaire (IARC) — guidance

The app is a developer tool. Answer "No" to violence, sexual content, gambling, drugs and purchases. It does not let users communicate with each other or share content, and it does not collect location or personal data. Expected rating: everyone / PEGI 3.
