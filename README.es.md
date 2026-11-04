[![English](public/languages/english.svg)](README.md)
[![Español — seleccionado](public/languages/spanish-active.svg)](README.es.md)

# Nexo API

**Tus APIs. Tu workspace. Tu infraestructura.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Desktop packages](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml/badge.svg)](https://github.com/DaftyCode/nexo_api/actions/workflows/desktop.yml)
[![Downloads](https://img.shields.io/badge/Downloads-GitHub_Releases-blue)](https://github.com/DaftyCode/nexo_api/releases)

Nexo API es una aplicación **100% open source**, con licencia MIT, para construir, organizar, ejecutar y probar APIs desde tu equipo o desde tu propio servidor.

Nos inspiramos en Postman y en la comodidad de reunir peticiones, colecciones, entornos y pruebas en un mismo lugar. A partir de esa inspiración estamos construyendo un proyecto independiente, con implementación propia y una arquitectura basada en **Tauri + Rust + Angular**.

Queremos una herramienta ágil, que arranque rápido, responda con fluidez y mantenga tus datos bajo tu control. Rust ejecuta el backend nativo y Tauri integra el WebView del sistema para el escritorio. El motor de peticiones y scripts todavía utiliza un runtime Node auxiliar, incluido en el instalador; seguir trasladando trabajo a Rust forma parte de la hoja de ruta. Publicaremos mediciones reproducibles de arranque, memoria y latencia a medida que avance el proyecto.

El proyecto está en fase inicial. Las contribuciones, ideas, pruebas y revisiones son bienvenidas.

## Qué puedes hacer

| Área               | Disponible                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Peticiones         | HTTP/HTTPS, métodos, parámetros, cabeceras y respuestas; cuerpos raw, JSON, formularios de texto y GraphQL sobre HTTP.               |
| Organización       | Colecciones y carpetas, pestañas, entornos, variables, historial y documentos persistidos en SQLite.                                 |
| Autenticación HTTP | Basic, Bearer, API key, Digest MD5/SHA-256 y uso de tokens OAuth2; intercambio de tokens en el panel de integraciones.               |
| Scripts y pruebas  | Pre-request y scripts de respuesta, variables por ámbito, `nx.test`, `nx.expect`, `nx.sendRequest`, logs y resultados de aserciones. |
| Runner             | Colecciones con iteraciones y datos JSON/CSV, scripts heredados, progreso, cancelación y reportes JSON/JUnit desde CLI.              |
| Protocolos         | Clientes WebSocket, Socket.IO, MQTT y gRPC con proto proporcionado.                                                                  |
| Importación        | Colecciones JSON portables, entornos, OpenAPI/Swagger JSON o YAML, HAR y cURL.                                                       |
| Código             | Generadores propios para cURL, JavaScript/Node, Python, Java, Go, Rust, C# y PowerShell.                                             |
| Herramientas       | Mocks HTTP locales, datasets JSON/CSV con consultas SQL de lectura, Git local y cliente/servidor MCP.                                |
| Secretos           | Vault cifrado con AES-GCM, referencias `{{vault:nombre}}` y redacción de secretos en resultados.                                     |
| Servidor           | Cuentas, sesiones revocables, workspaces, miembros, roles y revisiones para evitar sobrescrituras.                                   |
| Escritorio y web   | Aplicación local con Tauri; web con Angular SSR para portada/documentación y editor privado en cliente.                              |

Las peticiones se envían desde el motor local o desde el servidor donde lo despliegues. En modo servidor, una URL de red privada se interpreta desde la red de ese servidor.

### Plantillas del workspace

El código incluye tres plantillas, seleccionables desde **Template**: **Aurora** (la oscura predeterminada), **Studio** (tres columnas con contexto del entorno y de la petición) y **Canvas** (clara, con petición y respuesta en paralelo). Todas comparten colecciones, entornos, variables, historial y herramientas. Cambiar de plantilla conserva la petición abierta y guarda tu preferencia en ese dispositivo. En Canvas se accede a la navegación desde **Tools** y **Browse collections**. Classic se ha retirado.

Estas plantillas se incluirán en la próxima versión de escritorio; los instaladores publicados de `v0.1.0` conservan su interfaz original.

## Descargar e instalar

Las versiones se distribuirán en [GitHub Releases](https://github.com/DaftyCode/nexo_api/releases). Consulta los assets de cada versión: una plataforma preparada en CI no implica que ya exista un instalador publicado para ella.

| Sistema | Arquitectura                        | Paquetes preparados en CI                          |
| ------- | ----------------------------------- | -------------------------------------------------- |
| Windows | x64                                 | Instalador NSIS `.exe` y Windows Installer `.msi`. |
| macOS   | Apple Silicon e Intel, por separado | Aplicación `.app` dentro de `.dmg`.                |
| Linux   | x64                                 | `.deb`, `.rpm` y `.AppImage`.                      |

Cada compilación se realiza en un runner del sistema correspondiente. Los instaladores incluyen el runtime auxiliar, por lo que los usuarios finales no necesitan instalar Node ni Rust.

### WinGet y despliegue empresarial

El pipeline genera manifiestos WinGet con el identificador propuesto `DaftyCode.NexoAPI`, URLs de la release y SHA-256 calculados sobre el MSI real. **La entrada en el catálogo público está pendiente**: primero hay que publicar una versión y enviar los manifiestos a [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs).

Después de su aceptación, el comando previsto será:

```powershell
winget install --exact --id DaftyCode.NexoAPI --source winget
```

El MSI también permite a los equipos de IT desplegar el software con sus herramientas habituales. WinGet sigue utilizando un instalador y respeta las políticas de la empresa; no evita restricciones de ejecución o de confianza en el editor. La firma de Windows y la validación en entornos corporativos están pendientes.

### Homebrew en macOS

Al publicar una release, el workflow `Update package manager index` genera el cask con checksums para Apple Silicon e Intel y lo incorpora a este repositorio. **Hasta la primera release publicada y la ejecución correcta de ese workflow, el cask todavía no estará disponible.** Después:

```bash
brew tap daftycode/nexo https://github.com/DaftyCode/nexo_api
brew install --cask daftycode/nexo/nexo-api
```

Usaremos un tap propio; la inclusión en el catálogo central de Homebrew es un paso distinto. Los builds de CI usan firma ad hoc en macOS. La firma Developer ID y la notarización de Apple requieren configurar los certificados y credenciales de distribución; siguen pendientes.

### Linux con APT o DNF

Cuando estén publicados, los paquetes descargados de una release podrán instalarse con el gestor de la distribución:

```bash
# Debian / Ubuntu, desde la carpeta de descarga:
sudo apt install ./Nexo*.deb

# Fedora / distribuciones compatibles con RPM:
sudo dnf install ./Nexo*.rpm
```

Los equipos de IT pueden distribuir estos paquetes mediante sus repositorios internos. Un repositorio APT/YUM público, con índices y firma propios, está pendiente; todavía no existe un `apt install nexo-api` desde los repositorios del sistema. Flatpak y otros catálogos están en la hoja de ruta.

## Cómo funciona

![Arquitectura de Nexo: Angular y Tauri conectan con el backend Rust, que coordina SQLite, el vault y el motor de peticiones y scripts.](public/architecture.es.svg)

El escritorio inicia un servicio Rust en un puerto aleatorio de loopback y utiliza un token propio. Conserva sus datos en el equipo y funciona sin cuenta. El modo servidor añade autenticación y permisos por workspace, y puede desplegarse en infraestructura propia.

La portada y `/docs` se renderizan en servidor. El editor `/workspace` se renderiza en cliente, lleva `noindex` y excluye los datos privados del transfer cache de Angular.

## Arquitectura que queremos mantener

### Backend: hexagonal

```text
backend/crates/
  nexo-domain/          Entidades, reglas y errores del dominio
  nexo-application/     Casos de uso y puertos
  nexo-infrastructure/  Adaptadores SQLite, ejecución, Git y vault
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

## Compilar el escritorio desde un repositorio recién descargado

Descarga y extrae el ZIP del repositorio, o clónalo:

```bash
git clone https://github.com/DaftyCode/nexo_api.git
cd nexo_api
```

Ejecuta los comandos desde la raíz del repositorio, donde está `package.json`. **Compila en el sistema operativo y la arquitectura que quieras distribuir.** La CI genera por separado Windows x64, macOS Apple Silicon, macOS Intel y Linux x64. Los scripts no implementan compilación cruzada ni un paquete universal para macOS.

### Preparación y compilación automáticas

No tienes que descargar Node, Rust ni las dependencias npm a mano. Los scripts:

1. Reutilizan la versión Node fijada en [.node-version](.node-version), o descargan su archivo oficial y verifican el SHA-256 antes de extraerlo.
2. Comprueban las herramientas nativas y preparan las dependencias que falten mediante WinGet en Windows, el instalador de Apple en macOS o APT/DNF en Linux.
3. Instalan Rustup si falta, verificando su descarga oficial, y preparan la versión Rust de [rust-toolchain.toml](rust-toolchain.toml).
4. Ejecutan `npm ci`, preparan el motor incluido, compilan Angular y Rust y generan los paquetes nativos.

La primera ejecución necesita Internet y puede descargar varios GB de SDK y toolchains. Los instaladores del sistema pueden pedir permisos de administrador, aceptar sus condiciones o reiniciar. Completa esos pasos y vuelve a ejecutar el mismo comando si la preparación se detiene. El script no acepta acuerdos de Microsoft o Apple por ti. Una compilación desde cero **no funciona sin conexión**.

**Windows x64 — PowerShell**

```powershell
.\build.ps1
```

WinGet debe estar disponible mediante el [Instalador de aplicación de Microsoft](https://learn.microsoft.com/es-es/windows/package-manager/winget/). El script lo usa para preparar C++, WebView2 y Git cuando falten. Si tu organización bloquea scripts PowerShell o instalaciones, utiliza su procedimiento autorizado o la opción de GitHub Actions indicada más abajo.

**macOS — Terminal, en Apple Silicon o Intel**

```bash
bash build.sh
```

Si aparece el instalador de Command Line Tools de Apple, complétalo y repite el comando. La compilación local usa firma ad hoc por defecto (`APPLE_SIGNING_IDENTITY=-`), igual que la CI. No genera una firma Developer ID ni notariza la app; consulta la [guía de firma de macOS de Tauri](https://v2.tauri.app/distribute/sign/macos/) para las credenciales de distribución.

**Linux — Terminal, en Ubuntu/Debian o Fedora**

```bash
bash build.sh
```

El script prepara compilador, WebKitGTK, OpenSSL, D-Bus y herramientas de empaquetado mediante APT o DNF, usando `sudo` si hace falta. Ubuntu 22.04 x64 es la referencia de la CI. En otras distribuciones instala las [dependencias nativas de Tauri](https://v2.tauri.app/start/prerequisites/) y ejecuta el mismo script con `--skip-system-install`. Genera AppImages en la distribución más antigua que quieras admitir; consulta la [compatibilidad de AppImage en Tauri](https://v2.tauri.app/distribute/appimage/).

### Dónde se generan los paquetes

| Sistema de compilación | Salida relativa a la raíz del repositorio                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Windows                | `target/release/bundle/nsis/*-setup.exe` y `target/release/bundle/msi/*.msi`                                       |
| macOS                  | `target/release/bundle/macos/Nexo API.app` y `target/release/bundle/dmg/*.dmg`                                     |
| Linux                  | `target/release/bundle/appimage/*.AppImage`, `target/release/bundle/deb/*.deb` y `target/release/bundle/rpm/*.rpm` |

Instala o copia el **paquete generado**. El binario suelto de `target/release/` no incluye por sí solo todos los recursos del runtime. La app empaquetada incluye el motor necesario; sus usuarios no necesitan instalar Node ni Rust.

Node y las herramientas descargadas se guardan en `.build-tools/`, excluida de Git. Rustup utiliza sus directorios habituales del usuario; los SDK nativos se instalan en el sistema. Las dependencias y los resultados de compilación también están excluidos. Las siguientes ejecuciones reutilizan herramientas y cachés; los gestores pueden seguir accediendo a Internet.

### Opciones útiles

| Objetivo                                                    | PowerShell                       | macOS/Linux                                                                   |
| ----------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| Comprobar requisitos sin instalar ni compilar               | `.\build.ps1 -Check`             | `bash build.sh --check`                                                       |
| Preparar herramientas sin instalar paquetes npm ni compilar | `.\build.ps1 -ToolsOnly`         | `bash build.sh --tools-only`                                                  |
| Preparar herramientas y paquetes npm sin compilar           | `.\build.ps1 -PrepareOnly`       | `bash build.sh --prepare-only`                                                |
| Usar los SDK existentes sin instalar paquetes del sistema   | `.\build.ps1 -SkipSystemInstall` | `bash build.sh --skip-system-install`                                         |
| Generar un único formato                                    | `.\build.ps1 -Bundles nsis`      | `bash build.sh --bundles dmg` (macOS) o `bash build.sh --bundles deb` (Linux) |

Las opciones pueden combinarse. El modo de comprobación informa si falta la versión de Node y no la descarga. Los MSI necesitan la característica opcional VBScript de Windows; si WiX muestra `failed to run light.exe`, consulta los [requisitos de MSI de Tauri](https://v2.tauri.app/distribute/windows-installer/#building) o genera solo NSIS con `-Bundles nsis`. Si falla `link.exe`, revisa la carga de trabajo de C++ y Windows SDK. Para errores `pkg-config` en Linux, comprueba los paquetes de desarrollo WebKitGTK **4.1**.

Si `npm ci` muestra `EBUSY` sobre Sass o esbuild en Windows, detén las sesiones `npm run dev`, `ng serve`, desarrollo de escritorio y watch/tests de este repositorio antes de repetirlo. No ejecutes la preparación a la vez que el servidor de desarrollo: `npm ci` reemplaza `node_modules`. El aviso `EBADENGINE` con Node 24 indica que la terminal usa otra versión; `build.ps1` utiliza el Node 26.13 preparado sin sustituir la instalación global de tu equipo.

### Compilación manual y desarrollo

Si prefieres gestionar las herramientas, instala Git, Node **26.13.0** con npm, Rustup y los [requisitos de tu sistema](https://v2.tauri.app/start/prerequisites/). En Windows selecciona **Desarrollo para el escritorio con C++**, Windows SDK y WebView2. En macOS utiliza `xcode-select --install`. Abre otra terminal después de instalar las herramientas. Desde el repositorio clonado:

```bash
node --version
npm --version
rustup show active-toolchain
npm ci
```

Elige el comando nativo correspondiente:

```powershell
# Windows x64:
npm run desktop:build -- --bundles nsis,msi
```

```bash
# macOS (por separado en Apple Silicon e Intel):
APPLE_SIGNING_IDENTITY=- npm run desktop:build -- --bundles app,dmg

# Linux:
NO_STRIP=true npm run desktop:build -- --bundles appimage,deb,rpm
```

`desktop:build` genera instaladores nativos. `build:desktop` solo compila la interfaz Angular y **no** genera un instalador. No ejecutes varias compilaciones a la vez sobre el mismo repositorio.

Para desarrollar el escritorio, después de `npm ci`:

```bash
npm run engine:build
npm run desktop:prepare
npm run desktop:dev
```

Para desarrollo web ejecuta `npm run engine:build` y `npm run dev`. Abre [http://localhost:4200/workspace](http://localhost:4200/workspace); el backend utiliza loopback en 8080. Detén el desarrollo web antes de iniciar `desktop:dev`, porque ambos usan el puerto 4200.

### Compilar todas las plataformas sin instalar herramientas locales

Haz un fork, entra en **Actions → Desktop packages → Run workflow** y elige tu rama. El workflow compila los cuatro destinos nativos en los runners Windows, macOS y Linux de GitHub. Descarga los artefactos `nexo-*` al terminar; se conservan durante 14 días. Una ejecución manual no publica una release. Actions debe estar habilitado en el fork y se aplican los límites de uso de GitHub.

### Por qué sigue incluido Node

| Uso                         | Responsabilidad actual                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compilación                 | npm, Angular CLI y la compilación del frontend y el motor. Se ejecutan en el equipo de desarrollo o en CI.                                                                                                                                                                                             |
| App instalada / backend API | Motor auxiliar privado en `engine/src/`: peticiones HTTP/GraphQL, ayudas de autenticación, cookies, scripts/tests JavaScript, runner y rendimiento, protocolos, importación/generación de código, mocks, datasets, MCP y cifrado del vault. Rust delega estas operaciones mediante `ExecutionGateway`. |
| Web en servidor propio      | Angular SSR y su proxy HTTP utilizan Node. El renderizado público es independiente del servicio API Rust.                                                                                                                                                                                              |

Rust ya se ocupa de la aplicación nativa, el servicio API, documentos/revisiones SQLite, usuarios/sesiones/permisos y el adaptador Git local. Quitar Node del ejecutable requiere implementar las operaciones delegadas en Rust manteniendo sus contratos. Los scripts JavaScript necesitan un motor JavaScript embebido o una alternativa compatible y los datos del vault necesitan una migración que los conserve. Borrar Node ahora rompería esas funciones.

La migración prevista consiste en sustituir adaptadores detrás de los puertos existentes: primero transporte y servicios locales, después protocolos y scripting, validando cada sustitución con las pruebas de contrato actuales. Es viable un escritorio sin runtime Node; compilar Angular seguiría requiriéndolo y Angular SSR también, salvo que cambiemos el renderizado de la web. **Los scripts de preparación no eliminan Node del runtime de la aplicación.**

### Servidor propio

```bash
npm run build
npm run backend:build
npm run preview:server
```

Abrir [http://localhost:4000](http://localhost:4000). Este comando inicia SSR y un backend de servidor en loopback 8081, con datos separados en `.nexo-server`. El primer acceso permite crear la cuenta propietaria; el registro posterior está deshabilitado por defecto.

También puedes usar `npm run server:start` y `npm run serve:ssr:nexo` como procesos separados. La web utiliza `NEXO_API_URL`, por defecto `http://127.0.0.1:8080`.

```bash
docker compose up --build -d
```

Configura `.env` a partir de `.env.example`, los orígenes permitidos y un proxy HTTPS para tu dominio. El volumen `nexo-data` conserva documentos, usuarios, revisiones y secretos. La configuración de Compose está validada; queda pendiente verificar el contenedor en ejecución.

### CLI

```bash
npm run nexo -- run collection.json --environment environment.json --iterations 5 --data rows.json --report result.json --junit result.xml
npm run nexo -- request request.json
npm run nexo -- import specification.yaml --report collection.json
```

La CLI comparte el motor de ejecución con el escritorio y el servidor y devuelve un código de error cuando falla una ejecución o una aserción.

## Estado y siguientes pasos

Ya hay pruebas de peticiones reales, variables, scripts, aserciones, cancelación, cookies, redacción de secretos, importación OpenAPI, código generado ejecutable, runner con datos, gRPC unary, WebSocket, Socket.IO, MQTT, permisos, revisiones y SSR.

Quedan áreas importantes por completar:

- Validar los instaladores nuevos en máquinas limpias de Windows, macOS y Linux; firma, notarización, actualización automática y publicación en catálogos.
- Medir rendimiento y seguir trasladando capacidades del runtime auxiliar a Rust.
- Subida de archivos binarios, gestión persistente de cookies y más ayudas de autenticación.
- Flujo OAuth con navegador/callback automático, introspección y subscriptions GraphQL, reflexión gRPC y más variantes de protocolos.
- Pausa/reanudación del runner, más funciones de scripts y pruebas completas de proxy y mTLS.
- Colaboración en tiempo real, comentarios, sincronización entre instalaciones y monitorización programada.
- Repositorios APT/YUM firmados y distribución Flatpak.

Los límites actuales incluyen 5 segundos por evaluación de script, procesos de ejecución de 256 MB y respuestas limitadas para la interfaz. Las cookies duran mientras vive el motor. Los `$ref` externos de OpenAPI deben agruparse antes de importar. Los helpers HTTP aún no implementados se rechazan expresamente. La compatibilidad de protocolos y formatos seguirá creciendo con casos de prueba reproducibles.

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
docs(readme): explain self-hosted setup
chore(packages): update installer manifests
```

Un commit debe tener una intención clara. Explica el motivo en el cuerpo si no se deduce del cambio. Usa `!` y `BREAKING CHANGE:` cuando cambies un contrato de forma incompatible. Las PR deben mantener la arquitectura hexagonal del backend, Clean Architecture en frontend y los principios SOLID.

### Revisión de mantenedores

La rama principal se llama actualmente `master`. Las contribuciones deben llegar mediante pull request y necesitan una aprobación de un code owner; [CODEOWNERS](.github/CODEOWNERS) asigna por ahora esa revisión a **@DaftyCode**. Los commits nuevos invalidan las aprobaciones anteriores, las conversaciones deben estar resueltas y se bloquean los pushes forzados y el borrado de la rama para colaboradores. El propietario del repositorio personal conserva la excepción de administrador. La regla también cubre `main` si se utiliza ese nombre después.

Para incorporar mantenedores, invítalos con permiso de escritura y añade sus usuarios de GitHub al primer patrón de propietarios. Los cambios en `CODEOWNERS` y workflows seguirán necesitando al propietario. Otras personas pueden dejar revisiones, pero su aprobación no sustituye la obligatoria de un code owner. La automatización de los índices de paquetes propone sus cambios para revisión en vez de escribir directamente en la rama principal.

### Comprobaciones

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

`test:server` necesita el backend release; `test:ssr` necesita el build SSR, backend local en 8080 y el puerto 4000 libre. Los informes se generan en `.verification`, fuera de Git. La carpeta local `docs/` también está excluida y no forma parte del repositorio.

## Publicar una versión

`Desktop packages` puede ejecutarse manualmente desde Actions para comprobar los cuatro builds sin publicar una release. Un tag `vX.Y.Z` que coincida con las versiones del proyecto genera un **borrador de GitHub Release**, instaladores, `SHA256SUMS` y manifiestos WinGet/Homebrew. Tras publicar el borrador, el workflow del índice propone el cask y los manifiestos en una rama independiente y abre una PR cuando lo permiten los ajustes del repositorio. Si no, deja la rama y los artefactos preparados para que el propietario abra la PR. El propietario revisa e incorpora esos cambios.

El registro público en WinGet necesita una PR independiente al catálogo oficial. La preparación de paquetes y manifiestos no equivale a su aceptación en un gestor.

## Licencia

Nexo API se distribuye bajo [MIT](LICENSE): puedes usarlo, estudiarlo, modificarlo, redistribuirlo y colaborar, también en entornos comerciales. Las dependencias mantienen sus respectivas licencias.
