# Parches locales sobre Agent Office

`third_party/agent-office/` es una copia de [AgentSystemLabs/agent-office](https://github.com/AgentSystemLabs/agent-office) fijada en el commit indicado en [`agent-office.upstream.json`](agent-office.upstream.json).

Para traer los cambios nuevos de upstream, ejecuta `npm run update:office [ref]`. El script:

- aplica los cambios de upstream sobre esta copia como un merge a tres bandas;
- si alguno choca con un parche nuestro, deja marcadores de conflicto y se detiene sin confirmar nada.

Qué hace cada parche y cómo se prueba está explicado en [docs/office-3d.md](../docs/office-3d.md).

## Reglas para que las actualizaciones sigan siendo baratas

- **El código de Nexura vive en archivos propios**: `src/server/nexura/`, `src/client/nexura/` y `tests/nexura-*.test.ts`. Upstream nunca los toca.
- **En los archivos de upstream solo hay enganches de una o pocas líneas.** Todos llevan `nexura` en un comentario, así que `grep -rn "nexura" src` los lista. Cuando sustituyen algo, el comentario dice qué había antes (`// nexura: was …`).
- **No se añaden variantes a `ClientMsg`/`ServerMsg`**, solo campos opcionales.
- **`package-lock.json` parte del de upstream**: `update:office` añade las dependencias locales declaradas en `package.json` con npm, y `setup:office` usa `npm ci`.
- **La interfaz de los tableros se deriva de la clase `GitHub` de upstream**, con `Tracker = { [K in keyof GitHub]: GitHub[K] }`. Si upstream cambia un método, `NexuraTracker` deja de compilar y el typecheck de la oficina lo avisa al actualizar.

## Enganches en archivos de upstream

Desde el refactor de upstream (#215, `main.ts`, `server.ts` y `office.ts` divididos en registros), lo nuestro se instala como una pieza más: rutas en la tabla de `http/routes/index.ts`, un fixture en `floorPlan()` y `installNexura(ctx)` en `main.ts`.

| Archivo | Enganche | Para qué |
|---|---|---|
| `src/server/http/static.ts` | `...nexuraFrameHeaders(ext)` en `serveFile` | Permite que Nexura incruste la oficina (`frame-ancestors`, configurable con `NEXURA_FRAME_ANCESTORS`). |
| `src/server/http/routes/index.ts` | `nexuraRoutes.workers`, `.achievements`, `.open` y `.proxy` | `POST /nexura/workers` (público, con el token de Nexura), `/api/nexura/achievements`, `/api/nexura/open` y el resto de `/api/nexura/*` hacia Nexura (con sesión; las rutas que pasan, en `nexura/proxy.ts`). |
| `src/server/office/views.ts` | `nexuraBridge(ctx).list(floor)` en `floorView` | Los flujos de Nexura aparecen como trabajadores virtuales al llegar a una planta. |
| `src/shared/protocol/workers.ts` | `WorkerInfo.external?` (con `step` y `costUsd`) | Marca a un trabajador como flujo de Nexura, con su paso y su coste. |
| `src/shared/protocol/presence.ts` | `PeerInfo.nexura?` y `nexura?` en el mensaje `profile` | Lo que alguien lleva puesto de la tienda. |
| `src/server/ws/handlers/presence.ts` | `sanitizeOutfit(msg.nexura)` en `profile` | Solo artículos conocidos, cada uno en su hueco. |
| `src/server/workers/manager.ts` | `nexuraDeskTaken` en `deskOccupied`; `withNexuraArgs` y `withNexuraPrompt` en `adapter.launch` y `launchAcp`; `windowsSpawn` al lanzar el PTY | Los trabajadores propios no se sientan en la mesa de un flujo; en plantas de ADO, Claude recibe la equivalencia `gh` → `az` como system prompt y los demás agentes delante de su primer prompt; en Windows, shims npm y wrappers batch. Una sola línea de import (`nexura/workers.ts`): el archivo está en su techo de `tests/size.test.ts`. |
| `src/server/workers/pr.ts` | `nexuraFindPr` en `findOpenPr`; `nexuraCreatePr` en `createPr` | Los trabajadores de una planta de ADO abren y buscan sus PR a través de Nexura. |
| `src/server/changes.ts` | `nexuraCreatePr` antes de `gh pr create` | El PR que se abre desde la ventana Changes, en ADO. |
| `src/server/floor.ts` | `new (trackerClass(this.project.remote))(` | En una planta con remoto de Azure DevOps, los tableros vienen de Nexura. |
| `src/server/building.ts` | `withNexuraRepos(...)`, `nexuraCheckout(...)` y el método `addCheckout` | Los repos de Nexura (`nexura/<nombre>`) aparecen en el ascensor y se abren como planta en su carpeta, sin clonar. |
| `src/server/limits.ts`, `src/server/tasks.ts` | `npmNodeShim`, `cross-spawn` | En Windows, límites y nombres de tareas también funcionan con `claude.cmd`. |
| `src/client/main.ts` | `installNexura(ctx, parts)` | El interactuable `nexura`, las monedas, la ropa de cada uno, el heraldo, la visita guiada; en plantas de ADO, "GitHub" pasa a "Azure DevOps". |
| `src/client/world/office/build.ts` | `...nexuraFixtures` en `floorPlan()` | Construye en cada planta lo de Nexura (`nexura/fixtures.ts`, posiciones en `src/shared/nexura-places.ts`). |
| `src/client/features/palette/index.ts` | `nexuraPaletteEntries(...)` | Lo de Nexura en la paleta. |
| `src/client/ui/elevator.ts` | la nota del pie para repos `nexura/…` | Un repo de Nexura se abre en su carpeta, sin clonar. |
| `src/client/input/pointer.ts` | `nexuraUse(...)` en `interact` | Lo que usas en la oficina cuenta para los logros. |
| `src/client/features/workers/actions.ts` | `nexuraDeskKey` en la mesa, `nexuraHint` en `deskHint` | Las teclas y la barra de ayuda en la mesa de un flujo de Nexura. |
| `src/client/features/workers/views.ts` | `nexuraScreen`, `nexuraLaptopScreen` y `nexuraWorkerProps` | Lo que muestra el portátil de un flujo de Nexura, su gorra y el objeto de su paso. |
| `src/client/features/waiting/index.ts`, `src/client/lite.ts` | `openNexuraRun` en `openWorkerTerminal` / `openWorker` | Abrir un flujo de Nexura (también desde la vista 2D `/lite`) lleva al flujo en Nexura, no a una terminal. |
| `src/client/features/carrying/index.ts` | `nexuraCardRefusal` en `cantTakeCard`; `nexuraDropCard` en `dropCard` | Un flujo de Nexura no acepta tarjetas de issues; soltar una en el buzón abre Nuevo flujo. |
| `src/client/ui/github/issue-window.ts` | `nexuraIssueButton(...)` | Botón "Resolve with Nexura", que abre Nuevo flujo en Nexura con los datos rellenados. |
| `tests/size.test.ts` | techo de `workers/manager.ts` (1029 → 1030) | La línea de import de los enganches. |
| `src/shared/dog.ts`, `tests/dog-model.test.ts` | `name: 'Nala'` en `dogDefaults` (antes, uno de `DOG_NAMES`) | El perro de cada planta se llama Nala mientras nadie lo renombre. |
| `src/client/player/collide.ts`, `src/client/player/index.ts` | `ledgeSlide` y `slideOffLedge` | Con el centro fuera del borde de lo que pisas (y una caída de más de un escalón), resbalas en vez de quedarte de pie sobre el aire. Tests en `tests/nexura-player.test.ts`. |
| `src/shared/layout.ts` | `FLOOR.minX` -28 (antes -18); los pufs y las plantas del lado oeste, relativos a `FLOOR.minX`; una ventana sur más (`u` -22) y una oeste menos (`u` -9, donde va la sala de control); `MACHINE_MONITOR.z` -5.75 (antes -6) | Un edificio 10 m más ancho, con un ala oeste para lo de Nexura. |
| `src/client/world/outside.ts` | los tres árboles junto a la fachada oeste, 10 m más allá | Que no atraviesen el suelo de la planta, ahora más ancha. |
| `src/client/world/city.ts` | `PERIOD` 66 (antes 56) | Manzanas más anchas en la ciudad de la azotea, para que la calle oeste no atraviese el edificio. |
| `src/shared/nav.ts` | `rects.push(...nexuraObstacles())` en `obstacles`; `WALK_OFF_X` relativo a la escalera de salida (antes -38) | Trabajadores y perro rodean lo de Nexura, y quien se va a casa se aleja por la acera igual que antes. |
| `src/shared/avatar.ts` | `Look.body?`, `sanitizeBody(...)` en `sanitizeLook` y `body` en `sameLook` | La complexión del personaje (normal, delgado, fuerte, gordo), validada como el resto del aspecto. |
| `src/client/net.ts`, `src/server/ws/connection.ts` | `body` en los parámetros de `/ws` | El cuerpo llega con el resto del aspecto al conectar. |
| `src/client/world/character/person.ts`, `tests/size.test.ts` | `shapeBody(this)` en el constructor y en `setLook`; techo 699 → 702 | Cada persona se construye con su complexión (`nexura/body.ts`). |
| `src/client/ui/character.ts` | la fila "Body" y `randomBody()` en "Surprise me" | Elegir el cuerpo en la pantalla del personaje. |
| `package.json`, `bin/test.js` | `"test": "node bin/test.js"` (con `--import=#tests/css` de upstream) | En Windows, `workers.test.ts` se ejecuta aparte. |

## Archivos propios

| Archivo | Qué hace |
|---|---|
| `src/server/nexura/frame.ts` | Cabeceras de framing de las páginas. |
| `src/server/nexura/routes.ts` | Las rutas HTTP de Nexura y el `NexuraBridge` de cada oficina (se crea la primera vez que se pide). |
| `src/server/nexura/workers.ts` | Los enganches de `workers/manager.ts` en un solo módulo; quién tiene las mesas de los flujos. |
| `src/server/nexura/open.ts` | `/api/nexura/open`: abrir un flujo, Nuevo flujo o una página (Revisiones, Tienda…) en la ventana de Nexura que ya tienes abierta. |
| `src/server/nexura/proxy.ts` | El resto de lo que la oficina pide a Nexura: monedero, tienda, apuestas, Trivial, el resumen para las salas y continuar un flujo. Solo pasan las rutas de `nexuraTarget`. |
| `src/shared/nexura-outfit.ts` | Los artículos de la tienda que se llevan puestos (un test de Nexura comprueba que coinciden con el catálogo). |
| `src/server/nexura/bridge.ts` | Trabajadores virtuales: valida lo que envía Nexura, elige planta y mesa, y emite `worker.update`/`worker.remove`. Los retira si Nexura deja de enviar durante 60 s. |
| `src/server/nexura/tracker.ts` | `NexuraTracker`: los tableros de Issues y PR de una planta ADO, pidiendo los datos a `NEXURA_URL/api/office/board/*`. |
| `src/server/nexura/floors.ts` | Los repos de Nexura en el ascensor. |
| `src/server/nexura/pulls.ts` | Remotos ADO, la nota `gh` → `az` para Claude, y crear y buscar PR a través de Nexura. |
| `src/server/windows-command.ts`, `bin/agent-office-cmd.js` | Detectan el formato completo de un shim npm y lanzan wrappers batch personalizados desde un PTY (`windowsSpawn`). Rechazan prompts multilínea en batch para evitar que `cmd.exe` los interprete como comandos. |
| `src/server/nexura/achievements.ts` | Pasa a Nexura (`NEXURA_URL/api/achievements`) la lista de logros y, validados campo a campo, los eventos de la oficina. |
| `src/client/nexura/index.ts` | `installNexura(ctx, parts)`: define el interactuable `nexura` (que reparte `things.ts` por prefijo), arranca monedas y resumen, viste a todos y avisa al heraldo. |
| `src/client/nexura/fixtures.ts`, `places.ts`, `panel.ts` | La lista de fixtures de Nexura, dónde está cada uno (reexporta `PLACES`) y las pantallas pintadas en canvas. |
| `src/shared/nexura-places.ts` | Dónde está cada cosa de Nexura en la planta (el ala oeste) y sus huellas para la navegación (`nexuraObstacles`). |
| `src/client/nexura/wallet.ts`, `shop.ts`, `cosmetics.ts` | Monedero, el puesto y la ventana de la tienda, y la ropa en 3D. |
| `src/shared/nexura-body.ts`, `src/client/nexura/body.ts` | Las complexiones (`BODY_TYPES`) y cómo cada una estira torso y extremidades, con pectorales, hombros o barriga; `bodyFit` ajusta la ropa de la tienda. |
| `src/client/nexura/digest.ts`, `control-room.ts`, `boards.ts`, `fame.ts` | El resumen de Nexura y las salas que lo pintan. |
| `src/client/nexura/desk.ts`, `bets.ts`, `inbox.ts`, `worker-props.ts` | Aprobar desde la mesa, apuestas, el buzón y la gorra y el objeto de cada flujo. |
| `src/client/nexura/games.ts`, `futbolin.ts`, `ducks.ts` | La sala de juegos, el futbolín y los patitos por temporadas. |
| `src/client/nexura/palette.ts`, `tour.ts` | Entradas de la paleta y la visita guiada. |
| `src/client/nexura/trophy-case.ts` | La vitrina 3D (copas por nivel) y los patitos como objetos. |
| `src/client/nexura/screen.ts` | La pantalla del portátil de un flujo de Nexura. |
| `src/client/nexura/achievements.ts` | El fixture de la vitrina y los cinco patitos, los secretos (código Konami, turno de noche, hoyo en uno), la ventana de logros y el toast de trofeo cuando la oficina no está dentro de Nexura. |
| `src/client/nexura/external.ts` | Todo lo del cliente: abrir el flujo en Nexura (`postMessage` o una pestaña nueva), la barra de ayuda, el portátil, el botón "Resolve with Nexura" y, en plantas de Azure DevOps, un `MutationObserver` que cambia "GitHub" por "Azure DevOps" en los diálogos (nunca en el Markdown ni en lo que escribe la gente) y apunta los `#N` al work item. |
| `tests/nexura-*.test.ts` | Tests de lo anterior (`node --import tsx --test tests/nexura-*.test.ts`). |

## Limitaciones conocidas

- **Plantas de Azure DevOps**:
  - **Tableros**: la columna de checks de los PR sale como "none" en la lista (sí aparece en el detalle, con las directivas de la rama). La relación PR → work item se deduce de `#N` o `AB#N` en la descripción. Las líneas +/− solo se calculan para los PR abiertos (un `git fetch` por refresco).
  - **Merge**: Azure DevOps completa los PR de forma asíncrona; el tablero vuelve a mirar a los 5 s para mostrarlo como merged.
  - **Agentes**: los tres agentes de tablero y los prompts configurables de la oficina siguen escritos para `gh`. En esas plantas, Claude recibe con `--append-system-prompt` cómo traducirlo a `az`, lo que exige tener `az` con la extensión `azure-devops` y `az login`. Codex y OpenCode no reciben esa nota.
- **Ascensor**: al elegir un repo de Nexura, el pie del ascensor sigue diciendo "Cloned into … with gh". La planta se abre igualmente en la carpeta del repo, sin clonar.
- **Wrappers batch personalizados en Windows**: los argumentos multilínea se rechazan porque `cmd.exe` puede interpretarlos como comandos. Usa el shim estándar de npm o un `.exe` para esos prompts.

## Tests de upstream en Windows

Los agentes falsos de `tests/workers.test.ts` usan shims npm `.cmd` en Windows; `codex-usage.test.ts` usa una junction de directorio. `npm test --prefix third_party/agent-office` ejecuta los tests de trabajadores por separado para cerrar ConPTY al terminar.
