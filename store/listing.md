# Microsoft Store listing · Ficha de Microsoft Store

Texts to paste into Partner Center → Store listings (one listing per language), plus the submission notes. Screenshots: `store/screenshots/` (1920×1080, PNG).

---

## English (en-us)

### Description

Nexo API is a fast, open source workspace for building, organizing and testing APIs, built to run entirely on your computer.

Send HTTP and GraphQL requests, organize them in collections and folders, switch between environments and keep your secrets encrypted on your device. Write pre-request and test scripts, run whole collections with data files and check every assertion. Connect to WebSocket, Socket.IO, MQTT, Kafka and gRPC services, browse and edit MongoDB databases, work with PostgreSQL and SQL Server in a SQL editor, spin up local mock servers and query JSON or CSV datasets with SQL.

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
- MongoDB: explorer, aggregations, schema, indexes, shell, SQL, import/export and compare
- PostgreSQL and SQL Server: navigator, SQL editor, data grid and object sheets
- Local mock servers and SQL queries over JSON/CSV datasets
- Import cURL, OpenAPI/Swagger, HAR and portable collections; generate code in 8 languages
- Works offline, without an account; English and Spanish; three visual themes

### What's new in this version

Databases next to your APIs: PostgreSQL and SQL Server.

- A Databases section with a navigator of databases, schemas, tables, views, functions and more, with filters, bookmarks and folders.
- Each database engine is a module that Nexo downloads and checks only when you add its first connection.
- Connections from a pasted URL (JDBC too), with TLS, connection types (production in red), read-only connections and a connection test.
- A SQL editor that keeps a result tab per query, with saved scripts, history, transactions and cancelling.
- A fast data grid for large results: find, record view, copy as JSON, CSV, Markdown or INSERT, and value, calculation and grouping panels.
- Object sheets with properties, DDL and data filtered and sorted on the server, following foreign keys both ways.
- Confirmations before changing every row, dropping objects or writing to production.
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

Envía peticiones HTTP y GraphQL, organízalas en colecciones y carpetas, cambia de entorno con un clic y guarda tus secretos cifrados en tu dispositivo. Escribe scripts previos y de pruebas, ejecuta colecciones completas con archivos de datos y comprueba cada aserción. Conéctate a servicios WebSocket, Socket.IO, MQTT, Kafka y gRPC, explora y edita bases de datos MongoDB, trabaja con PostgreSQL y SQL Server en un editor SQL, arranca servidores mock locales y consulta datasets JSON o CSV con SQL.

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
- MongoDB: explorador, agregaciones, esquema, índices, shell, SQL, importar/exportar y comparar
- PostgreSQL y SQL Server: navegador, editor SQL, rejilla de datos y fichas de objeto
- Servidores mock locales y consultas SQL sobre datasets JSON/CSV
- Importa cURL, OpenAPI/Swagger, HAR y colecciones portables; genera código en 8 lenguajes
- Funciona sin conexión y sin cuenta; en español e inglés; tres temas visuales

### Novedades de esta versión

Bases de datos junto a tus APIs: PostgreSQL y SQL Server.

- Una sección Bases de datos con un navegador de bases, esquemas, tablas, vistas, funciones y más, con filtros, marcadores y carpetas.
- Cada motor de base de datos es un módulo que Nexo descarga y comprueba solo cuando das de alta su primera conexión.
- Conexiones desde una URL pegada (también JDBC), con TLS, tipos de conexión (producción en rojo), conexiones de solo lectura y prueba de conexión.
- Un editor SQL que conserva una pestaña de resultado por consulta, con scripts guardados, historial, transacciones y cancelación.
- Una rejilla de datos rápida para resultados grandes: buscar, modo registro, copiar como JSON, CSV, Markdown o INSERT, y paneles de valor, cálculo y agrupación.
- Fichas de objeto con propiedades, DDL y datos filtrados y ordenados en el servidor, siguiendo las claves foráneas en los dos sentidos.
- Confirmaciones antes de cambiar todas las filas, borrar objetos o escribir en producción.
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

> Nexo API is a Win32 desktop application built with Tauri and packaged as MSIX. It requires runFullTrust to start its own local HTTP service on the loopback interface (127.0.0.1) and to host its interface in WebView2. The service only accepts connections from this computer and requires a per-session token. Optional database modules (for PostgreSQL and SQL Server) are downloaded only when the user adds a connection of that type, from the app's own GitHub release, checked against the SHA-256 listed inside the app, and run as child processes of the app. The app does not install system drivers or services, and does not modify system settings.

## Notes for certification (Información adicional sobre pruebas)

> No account or sign-in is required. To test: open the app, click "New", enter https://httpbin.org/get as the URL and click "Send"; the response appears below. Collections, environments and history are stored locally in the app data folder. The app needs internet access only for the requests the user sends.

## Age rating questionnaire (IARC) — guidance

The app is a developer tool. Answer "No" to violence, sexual content, gambling, drugs and purchases. It does not let users communicate with each other or share content, and it does not collect location or personal data. Expected rating: everyone / PEGI 3.
