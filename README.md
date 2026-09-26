# Nexura <sub>by abastidadev</sub>

IDE local para orquestar flujos de Claude Code (`claude -p` en modo headless) que resuelven tickets de Azure DevOps o issues de GitHub paso a paso: enrich → plan → implement → review → qa → release. Muestra en qué paso va cada flujo, lo que consume y los errores, y permite depurar y corregir el paso exacto que falló.

- Plan completo: [docs/plan.md](docs/plan.md)
- Idea original: [docs/idea-original.md](docs/idea-original.md)
- Hallazgos de la fase 0: [docs/spike-findings.md](docs/spike-findings.md)
- Configuración de Codex y Claude para desarrollar el proyecto: [docs/codex.md](docs/codex.md)

## Estado

| Fase | Estado |
|---|---|
| 0. Spike del CLI | ✅ hecho |
| 1. Núcleo backend | ✅ hecho: runner, orquestador, worktrees, SQLite, ledger, API REST/WS, CLI |
| 2. UI base | ✅ hecho: tabs, nuevo flujo, pipeline, timeline en vivo, cuota, depuración básica |
| 3. Depuración | ✅ hecho: terminal embebida (shell y claude --resume), editor de perfiles, pasos y repos |
| 4. Perfiles y `classify` | ✅ hecho: perfiles editables, `classify`, presupuesto por perfil, valoración del clasificador |
| 5. Azure DevOps y GitHub | ✅ hecho: cargar work item o issue, PR con aprobación, atender comentarios de la PR |
| 6. Métricas | ✅ hecho: coste/tokens/fallos por paso, perfil y día; acierto de `classify`; `qaNotes` |

## Estructura

```
packages/shared/            tipos: eventos normalizados, perfiles, Run/StepRun, mensajes WS
apps/server/src/
  runner/                   AgentProcess + un adaptador por CLI (claude -p, codex exec, copilot -p) + parser stream-json
  orchestrator/             secuencia de pasos, vuelta a implement, reintentos, breakpoints, rate limit
                            builtin-steps: qaCode (checks del repo) y release local, sin tokens
  workspace/                git worktree por run y repo, junction de node_modules, commits
  store/                    SQLite (node:sqlite) + JSONL crudo por paso en data/runs/<id>/steps
  ledger/                   libro de tareas por run (data/runs/<id>/ledger.md)
  azure/ · github/          clientes REST (y GraphQL) de Azure DevOps y GitHub: tickets, PRs, hilos de revisión
  forge/                    elige Azure DevOps o GitHub según el remote origin; vigilancia de PRs
  api/                      REST + WebSocket (/ws eventos, /pty terminales) en :4310
  terminal/                 PTY (@lydell/node-pty, binarios precompilados) para la terminal embebida
  conversations/            sección Terminal: CLIs interactivos en el servidor, transcripciones de cada CLI y traspaso entre agentes
  cli/                      comando nexura
apps/web/                   UI Angular 22 + Tailwind v4 (tabs, nuevo flujo, vista del flujo)
config/profiles/*.json      minimal / standard / full / copilot-test
config/steps/<paso>/        step.json (tools, allowlist, timeout) · prompt.md · schema.json
config/repos.json           tus repos (local, gitignored; ver repos.example.json)
fixtures/                   stream-json reales + fake-claude/codex/copilot.mjs para tests sin tokens (y fake-interactive.mjs, su modo TUI)
```

## Uso

```bash
npm install
cp config/repos.example.json config/repos.json   # y ajusta rutas/checks

npm run nexura -- run --repo AgsAngularComponentLib --ticket-id 1234 \
  --ticket-file ticket.md --task "Subtarea 1" --task "Subtarea 2" --profile auto
npm run nexura -- runs                   # lista
npm run nexura -- show <runId>           # detalle, paso fallido y su sesión
npm run nexura -- retry <runId> [--resume --instruction "..."] [--model opus] [--skip]
npm run nexura -- cleanup <runId> [--delete-branches]
npm start                                # compila la UI y arranca UI + API en http://localhost:4310
npm start -- --port 4320 --concurrency 3 # mismas opciones que `serve`
npm run setup                            # primera vez / tras un pull: npm install + compilar la UI
npm run dev:web                          # UI en desarrollo en :4300 (proxy a la API de :4310)

npm test          # parser + orquestador con claude falso (no gasta tokens)
npm run typecheck
npm run spike     # vuelve a grabar los fixtures reales (gasta un poco de cuota)
```

## La UI

- **Pestañas**: cada flujo abierto es una pestaña con su estado y coste; puedes tener varios corriendo a la vez.
- **Nuevo flujo**: ticket, tareas con checkbox (se extraen de las viñetas del ticket), repos con checkbox, prompt adicional, perfil (automático o uno concreto) y modo *paso a paso*.
- **Vista del flujo**: pipeline de pasos (con reintentos y vueltas), timeline en vivo de cada paso (texto, herramientas con entrada/resultado, errores en rojo, resultado con coste/tokens/turnos), prompt renderizado, salida JSON, log crudo y el comando exacto. A la derecha: tareas que se van marcando, ramas/worktrees y el libro de tareas.
- **Agentes** (pestaña de la cabecera): una única oficina pixel-art con los agentes de todos los flujos. Cada flujo activo tiene su isla de mesas con alfombra, sillas y placa de su color, y sus agentes llevan el cordón de la acreditación de ese color; la ropa delata el modelo (camiseta Haiku, sudadera o camisa Sonnet, traje Opus, camisa verde GPT, sudadera azul Gemini), cada rol lleva su accesorio (auriculares quien implementa, gafas quien revisa…) y los pasos sin LLM son robots. Quien trabaja se sienta en su mesa y su monitor muestra lo que hace (código, terminal, documento, spinner, aviso si espera aprobación), con la herramienta actual bajo la silla; los subagentes entran por la puerta, ocupan las mesas libres con portátil de su flujo y se van al terminar. Los que no tienen trabajo (pasos pendientes, terminados o fallidos) se buscan la vida: sofá (y se duermen), café, fuente, máquina de snacks, recreativas, ping-pong, charlas con bocadillos, siesta en su mesa o acariciar al gato de la oficina; a quien ha fallado le sigue una nubecita. La ventana y el reloj siguen la hora real. La oficina ocupa todo el alto de la página y elige el zoom más grande con el que cabe sin scroll; en pantallas anchas pone la sala y la cocina lado a lado sobre la sala de juegos. Al pasar el ratón por un flujo de la leyenda se resalta su equipo; con «Todos» se quedan también los agentes de los últimos flujos terminados. Dentro de cada flujo, el conmutador **Pasos | Oficina** del pipeline muestra la misma oficina solo con ese flujo; ese panel se ensancha arrastrando su borde derecho (doble clic lo restablece) y, a partir de unos 540 px, la oficina coloca las salas al lado de las mesas. Para verla moverse sin gastar tokens, la skill `/try-fake` (o `NEXURA_CLAUDE_BIN=fixtures/fake-claude.mjs FAKE_SUBAGENTS=1 FAKE_DELAY_MS=2000` más `FAKE_STATE_DIR`).
- **Depuración**: en el paso que falló, reintentar (editando prompt, modelo o esfuerzo), continuar su sesión de Claude con una instrucción, o saltarlo. En modo paso a paso, se para antes de cada paso para revisar o editar el prompt.
- **Cuota**: medidor en vivo de las ventanas de 5 h y 7 días del plan.
- **Terminal embebida** (xterm.js + PTY): botón *Terminal* abre PowerShell en el worktree del flujo; *Abrir en Claude* reanuda la sesión de un paso (`claude --resume`) para seguir hablando con él a mano. Nexura marca como confiables solo sus worktrees (`*.worktrees/nexura-*`) en `~/.claude.json` y quita la marca al borrarlos; desactívalo con `NEXURA_TRUST_WORKTREES=0`.
- **Terminal** (pestaña de la cabecera): trabaja con Claude Code, Codex o Copilot en tus proyectos como en tu terminal, sin salir de Nexura. Es el CLI interactivo de verdad (su TUI, con sus comandos `/`, Shift+Tab, permisos…) en un PTY del servidor, así que sigue vivo aunque cambies de sección o recargues la página; al volver se repinta la pantalla.
  - **Conversaciones**: tantas como quieras, agrupadas por proyecto (un repo de Configuración o cualquier carpeta), con búsqueda, filtro por proyecto, fijar arriba, renombrar y borrar. El título lo pone el agente (el *ai-title* de Claude, el nombre del hilo de Codex o el primer mensaje) hasta que lo renombras. También puede ser un PowerShell en el proyecto (botón *⌨ Shell*).
  - **Agente, modelo, esfuerzo y modo** en la barra: modo *Por defecto* (tu configuración), *Plan*, *Aceptar ediciones*, *Auto* o *Sin permisos*, traducidos a los flags de cada CLI (el comando exacto se ve debajo). Cambiar modelo, esfuerzo o modo reinicia el CLI **en la misma sesión**; dentro de Claude y Copilot, Shift+Tab cambia el modo sin reiniciar.
  - **Cambiar de agente sin perder la conversación**: Nexura lee la transcripción que guarda cada CLI (`~/.claude/projects`, `~/.codex/sessions`, `~/.copilot/session-state`; respeta `CLAUDE_CONFIG_DIR`, `CODEX_HOME` y `COPILOT_HOME`), escribe el historial en `data/conversations/<id>/handoff-<n>.md` y abre el nuevo agente pidiéndole que lo lea y siga, con un mensaje tuyo opcional. Si vuelves a un agente que ya estuvo, se reabre **su** sesión y solo recibe lo que hicieron los otros desde entonces. *Sin historial* empieza de cero. Las sesiones no se convierten de un CLI a otro: el nuevo agente lee el historial (texto y un resumen de las herramientas usadas), así que gasta algo de contexto al empezar.
  - **Historial**: la conversación como texto, con todos los agentes por los que ha pasado (sin tokens), copiable como Markdown. **Bifurcar** crea otra conversación que parte de ese historial, con el agente que elijas.
  - Parar, reanudar (la misma sesión) o empezar una sesión nueva. Al reiniciar el servidor las conversaciones quedan paradas y se reanudan con un clic. Atajos: Shift+Enter nueva línea, Ctrl+C con selección copia, Ctrl+V pega.
  - Codex elige su propio id de sesión: Nexura lo encuentra en su `sessions/` (el primer rollout de esa carpeta desde que arrancó). Claude y Copilot reciben el id de Nexura (`--session-id`).
- **Configuración** (⚙): editor de perfiles (pasos, modelo, esfuerzo, vueltas; duplicar/borrar), de pasos (plantilla del prompt con sus variables, `--tools` con Skills y Subagentes, permitidas/prohibidas, timeout, servidores MCP del repo) y de repos (ruta, rama base, prefijo, checks, node_modules). Todo se guarda en `config/`; desde el panel de depuración de un paso hay un enlace directo a su plantilla.

## Métricas y ajuste

- **Métricas** (pestaña de la cabecera): flujos, % que terminan bien, coste total y medio, tokens y vueltas review/QA→implement; tabla por paso y modelo (ejecuciones, fallos, turnos, coste medio y total), por perfil y coste por día. Todo sale de SQLite, sin tokens.
- **Presupuesto por perfil** (`budgetUsd`, editable en Configuración): antes de cada paso con Claude se calcula lo que queda y se pasa como `--max-budget-usd`; si ya no queda, el paso falla con un mensaje claro. En plan Pro el coste es nominal, pero sirve de tope proporcional a la cuota.
- **Clasificador**: en los flujos automáticos puedes marcar si `classify` acertó el perfil (y cuál debía ser). Las métricas muestran el % de acierto y los fallos con el motivo que dio, para ajustar su plantilla.
- **`qaNotes`** (activo en `full`, haiku): plan de pruebas manual a partir del ticket y el diff; se ve en el panel derecho del flujo.

## Cuota, conocimiento del repo y avisos

- **Cuota**: el uso de las ventanas de 5 h y 7 días llega en cada llamada a Claude (`rate_limit_event`). No hay forma gratuita de consultarlo aparte (`/usage` en modo `-p` se lo manda al modelo y gasta), así que entre flujos el medidor indica la antigüedad del dato, cuenta hasta el reinicio y pone la ventana a 0 % cuando se reinicia. Incluye todo tu uso de Claude, no solo el de Nexura. Con el **umbral** (Configuración → General, por defecto 90 %) no se lanzan pasos nuevos con Claude hasta el reinicio.
- **Conocimiento del repo**: cada paso recibe `{{repoMap}}` (mapa de carpetas y scripts sacado de `git ls-files`, gratis y cacheado por commit) y `{{repoNotes}}` (convenciones que enrich descubrió en tickets anteriores, guardadas en `data/repo-notes/<repo>.md` y editables en Configuración → Repos). enrich ya no relee `CLAUDE.md`: Claude Code lo carga solo.
- **Memoria compartida** (idea de [engram](https://github.com/Gentleman-Programming/engram), hecha con `node:sqlite` + FTS5, sin dependencias): observaciones (decisiones, causas raíz, convenciones, resúmenes de tickets) por proyecto en `data/memory.sqlite`. El proyecto es el nombre del repo en su remote `origin`, así que todos sus worktrees y clones comparten memoria. Se apaga en Configuración → General; apagada, todo sigue con `{{repoNotes}}`.
  - Cada paso tiene un modo de memoria (`off`, `read` o `readwrite`, en `step.json` y en el editor del paso). Por defecto enrich y plan leen, e implement, codeReview y addressReview además guardan.
  - Los pasos con memoria reciben `{{memory}}`: lo relacionado con el ticket (búsqueda por su título) y lo último del repo. Nexura lo lee una vez por flujo, así que no gasta turnos.
  - También reciben el servidor MCP de Nexura (`apps/server/src/memory/mcp-server.ts`: `mem_search`, `mem_get`, `mem_context` y, en `readwrite`, `mem_save`), atado al proyecto, al paso y al flujo, y el protocolo de `config/memory/*.md` como system prompt.
  - Guardar con un `topic_key` que ya existe actualiza esa observación en vez de duplicarla. Nexura guarda sin tokens las convenciones de enrich (`conventions/<slug>`) y, al acabar, un resumen del ticket (`tickets/<id>`).
  - En Configuración → Memoria se consulta, se busca y se borra. Ahí está también el `claude mcp add ...` para dar la misma memoria a tu Claude Code interactivo.
- **Vigilancia de PRs**: cada `prPollSeconds` (por defecto 120 s) se revisan por REST, gratis, las PRs abiertas de los flujos terminados. Si llegan comentarios avisa y marca la pestaña con 💬N; nunca lanza Claude solo. Deja de vigilar cuando la PR se completa o se abandona.
- **Avisos**: toasts dentro de la app cuando un flujo termina, falla, se pausa o espera tu aprobación, y notificaciones del sistema (🔔 en la cabecera) cuando la pestaña no está delante. El título de la pestaña muestra `(n)` con los flujos que te esperan.

## Azure DevOps y GitHub

Los tickets pueden ser **work items de Azure DevOps** o **issues de GitHub**, y las PRs se abren donde esté el remote `origin` de cada repo (`dev.azure.com` o `github.com`). Todo va por REST (y GraphQL en GitHub), sin PAT y sin gastar tokens de Claude:

- **Azure DevOps**: sesión de **Azure CLI** (`az login`), la misma que el plugin `azure-devops`: Nexura pide un token con `az account get-access-token`. La organización y el proyecto salen del remote (`NEXURA_AZURE_ORG` / `NEXURA_AZURE_PROJECT` como alternativa).
- **GitHub**: sesión de **GitHub CLI** (`gh auth login`), la misma que el servidor MCP `github`: Nexura usa `gh auth token` (o `GH_TOKEN` / `GITHUB_TOKEN` si están definidas). El `owner/repo` sale del remote (`NEXURA_GITHUB_REPO=owner/repo` como alternativa, p. ej. código en Azure e issues en GitHub).

Lo que se puede hacer:

- **Cargar ticket**: en *Nuevo flujo*, elige el origen (**Azure DevOps | GitHub**; por defecto el del remote del primer repo marcado), escribe el ID o *Elegir de la lista* y *Cargar*. Un work item trae título, descripción, criterios de aceptación (o pasos de reproducción de un bug), últimos comentarios y tareas hijas como checkboxes. Un issue trae título, cuerpo, etiquetas, últimos comentarios y sub-issues como checkboxes. La lista de GitHub muestra los issues abiertos del repo (*Asignados a mí* o *Todo el repo*), sin las PRs.
- **PR**: con *Crear PR*, `release` prepara el borrador (título del commit principal, descripción a partir de lo que hizo implement) y **se pausa**. Nada se sube hasta *Aprobar: push + crear PR*; *Dejar en local* termina sin push. El ticket se enlaza al crear la PR, nunca en el cuerpo editable, y solo si es del mismo proveedor que la PR: en Azure como work item enlazado; en GitHub añadiendo `Closes #n` (o `Closes owner/repo#n` si el issue es de otro repo), así que el issue se cierra al hacer merge.
- **Comentarios de la PR**: *Comprobar comentarios* lee los hilos activos (gratis): en Azure los hilos activos; en GitHub los hilos de revisión sin resolver (los comentarios generales de la conversación no tienen estado de resuelto y no se siguen). *Atender comentarios* lanza `addressReview` (Claude): corrige, hace commit en local y redacta una respuesta por hilo (`fixed` / `answered` / `wontFix`). Se pausa para aprobar: al aprobar hace push, publica las respuestas marcadas y resuelve los hilos arreglados (en GitHub, `wontFix` también resuelve el hilo). Las respuestas a hilos que no existen se descartan.
- **Vigilancia**: la de PRs funciona igual en los dos; en GitHub una PR mergeada cuenta como completada y una cerrada sin merge como abandonada.

## Agentes: Claude Code, Codex y Copilot

Cada paso con LLM de un perfil elige **agente** y **modelo** (Configuración → Perfiles), y un mismo flujo puede mezclarlos: por ejemplo plan con Claude opus, implement con Codex `gpt-5-codex` y codeReview con Claude. En la revisión doble ciega, el **juez B** puede ir con otro agente o modelo que el juez A, así que lo que vuelve a implement lo confirman dos modelos distintos. El modelo es texto libre (cualquier id que acepte ese CLI). La lista solo sugiere. Al reintentar un paso fallido también se puede cambiar de agente; como las sesiones de un agente no sirven a otro, el paso empieza de cero.

- **Claude Code**: `claude -p` (ver abajo).
- **Codex**: `codex exec --json` con tu plan de ChatGPT (`npm install -g @openai/codex` y `codex login`). El prompt va por stdin y la respuesta estructurada llega con `--output-schema`: Nexura pasa el schema del paso en modo estricto, con los campos opcionales como nullable. Codex no tiene lista de herramientas: los pasos que editan corren con `--sandbox workspace-write` (solo el worktree y sin red, así que tampoco puede hacer push ni commits en el `.git` del repo) y el resto con `read-only`.
- **Copilot**: `copilot -p --output-format json` con tu plan de GitHub Copilot (`winget install GitHub.Copilot` o `npm install -g @github/copilot`, y `copilot login`), que da acceso a modelos de Claude, GPT y Gemini (con `gpt-5-mini` no gasta peticiones premium). Los permisos del paso se traducen a `--allow-tool` / `--deny-tool` (`Bash(git diff*)` → `shell(git diff:*)`, `Edit` → `write`…), el esfuerzo a `--reasoning-effort`, y siempre se desactiva el MCP de GitHub que trae de serie (los MCP del paso llegan explícitos). Copilot no admite schema, así que el prompt pide terminar con un bloque ```json y Nexura lo valida contra el schema del paso. Los tokens salen de `--usage-output-file` y las peticiones premium se anotan en el paso. Los prompts largos van en un fichero temporal.

| | Claude Code | Codex | Copilot |
|---|---|---|---|
| Salida estructurada | `--json-schema` | `--output-schema` (estricto) | bloque JSON validado por Nexura |
| Permisos | `--tools` + allow/deny | sandbox read-only / workspace-write | `--allow-tool` / `--deny-tool` |
| Memoria compartida (MCP) | ✅ | ✅ (`-c mcp_servers…`) | ✅ (`--additional-mcp-config`) |
| Coste en USD, presupuesto y pausa por cuota | ✅ | — (solo tokens) | — (solo tokens) |
| Mensajes a mitad de paso | ✅ | — | — |
| Reanudar sesión (reintento y terminal) | ✅ | ✅ | ✅ |

En Configuración → General se ve qué CLIs están instalados (con `--version`, sin gastar tokens). Para usar otro binario están `NEXURA_CLAUDE_BIN`, `NEXURA_CODEX_BIN` y `NEXURA_COPILOT_BIN`. Si Codex o Copilot devuelven un límite de uso, el paso falla con ese aviso y sin espera automática: Nexura no conoce sus ventanas. El adaptador de Copilot está comprobado con el CLI real (1.0.88; grabaciones en `fixtures/stream/0[89]-copilot-*`); el de Codex está escrito a partir de su documentación y probado con un CLI falso (`fixtures/fake-codex.mjs`). Si un CLI real cambia su formato de salida, lo desconocido queda como evento `unknown` y la línea cruda se conserva en el log.

## Cómo funciona cada paso

- Cada paso de tipo `claude` con el agente Claude lanza `claude -p` en el worktree con **`--tools`** (lista dura), `--permission-mode dontAsk`, `--strict-mcp-config` y `--json-schema` para que devuelva JSON validado.
- **Config de Claude del repo**: el paso hereda lo que tendría `claude` abierto en ese repo, sin copiar nada a Nexura. El worktree trae lo commiteado (`CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.claude/settings.json` con sus plugins y hooks) y Nexura le copia lo local que no está en git (`.claude/settings.local.json`, `CLAUDE.local.md`, un `.mcp.json` sin commitear; nunca se commitean) y, en `~/.claude.json`, las aprobaciones de MCP del repo. Cada paso decide qué usa:
  - **Skills y subagentes**: `Skill` y `Agent` en Herramientas. Sirven las del proyecto, las de usuario y las de los plugins activos. Por defecto `Skill` en enrich, plan, implement, codeReview y addressReview, y `Agent` en implement, codeReview y addressReview (cada subagente es otra conversación con su propio coste).
  - **MCP**: `mcpServers` del paso, por nombre, o `*` para todos los activos del repo (por defecto `*` en enrich, plan, implement, codeReview y addressReview, así que cada proyecto aporta los suyos; ninguno en classify, qaNotes y los pasos propios nuevos. Un nombre que el repo no tenga se omite con una nota en el timeline) (los de `.mcp.json` necesitan estar aprobados; nombrado, un servidor entra aunque no lo esté). Se resuelven en cada flujo contra el repo principal, con la precedencia de Claude (local > proyecto > usuario > plugin), y entran preaprobados (`mcp__<nombre>`). Claude los recibe en un fichero temporal, Codex con `-c mcp_servers…` (sigue cargando su `~/.codex/config.toml`) y Copilot con `--additional-mcp-config`. El servidor de memoria lo pone siempre Nexura.
  - En Configuración → Repos, *Config de Claude del repo* muestra qué skills, subagentes y MCP ve Nexura en cada repo y de dónde salen; el editor de pasos sugiere esos MCP.
- `implement` no hace commit: lo hace el orquestador con el `commitMessage` que devuelve (sin trailers de IA).
- **Revisión doble ciega** (`reviewMode: "blind"` del perfil, activa en `full`): `codeReview` lo ejecutan dos jueces (A y B) en serie, con el mismo prompt y sesiones nuevas, así que ninguno ve la respuesta del otro (B solo lee la memoria). Solo vuelven a `implement` las issues `blocker`/`major` que ambos marcan en el mismo fichero; lo que marca un solo juez se descarta (queda en el libro de tareas y en un evento del paso) y las `minor` se ignoran. Duplica el coste de `codeReview`, pero evita gastar vueltas en falsos positivos. Agotar `maxLoops` equivale a un veredicto *escalado*.
- `codeReview` → `changes` o `qaCode` → fallo devuelven el trabajo a `implement` con el feedback, hasta `maxLoops` del perfil.
- `qaCode` y `release` son **builtin** (0 tokens): ejecutan los `checks` del repo (+ comandos `npm run ...` del plan) y registran rama/SHA. Push y PR llegan en la fase 5.
- Si salta el límite de uso, el run pasa a `waiting-rate-limit` y se reanuda solo cuando se libera la ventana.
