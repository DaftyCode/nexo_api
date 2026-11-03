# Nexo API

Workspace para construir, ejecutar y probar APIs en escritorio local y servidor propio, con Angular, Tauri y Rust.

## Arquitectura

El backend separa dominio, casos de uso y puertos, adaptadores de infraestructura, adaptador HTTP y raíces de composición. Los crates de dominio y aplicación no dependen de Axum, SQLite ni Tauri.

El frontend separa dominio, aplicación, infraestructura, presentación y composición. Los casos de uso y contratos interiores no dependen de Angular. La presentación usa componentes standalone, signals, OnPush y Signal Forms.

El motor de Nexo ejecuta HTTP y scripts en procesos con límites de memoria y tiempo. Sus adaptadores implementan transporte HTTP con Undici, variables, cookies, aserciones, importaciones y generación de código. También incluye clientes gRPC, WebSocket, Socket.IO y MQTT, mocks locales, datasets SQL, vault y MCP.

## Requisitos

- Node LTS 26.13 o superior y npm.
- Rust fijado en `rust-toolchain.toml`.
- Para escritorio Windows: herramientas MSVC y WebView2.

```powershell
npm ci
node tools/ensure-node.mjs
npm run engine:build
```

## Escritorio

```powershell
npm run desktop:dev
# Generar instalador:
npm run desktop:build
```

El instalador se genera en `target/release/bundle/nsis`. Incluye el frontend, backend Rust y runtime Node. El modo local funciona sin cuenta y conserva sus propios datos y secretos en el equipo.

## Desarrollo web

```powershell
npm run dev
```

Abrir [http://localhost:4200/workspace](http://localhost:4200/workspace). El backend local escucha en loopback 8080.

## Servidor con SSR

```powershell
npm run build
npm run backend:build
npm run preview:server
```

Abrir [http://localhost:4000](http://localhost:4000). Este comando inicia la web SSR y el backend de servidor en loopback 8081, con datos separados en `.nexo-server`. El primer acceso permite crear la cuenta propietaria. El registro posterior está deshabilitado por defecto; `NEXO_ALLOW_SIGNUP=true` permite habilitarlo.

Para procesos separados, usar `npm run server:start` y `npm run serve:ssr:nexo`. El proxy web utiliza `NEXO_API_URL`, por defecto `http://127.0.0.1:8080`.

La portada y `/docs` se renderizan en servidor. El editor privado `/workspace` se renderiza en cliente con `noindex` y sin transferir respuestas privadas al HTML SSR.

```bash
docker compose up --build -d
```

Configurar `.env` a partir de `.env.example` y usar un proxy HTTPS para exponer la aplicación con un dominio propio. El volumen `nexo-data` conserva usuarios, documentos, revisiones y secretos cifrados. La configuración de Compose está validada; falta verificar la ejecución del contenedor.

## CLI

```powershell
npm run backend:build
npm run nexo -- run collection.json --environment environment.json --iterations 5 --data rows.json --report result.json --junit result.xml
npm run nexo -- request request.json
npm run nexo -- import specification.yaml --report collection.json
```

Las colecciones son JSON portable con `info`, `item`, `request` y eventos de scripts. Los formatos de importación incluyen JSON de colecciones y entornos, OpenAPI/Swagger, HAR y cURL. Los `$ref` externos deben agruparse antes de importar. La generación de código ofrece cURL, JavaScript/Node, Python, Go, Rust, C# y PowerShell.

Los scripts usan `nx.environment`, `nx.variables`, `nx.collectionVariables`, `nx.iterationData`, `nx.request`, `nx.response`, `nx.test`, `nx.expect` y `nx.sendRequest`. Las aserciones incluyen igualdad, igualdad profunda, propiedades, inclusión, tipos y comparaciones. Cada script tiene un límite de 5 segundos y cada proceso un límite de 256 MB. Los scripts no reciben acceso a módulos, procesos ni al sistema de archivos.

Las ayudas de autenticación HTTP implementadas son Basic, Bearer, API key, OAuth2 mediante token y Digest MD5/SHA-256. Otros helpers se rechazan expresamente. Los certificados TLS se proporcionan en memoria. Las cookies se mantienen por usuario durante la vida del motor. gRPC requiere proto y no implementa reflexión automática. La colaboración incluye cuentas, workspaces, roles y revisiones; no incluye presencia, comentarios ni sincronización gestionada externa.

## Comprobaciones

```powershell
npm run test:architecture
npm test -- --watch=false
npm run engine:test
npm run backend:test
npm run backend:clippy
npm run build
npm run build:desktop
npm run test:server
npm run test:ssr
```

`test:server` necesita el backend release. `test:ssr` necesita el build SSR y un backend local en 8080; el puerto 4000 debe estar libre. Los informes de verificación se generan en `.verification`, excluido de Git. Los tests de protocolos abren servidores temporales en loopback.
