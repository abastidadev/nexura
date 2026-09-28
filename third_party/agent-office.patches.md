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
- **`package-lock.json` es siempre el de upstream**: `update:office` lo copia tal cual y `setup:office` usa `npm ci`.
- **La interfaz de los tableros se deriva de la clase `GitHub` de upstream**, con `Tracker = { [K in keyof GitHub]: GitHub[K] }`. Si upstream cambia un método, `NexuraTracker` deja de compilar y el typecheck de la oficina lo avisa al actualizar.

## Enganches en archivos de upstream

| Archivo | Enganche | Para qué |
|---|---|---|
| `src/server/server.ts` | `...nexuraFrameHeaders(ext)` en `serveFile` | Permite que Nexura incruste la oficina (`frame-ancestors`, configurable con `NEXURA_FRAME_ANCESTORS`). |
| `src/server/server.ts` | `new NexuraBridge(...)`, `nexura.list(floor)` en `floorView` y la ruta `POST /nexura/workers` | Los flujos de Nexura aparecen como trabajadores virtuales. |
| `src/shared/protocol.ts` | `WorkerInfo.external?` | Marca a un trabajador como flujo de Nexura. |
| `src/server/workers.ts` | `nexuraDesk` en `deskOccupied` | Los trabajadores propios de la oficina no se sientan en la mesa de un flujo de Nexura. |
| `src/client/main.ts` | `openWorkerTerminal`, teclas de la mesa, texto del portátil, barra de ayuda y rechazo de tarjetas | Abrir un flujo de Nexura lleva al flujo en Nexura, no a una terminal. |
| `src/client/main.ts` | `watchForgeWords(() => store.project)` | En plantas de Azure DevOps, las ventanas dicen "Azure DevOps" y los `#N` enlazan al work item. |
| `src/server/floor.ts` | `new (trackerClass(this.project.remote))(` | En una planta con remoto de Azure DevOps, los tableros vienen de Nexura. |
| `src/client/ui/pull.ts` | `nexuraIssueButton(...)` en la ventana de un issue | Botón "Resolve with Nexura", que abre Nuevo flujo en Nexura con los datos rellenados. |
| `src/server/building.ts` | `withNexuraRepos(...)`, `nexuraCheckout(...)` y el método `addCheckout` | Los repos de Nexura (`nexura/<nombre>`) aparecen en el ascensor y se abren como planta en su carpeta, sin clonar. |
| `src/server/workers.ts` | `nexuraClaudeArgs` en `launch()`; `nexuraCreatePr` en `openPr`; `nexuraFindPr` en `findOpenPr` | Los trabajadores de una planta de ADO reciben la equivalencia `gh` → `az` y abren sus PR a través de Nexura. |
| `src/server/changes.ts` | `nexuraCreatePr` antes de `gh pr create` | El PR que se abre desde la ventana Changes, en ADO. |

## Archivos propios

| Archivo | Qué hace |
|---|---|
| `src/server/nexura/frame.ts` | Cabeceras de framing de las páginas. |
| `src/server/nexura/bridge.ts` | Trabajadores virtuales: valida lo que envía Nexura, elige planta y mesa, y emite `worker.update`/`worker.remove`. Los retira si Nexura deja de enviar durante 60 s. |
| `src/server/nexura/tracker.ts` | `NexuraTracker`: los tableros de Issues y PR de una planta ADO, pidiendo los datos a `NEXURA_URL/api/office/board/*`. |
| `src/server/nexura/floors.ts` | Los repos de Nexura en el ascensor. |
| `src/server/nexura/pulls.ts` | Remotos ADO, la nota `gh` → `az` para Claude, y crear y buscar PR a través de Nexura. |
| `src/client/nexura/external.ts` | Todo lo del cliente: abrir el flujo en Nexura (`postMessage` o una pestaña nueva), la barra de ayuda, el portátil, el botón "Resolve with Nexura" y, en plantas de Azure DevOps, un `MutationObserver` que cambia "GitHub" por "Azure DevOps" en los diálogos (nunca en el Markdown ni en lo que escribe la gente) y apunta los `#N` al work item. |
| `tests/nexura-*.test.ts` | Tests de lo anterior (`node --import tsx --test tests/nexura-*.test.ts`). |

## Limitaciones conocidas

- **Plantas de Azure DevOps**:
  - **Tableros**: la columna de checks de los PR sale como "none" en la lista (sí aparece en el detalle, con las directivas de la rama). La relación PR → work item se deduce de `#N` o `AB#N` en la descripción. Las líneas +/− solo se calculan para los PR abiertos (un `git fetch` por refresco).
  - **Merge**: Azure DevOps completa los PR de forma asíncrona; el tablero vuelve a mirar a los 5 s para mostrarlo como merged.
  - **Agentes**: los tres agentes de tablero y los prompts configurables de la oficina siguen escritos para `gh`. En esas plantas, Claude recibe con `--append-system-prompt` cómo traducirlo a `az`, lo que exige tener `az` con la extensión `azure-devops` y `az login`. Codex y OpenCode no reciben esa nota.
- **Ascensor**: al elegir un repo de Nexura, el pie del ascensor sigue diciendo "Cloned into … with gh". La planta se abre igualmente en la carpeta del repo, sin clonar.
- **Upstream en Windows con `claude.cmd`**: la oficina lanza `claude -p` (límites del plan, nombres de tareas) con `spawn` sin shell, y Node no puede ejecutar un `.cmd` así (`spawn EINVAL`). No afecta a quien tiene `claude.exe` (instalador nativo); sí a una instalación con npm.

## Tests de upstream que fallan en Windows

Fallan los 17 tests de `tests/workers.test.ts`. Todos fallan por timeout, también sin nuestros parches: lanzan agentes falsos escritos como scripts `#!/usr/bin/env node` con `chmod` dentro de un PTY, y Windows no puede ejecutarlos. El resto de la suite pasa.
