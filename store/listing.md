# Microsoft Store listing · Ficha de Microsoft Store

Texts to paste into Partner Center → Store listings (one listing per language), plus the submission notes. Screenshots: `store/screenshots/` (1920×1080, PNG).

---

## English (en-us)

### Description

Nexo API is a fast, open source workspace for building, organizing and testing APIs, built to run entirely on your computer.

Send HTTP and GraphQL requests, organize them in collections and folders, switch between environments and keep your secrets encrypted on your device. Write pre-request and test scripts, run whole collections with data files and check every assertion. Connect to WebSocket, Socket.IO, MQTT and gRPC services, spin up local mock servers and query JSON or CSV datasets with SQL.

Nexo API has no accounts, no cloud sync and no telemetry: your collections, environments and history never leave your computer. Requests go only where you send them.

It is built with Rust and Tauri, so it starts quickly and uses little memory, and it is free and open source under the MIT license.

### Product features (one per line)

- HTTP, HTTPS and GraphQL requests with params, headers, bodies and authentication
- Collections and folders with inherited variables, authentication and scripts
- Environments, global and collection variables with a live preview of every value
- Encrypted vault for secrets, referenced as {{vault:name}} and redacted from results
- Pre-request and test scripts in a sandbox, with assertions and logs
- Collection runner with iterations and JSON/CSV data
- WebSocket, Socket.IO, MQTT and gRPC clients
- Local mock servers and SQL queries over JSON/CSV datasets
- Import cURL, OpenAPI/Swagger, HAR and portable collections; generate code in 8 languages
- Works offline, without an account; English and Spanish; three visual themes

### What's new in this version

Every authorization type, sign-in like Postman and a lighter app.

- All the authorizations of Postman, Bruno and Insomnia: OAuth 2.0 (every grant, PKCE, token management, automatic refresh and Auto-fetch Token), OAuth 1.0, Digest, AWS Signature v4, Hawk, NTLM, JWT Bearer, Atlassian ASAP, Akamai EdgeGrid, WSSE and Netrc.
- OAuth 2.0 sign-in in a window of the app, like Postman: it takes the token by itself, whatever the Callback URL.
- Allowed domains for each vault secret: it is only sent to the domains you choose, also after a redirect.
- The engine now runs in Rust inside the app, without Node: it starts faster, uses less memory and runs scripts in an isolated sandbox.
- Post-quantum key exchange (X25519MLKEM768) preferred for TLS connections.
- English and Spanish switch without restarting, and two new templates: Aurora Studio and Canvas.
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

Envía peticiones HTTP y GraphQL, organízalas en colecciones y carpetas, cambia de entorno con un clic y guarda tus secretos cifrados en tu dispositivo. Escribe scripts previos y de pruebas, ejecuta colecciones completas con archivos de datos y comprueba cada aserción. Conéctate a servicios WebSocket, Socket.IO, MQTT y gRPC, arranca servidores mock locales y consulta datasets JSON o CSV con SQL.

Nexo API no tiene cuentas, ni sincronización en la nube, ni telemetría: tus colecciones, entornos e historial nunca salen de tu equipo. Las peticiones solo van adonde tú las envías.

Está hecho con Rust y Tauri, así que arranca rápido y consume poca memoria, y es gratuito y de código abierto con licencia MIT.

### Características del producto (una por línea)

- Peticiones HTTP, HTTPS y GraphQL con parámetros, cabeceras, cuerpos y autenticación
- Colecciones y carpetas que heredan variables, autenticación y scripts
- Entornos, variables globales y de colección con vista previa de cada valor
- Vault cifrado para secretos, usados como {{vault:nombre}} y ocultos en los resultados
- Scripts previos y de pruebas en un entorno aislado, con aserciones y registros
- Runner de colecciones con iteraciones y datos JSON/CSV
- Clientes de WebSocket, Socket.IO, MQTT y gRPC
- Servidores mock locales y consultas SQL sobre datasets JSON/CSV
- Importa cURL, OpenAPI/Swagger, HAR y colecciones portables; genera código en 8 lenguajes
- Funciona sin conexión y sin cuenta; en español e inglés; tres temas visuales

### Novedades de esta versión

Todas las autorizaciones, inicio de sesión como en Postman y una aplicación más ligera.

- Todas las autorizaciones de Postman, Bruno e Insomnia: OAuth 2.0 (todos los flujos, PKCE, gestión de tokens, renovación automática y Auto-fetch Token), OAuth 1.0, Digest, AWS Signature v4, Hawk, NTLM, JWT Bearer, Atlassian ASAP, Akamai EdgeGrid, WSSE y Netrc.
- Inicio de sesión de OAuth 2.0 en una ventana de la aplicación, como en Postman: recoge el token sola, sea cual sea la Callback URL.
- Dominios permitidos para cada secreto del vault: solo se envía a los dominios que elijas, también tras una redirección.
- El motor funciona ahora en Rust dentro de la aplicación, sin Node: arranca antes, usa menos memoria y ejecuta los scripts en un sandbox aislado.
- Intercambio de claves poscuántico (X25519MLKEM768) preferido en las conexiones TLS.
- Cambia entre español e inglés sin reiniciar, y dos plantillas nuevas: Aurora Studio y Canvas.
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
