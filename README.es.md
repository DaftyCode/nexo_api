[![English](public/languages/english.svg)](README.md)
[![Español — seleccionado](public/languages/spanish-active.svg)](README.es.md)

# Nexo API

**Tus APIs. Tu workspace. Tu infraestructura.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Desktop packages](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml/badge.svg)](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml)
[![Downloads](https://img.shields.io/badge/Downloads-GitHub_Releases-blue)](https://github.com/DaftyCode/nexo_api/releases)

Nexo API es una aplicación **100% open source**, con licencia MIT, para construir, organizar, ejecutar y probar APIs desde tu equipo.

Nos inspiramos en Postman y en la comodidad de reunir peticiones, colecciones, entornos y pruebas en un mismo lugar. A partir de esa inspiración estamos construyendo un proyecto independiente, con implementación propia y una arquitectura basada en **Tauri + Rust + Angular**.

Queremos una herramienta ágil, que arranque rápido, responda con fluidez y mantenga tus datos bajo tu control. Rust ejecuta el backend nativo y Tauri integra el WebView del sistema para el escritorio. Las peticiones, los scripts, los protocolos, los mocks y los datasets también se ejecutan en Rust, dentro del mismo proceso; los scripts usan un sandbox QuickJS embebido. Node solo hace falta para compilar la interfaz, nunca para ejecutar la aplicación. Publicaremos mediciones reproducibles de arranque, memoria y latencia a medida que avance el proyecto.

El proyecto está en fase inicial. Las contribuciones, ideas, pruebas y revisiones son bienvenidas.

## Qué puedes hacer

| Área               | Disponible                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Peticiones         | HTTP/HTTPS, métodos, parámetros y variables de ruta, cabeceras y respuestas; cuerpos raw, JSON, formularios, archivos en multipart y binario, y GraphQL con explorador y autocompletado. |
| Organización       | Colecciones y carpetas, pestañas, entornos, variables, historial y documentos persistidos en SQLite. Arrastra pestañas, colecciones, carpetas, peticiones (también a otra colección) y las secciones del menú; al abrir, todo sigue en tu orden y las pestañas vuelven con sus cambios sin guardar. |
| Autenticación HTTP | Todos los tipos de Postman, Bruno e Insomnia: Basic, Bearer, API key, Digest, OAuth 1.0, OAuth 2.0 (todos los flujos, PKCE, ventana de inicio de sesión en el escritorio como la de Postman, tokens en el vault, renovación y obtención automáticas), AWS Signature v4, Hawk, NTLM, JWT Bearer, Atlassian ASAP, Akamai EdgeGrid, WSSE y Netrc; heredada de carpetas y colecciones. |
| Scripts y pruebas  | Pre-request y scripts de respuesta, variables por ámbito, `nx.test`, `nx.expect`, `nx.sendRequest`, logs y resultados de aserciones. |
| Runner             | Colecciones con iteraciones y datos JSON/CSV, scripts heredados, progreso, pausa, cancelación, informes PDF y reportes JSON/JUnit desde CLI. |
| Protocolos         | WebSocket, Socket.IO, MQTT, Kafka, gRPC (con proto o por reflexión) y subscriptions GraphQL por WebSocket o SSE.                     |
| MongoDB            | Conexiones, explorador, consultas, edición de documentos con salvaguardas, índices, explain, profiler, agregaciones por etapas, esquema, importar y exportar JSON/CSV, change streams, shell, generación de código, SQL y comparar/sincronizar. |
| Importación        | Colecciones JSON portables, entornos, OpenAPI/Swagger JSON o YAML, HAR y cURL.                                                       |
| Código             | Generadores propios para cURL, JavaScript/Node, Python, Java, Go, Rust, C# y PowerShell.                                             |
| Herramientas       | Mocks HTTP locales, datasets JSON/CSV con consultas SQL de lectura, gestor de cookies, definiciones de API con linter, Git con remotos y cliente/servidor MCP. |
| Secretos           | Vault cifrado con AES-GCM, referencias `{{vault:nombre}}`, dominios permitidos por secreto y redacción de secretos en resultados.    |
| Workspaces         | Varios workspaces locales, historial de documentos y revisiones para evitar sobrescrituras.                                          |
| Escritorio y web   | Aplicación de escritorio con Tauri o la misma interfaz en el navegador mediante un lanzador local si no puedes instalar la app.       |

Las peticiones salen desde tu equipo. Con `NEXO_EGRESS=deny-private` se rechazan destinos privados y de loopback, salvo tus propios mocks; `NEXO_EGRESS_ALLOW` define excepciones.

### Plantillas del workspace

El código incluye tres plantillas, seleccionables desde **Template**: **Aurora** (la oscura predeterminada), **Studio** (tres columnas con contexto del entorno y de la petición) y **Canvas** (clara, con petición y respuesta en paralelo). Todas comparten colecciones, entornos, variables, historial y herramientas. Cambiar de plantilla conserva la petición abierta y guarda tu preferencia en ese dispositivo. En Canvas se accede a la navegación desde **Tools** y **Browse collections**. Classic se ha retirado. Cada método HTTP tiene su color en todas las plantillas (GET verde, POST amarillo, PUT azul, PATCH morado, DELETE rojo); los colores y tamaños se pueden cambiar con [variables CSS](#estilos-tokens-de-diseño).

### Idiomas de la interfaz

El código incluye **inglés y español**, con selector en la web, la documentación y el workspace. Transloco actualiza textos, menús, formularios, accesibilidad y mensajes conocidos de la aplicación al instante, sin recargar. La preferencia se guarda en ese dispositivo; el inglés es el idioma predeterminado y de respaldo. El idioma y la plantilla son preferencias independientes. Los cuerpos de peticiones, respuestas, scripts, valores de variables y nombres de tus recursos se conservan.

Las traducciones están en `src/app/infrastructure/i18n/en.json` y `es.json`. Los mensajes simples usan el texto original en inglés como identificador; los mensajes con parámetros utilizan claves con nombre. Añade las entradas correspondientes en ambos catálogos y ejecuta `npm run i18n:check` para comprobar cobertura y parámetros. Un idioma nuevo también debe registrarse en el catálogo de idiomas, los proveedores y el selector. Los diagnósticos del servidor o motor sin traducción conservan su texto original.

## Descargar e instalar

Las versiones se publican en [GitHub Releases](https://github.com/DaftyCode/nexo_api/releases). Consulta los assets de cada versión: una plataforma preparada en CI no implica que ya exista un instalador publicado para ella.

| Sistema | Arquitectura                        | Paquetes preparados en CI                          |
| ------- | ----------------------------------- | -------------------------------------------------- |
| Windows | x64                                 | Instalador NSIS `.exe` y Windows Installer `.msi`. |
| macOS   | Apple Silicon e Intel, por separado | Aplicación `.app` dentro de `.dmg`.                |
| Linux   | x64                                 | `.deb`, `.rpm` y `.AppImage`.                      |

Cada compilación se realiza en un runner del sistema correspondiente. Los instaladores son autosuficientes: los usuarios finales no necesitan instalar Node ni Rust.

### Microsoft Store

[<img src="https://get.microsoft.com/images/es-es%20dark.svg" width="200" alt="Descárgalo de Microsoft">](https://apps.microsoft.com/detail/9N6H77VSRDQ4?mode=direct)

Nexo API está en Microsoft Store: la Store firma el paquete, lo instala y mantiene la app actualizada. En Windows, el botón abre directamente la ficha en la app de la Store. Para generar el paquete MSIX en local: `npm run desktop:msix` (necesita el Windows SDK).

## Cómo funciona

![Arquitectura de Nexo: Angular y Tauri conectan con el backend Rust, que coordina SQLite, el vault y el motor de peticiones y scripts.](public/architecture.es.svg)

Nexo funciona para una persona en su equipo. El escritorio inicia un servicio Rust en un puerto aleatorio de loopback y se autentica con un token propio de cada ejecución. La versión web usa el mismo servicio: su lanzador solo escucha en loopback y abre el navegador con un enlace de un solo uso que se convierte en una cookie de sesión HttpOnly. Las peticiones necesitan un Host de loopback, un Origin permitido y la cabecera del cliente Nexo, de modo que otras webs y otros equipos no pueden usar el servicio. Los datos se guardan en la carpeta de datos de la aplicación; los secretos se cifran con una clave guardada en el almacén de credenciales del sistema.

## Arquitectura que queremos mantener

### Backend: hexagonal

```text
backend/crates/
  nexo-domain/          Entidades, reglas y errores del dominio
  nexo-application/     Casos de uso y puertos
  nexo-infrastructure/  Adaptadores SQLite, Git y almacén de credenciales
  nexo-engine/          Adaptador de ejecución: HTTP, scripts QuickJS, protocolos, mocks, datasets, vault
  nexo-http/            Adaptador HTTP
  nexo-server/          Raíz de composición y CLI
src-tauri/             Raíz de composición de escritorio
```

El dominio no conoce HTTP, bases de datos ni interfaz gráfica. Los casos de uso dependen de contratos; los adaptadores implementan esos contratos. Tauri y el servidor componen las mismas capacidades.

### Frontend: Clean Architecture

```text
src/app/
  domain/          Modelos y reglas independientes de Angular
  application/     Casos de uso y contratos
  infrastructure/  Implementaciones de los contratos
  presentation/    Componentes, estado y vistas Angular
  composition/     Inyección y configuración de dependencias
```

La presentación llama a los casos de uso. Los detalles HTTP y de archivos quedan en infraestructura. Usamos componentes standalone, signals, OnPush, Signal Forms y rutas lazy.

Aplicamos **SOLID y Clean Code**: una responsabilidad clara por módulo; puertos pequeños; dependencias hacia las capas interiores; implementaciones intercambiables; nombres concretos y funciones que hagan una sola cosa. Las abstracciones deben resolver una necesidad real. `npm run test:architecture` comprueba límites entre capas.

### Estilos: tokens de diseño

Todos los colores y tamaños de la interfaz son variables CSS `--nexo-*`. Las reglas de estilo solo leen variables; los valores están en un único sitio:

- **Tokens globales** (`src/styles/tokens/`): escala de tipografía, espaciado, tamaños, radios, bordes, sombras, animaciones y capas; la paleta semántica (fondos, superficies, bordes, textos, acento, estados, código); un token por zona del workspace (barra superior, navegación, pestañas, barra de URL, paneles) y los colores de los métodos HTTP.
- **Tokens de tema** (`_theme.scss` de cada plantilla): Aurora, Studio y Canvas solo redefinen valores; no repiten reglas.

Están en la capa CSS `nexo-tokens`, así que cualquier hoja de estilos externa los sobrescribe sin `!important`:

```css
.studio {
  --nexo-color-accent: #2f81f7;
  --nexo-space-unit: 2.5px; /* toda la interfaz más amplia */
}
```

Queremos que cambiar un tema sea cambiar variables, y que cualquiera pueda crear el suyo. El siguiente paso es cargar temas personalizados desde la app. `npm run test:architecture` rechaza colores o tamaños fijos fuera de los archivos de tokens. La guía completa está en [src/styles/README.md](src/styles/README.md).

## Compilar el escritorio desde un repositorio recién descargado

Compila en el sistema operativo y la arquitectura de CPU que quieras distribuir: los scripts instalan las versiones fijadas de Node y Rust, compilan la interfaz y el escritorio, y dejan los instaladores en `target/release/bundle`. [docs/BUILD.es.md](docs/BUILD.es.md) explica la instalación en un paso, las opciones, la compilación manual, la versión web local y la CLI.

## Estado y siguientes pasos

La versión actual es la **0.6.0**, con el cliente MongoDB completo. Las pruebas cubren peticiones reales, variables, scripts, aserciones, cancelación, cookies, redacción de secretos, importación OpenAPI, código generado ejecutable, runner con datos, todos los tipos de autorización (con vectores oficiales y servidores que verifican), gRPC unary y streaming con proto o reflexión, WebSocket, Socket.IO, MQTT, Kafka, subscriptions GraphQL, MongoDB y FerretDB reales, política de salida, control de acceso local y revisiones. Las pruebas de contrato de `tests/contract` usan el binario real del servidor.

Siguientes pasos:

- Visor y editor de bases de datos como módulos descargables, de modo que Nexo se instala como cliente de APIs y el driver de cada base de datos solo se descarga al crear una conexión de ese tipo: PostgreSQL, MySQL y MariaDB, SQLite, SQL Server, Oracle, Cassandra, Redis, Elasticsearch y Apache Drill, con árbol de conexiones, editor SQL que conserva una pestaña de resultado por consulta, rejilla de datos con edición, editor de estructura, diagramas ER, planes de ejecución y transferencia de datos. MongoDB pasará a ser uno de esos módulos.
- Asistente de IA con la clave personal de cada usuario.
- Túnel SSH y proxy SOCKS5, entornos protegidos, ejecuciones programadas, comparar respuestas, exportar a Excel/CSV con datos enmascarados, inferir JSON Schema de las respuestas e importar de Insomnia, Bruno, Hoppscotch y Thunder Client.
- Temas personalizados desde la app, sobre los tokens de diseño.
- Quitar el Node que queda en las herramientas de desarrollo: pruebas de contrato y scripts de compilación en Rust.
- Distribución: WinGet, Homebrew, repositorios APT/YUM firmados y Flatpak; firma fuera de la Store en Windows y notarización en macOS; validar los instaladores en máquinas limpias.
- Publicar mediciones de arranque, memoria y latencia.
- Más bases de datos después de esas (se están evaluando DB2, Apache Hive y Apache Ignite).

Los límites actuales incluyen 5 segundos y 128 MB de memoria por evaluación de script, ocho ejecuciones activas y respuestas limitadas para la interfaz. Las cookies se guardan por workspace en la carpeta de datos. Aún no se admiten MQTT 5, Socket.IO 2.x (Engine.IO v3) ni consumer groups, transacciones o Schema Registry en Kafka. Los `$ref` externos de OpenAPI deben agruparse antes de importar. Los tipos de autorización desconocidos se rechazan expresamente. La compatibilidad de protocolos y formatos seguirá creciendo con casos de prueba reproducibles.

## Colaborar

Puedes abrir una [issue](https://github.com/DaftyCode/nexo_api/issues), proponer una mejora, corregir un fallo, ampliar pruebas o enviar una pull request. No necesitas permiso previo para empezar. Para cambios grandes, una issue con el problema y la propuesta ayuda a coordinar el trabajo.

1. Haz un fork y crea una rama corta: `feat/http-history`, `fix/runner-cancel` o similar.
2. Mantén cada cambio centrado en un problema y respeta las capas y responsabilidades.
3. Añade pruebas de comportamiento cuando cambies reglas o adaptadores. Incluye un caso que reproduzca el fallo si corriges uno.
4. Ejecuta las comprobaciones relevantes y explica en la PR el problema, el resultado y cómo lo verificaste.
5. Conserva los avisos y licencias de las dependencias. Evita incluir datos locales, credenciales o artefactos generados.

### Commits

Usamos Conventional Commits, con asunto breve y alcance cuando ayude:

```text
feat(runner): support data-driven iterations
fix(vault): redact secrets from execution logs
refactor(domain): separate request validation
test(http): cover cross-origin redirects
docs(readme): explain the local web version
chore(packages): update installer manifests
```

Un commit debe tener una intención clara. Explica el motivo en el cuerpo si no se deduce del cambio. Usa `!` y `BREAKING CHANGE:` cuando cambies un contrato de forma incompatible. Las PR deben mantener la arquitectura hexagonal del backend, Clean Architecture en frontend y los principios SOLID.

## Licencia

Nexo API se distribuye bajo [MIT](LICENSE): puedes usarlo, estudiarlo, modificarlo, redistribuirlo y colaborar, también en entornos comerciales. Las dependencias mantienen sus respectivas licencias.
