# Microsoft Store listing · Ficha de Microsoft Store

Texts to paste into Partner Center → Store listings (one listing per language), plus the submission notes. Screenshots: `store/screenshots/` (1920×1080, PNG).

---

## English (en-us)

### Description

Nexo API is a fast, open source workspace for building, organizing and testing APIs, built to run entirely on your computer.

Send HTTP and GraphQL requests, organize them in collections and folders, switch between environments and keep your secrets encrypted on your device. Write pre-request and test scripts, run whole collections with data files and check every assertion. Connect to WebSocket, Socket.IO, MQTT, Kafka and gRPC services, browse and edit MongoDB databases, work with PostgreSQL, SQL Server, MySQL, MariaDB and SQLite in a SQL editor, spin up local mock servers and query JSON or CSV datasets with SQL.

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
- Reach servers through HTTP and SOCKS5 proxies or SSH tunnels with reusable profiles
- MongoDB: explorer, aggregations, schema, indexes, shell, SQL, import/export and compare
- PostgreSQL, SQL Server, MySQL, MariaDB and SQLite: navigator, SQL editor, data grid, structure editor, data transfer, ER diagrams, session and lock managers and server dashboards
- Local mock servers and SQL queries over JSON/CSV datasets
- Import cURL, OpenAPI/Swagger, HAR and portable collections; generate code in 8 languages
- Works offline, without an account; English and Spanish; four visual themes

### What's new in this version

Reach the servers that only a bastion or a proxy sees, in a new light look.

- Connect through an HTTP proxy, a SOCKS5 proxy (also letting the proxy resolve names) or an SSH tunnel, in requests, collections and folders, WebSocket, Socket.IO, MQTT, Kafka, gRPC, GraphQL subscriptions and MongoDB connections.
- Reusable SSH profiles in Settings → SSH, with the password or private key kept in the vault. Test signs in once and shows the server's key to trust; a key that changes later blocks the connection.
- Collections and folders choose how their requests connect, and requests and folders inherit it, like authorization.
- The egress policy checks both the proxy or SSH server and the final destination.
- A light Aurora is the new default template; the dark one stays as Aurora full color, and the app opens with the last template you chose.
- The documentation has an index, a short guide to every part and the colours of your template.
- What Nexo keeps by itself has a cap: logs, cookies, history, runs and revisions never fill the disk.
- Every text of the interface is translated, settings and database dashboards included.

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

Envía peticiones HTTP y GraphQL, organízalas en colecciones y carpetas, cambia de entorno con un clic y guarda tus secretos cifrados en tu dispositivo. Escribe scripts previos y de pruebas, ejecuta colecciones completas con archivos de datos y comprueba cada aserción. Conéctate a servicios WebSocket, Socket.IO, MQTT, Kafka y gRPC, explora y edita bases de datos MongoDB, trabaja con PostgreSQL, SQL Server, MySQL, MariaDB y SQLite en un editor SQL, arranca servidores mock locales y consulta datasets JSON o CSV con SQL.

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
- Llega a los servidores por proxies HTTP y SOCKS5 o túneles SSH con perfiles reutilizables
- MongoDB: explorador, agregaciones, esquema, índices, shell, SQL, importar/exportar y comparar
- PostgreSQL, SQL Server, MySQL, MariaDB y SQLite: navegador, editor SQL, rejilla de datos, editor de estructura, transferencia de datos, diagramas ER, gestores de sesiones y bloqueos y paneles del servidor
- Servidores mock locales y consultas SQL sobre datasets JSON/CSV
- Importa cURL, OpenAPI/Swagger, HAR y colecciones portables; genera código en 8 lenguajes
- Funciona sin conexión y sin cuenta; en español e inglés; cuatro temas visuales

### Novedades de esta versión

Llega a los servidores que solo ve un bastión o un proxy, con un nuevo aspecto claro.

- Conecta a través de un proxy HTTP, un proxy SOCKS5 (también dejando que el proxy resuelva los nombres) o un túnel SSH, en peticiones, colecciones y carpetas, WebSocket, Socket.IO, MQTT, Kafka, gRPC, subscriptions GraphQL y conexiones MongoDB.
- Perfiles SSH reutilizables en Ajustes → SSH, con la contraseña o la clave privada en el vault. Probar inicia sesión una vez y enseña la clave del servidor para confiar en ella; una clave que cambie después bloquea la conexión.
- Las colecciones y carpetas eligen cómo conectan sus peticiones, y las peticiones y carpetas lo heredan, como la autorización.
- La política de salida comprueba el proxy o el servidor SSH y también el destino final.
- Un Aurora claro es la nueva plantilla por defecto; la oscura sigue como Aurora full color, y la app se abre con la última plantilla que elegiste.
- La documentación tiene índice, una guía breve de cada parte y los colores de tu plantilla.
- Lo que Nexo guarda por su cuenta tiene tope: logs, cookies, historial, ejecuciones y revisiones nunca llenan el disco.
- Todos los textos de la interfaz están traducidos, también los ajustes y los paneles de bases de datos.

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

> Nexo API is a Win32 desktop application built with Tauri and packaged as MSIX. It requires runFullTrust to start its own local HTTP service on the loopback interface (127.0.0.1) and to host its interface in WebView2. The service only accepts connections from this computer and requires a per-session token. Optional database modules (for PostgreSQL, SQL Server, MySQL and MariaDB, and SQLite) are downloaded only when the user adds a connection of that type, from the app's own GitHub release, checked against the SHA-256 listed inside the app, and run as child processes of the app. The app does not install system drivers or services, and does not modify system settings.

## Notes for certification (Información adicional sobre pruebas)

> No account or sign-in is required. To test: open the app, click "New", enter https://httpbin.org/get as the URL and click "Send"; the response appears below. Collections, environments and history are stored locally in the app data folder. The app needs internet access only for the requests the user sends.

## Age rating questionnaire (IARC) — guidance

The app is a developer tool. Answer "No" to violence, sexual content, gambling, drugs and purchases. It does not let users communicate with each other or share content, and it does not collect location or personal data. Expected rating: everyone / PEGI 3.
