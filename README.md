# Nexura <sub>by abastidadev</sub>

IDE local para orquestar flujos de Claude Code (`claude -p` en modo headless) que resuelven tickets de Azure DevOps paso a paso: enrich → plan → implement → review → qa → release. Muestra en qué paso va cada flujo, lo que consume y los errores, y permite depurar y corregir el paso exacto que falló.

- Plan completo: [docs/plan.md](docs/plan.md)
- Idea original: [docs/idea-original.md](docs/idea-original.md)
- Hallazgos de la fase 0: [docs/spike-findings.md](docs/spike-findings.md)

## Estado

| Fase | Estado |
|---|---|
| 0. Spike del CLI | ✅ hecho |
| 1. Núcleo backend | ✅ hecho: runner, orquestador, worktrees, SQLite, ledger, API REST/WS, CLI |
| 2. UI base | ✅ hecho: tabs, nuevo flujo, pipeline, timeline en vivo, cuota, depuración básica |
| 3. Depuración | ✅ hecho: terminal embebida (shell y claude --resume), editor de perfiles, pasos y repos |
| 4. Perfiles y `classify` | ✅ hecho: perfiles editables, `classify`, presupuesto por perfil, valoración del clasificador |
| 5. Azure DevOps | ✅ hecho: cargar work item, PR con aprobación, atender comentarios de la PR |
| 6. Métricas | ✅ hecho: coste/tokens/fallos por paso, perfil y día; acierto de `classify`; `qaNotes` |

## Estructura

```
packages/shared/            tipos: eventos normalizados, perfiles, Run/StepRun, mensajes WS
apps/server/src/
  runner/                   ClaudeProcess (spawn claude.exe, prompt por stdin) + parser stream-json
  orchestrator/             secuencia de pasos, vuelta a implement, reintentos, breakpoints, rate limit
                            builtin-steps: qaCode (checks del repo) y release local, sin tokens
  workspace/                git worktree por run y repo, junction de node_modules, commits
  store/                    SQLite (node:sqlite) + JSONL crudo por paso en data/runs/<id>/steps
  ledger/                   libro de tareas por run (data/runs/<id>/ledger.md)
  api/                      REST + WebSocket (/ws eventos, /pty terminales) en :4310
  terminal/                 PTY (@lydell/node-pty, binarios precompilados) para la terminal embebida
  cli/                      comando nexura
apps/web/                   UI Angular 22 + Tailwind v4 (tabs, nuevo flujo, vista del flujo)
config/profiles/*.json      minimal / standard / full
config/steps/<paso>/        step.json (tools, allowlist, timeout) · prompt.md · schema.json
config/repos.json           tus repos (local, gitignored; ver repos.example.json)
fixtures/                   stream-json reales + fake-claude.mjs para tests sin tokens
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
npm run build:web && npm run serve       # UI + API en http://localhost:4310
npm run dev:web                          # UI en desarrollo en :4300 (proxy a la API de :4310)

npm test          # parser + orquestador con claude falso (no gasta tokens)
npm run typecheck
npm run spike     # vuelve a grabar los fixtures reales (gasta un poco de cuota)
```

## La UI

- **Pestañas**: cada flujo abierto es una pestaña con su estado y coste; puedes tener varios corriendo a la vez.
- **Nuevo flujo**: ticket, tareas con checkbox (se extraen de las viñetas del ticket), repos con checkbox, prompt adicional, perfil (automático o uno concreto) y modo *paso a paso*.
- **Vista del flujo**: pipeline de pasos (con reintentos y vueltas), timeline en vivo de cada paso (texto, herramientas con entrada/resultado, errores en rojo, resultado con coste/tokens/turnos), prompt renderizado, salida JSON, log crudo y el comando exacto. A la derecha: tareas que se van marcando, ramas/worktrees y el libro de tareas.
- **Depuración**: en el paso que falló, reintentar (editando prompt, modelo o esfuerzo), continuar su sesión de Claude con una instrucción, o saltarlo. En modo paso a paso, se para antes de cada paso para revisar o editar el prompt.
- **Cuota**: medidor en vivo de las ventanas de 5 h y 7 días del plan.
- **Terminal embebida** (xterm.js + PTY): botón *Terminal* abre PowerShell en el worktree del flujo; *Abrir en Claude* reanuda la sesión de un paso (`claude --resume`) para seguir hablando con él a mano. Nexura marca como confiables solo sus worktrees (`*.worktrees/nexura-*`) en `~/.claude.json` y quita la marca al borrarlos; desactívalo con `NEXURA_TRUST_WORKTREES=0`.
- **Configuración** (⚙): editor de perfiles (pasos, modelo, esfuerzo, vueltas; duplicar/borrar), de pasos (plantilla del prompt con sus variables, `--tools`, permitidas/prohibidas, timeout, MCP) y de repos (ruta, rama base, prefijo, checks, node_modules). Todo se guarda en `config/`; desde el panel de depuración de un paso hay un enlace directo a su plantilla.

## Métricas y ajuste

- **Métricas** (pestaña de la cabecera): flujos, % que terminan bien, coste total y medio, tokens y vueltas review/QA→implement; tabla por paso y modelo (ejecuciones, fallos, turnos, coste medio y total), por perfil y coste por día. Todo sale de SQLite, sin tokens.
- **Presupuesto por perfil** (`budgetUsd`, editable en Configuración): antes de cada paso con Claude se calcula lo que queda y se pasa como `--max-budget-usd`; si ya no queda, el paso falla con un mensaje claro. En plan Pro el coste es nominal, pero sirve de tope proporcional a la cuota.
- **Clasificador**: en los flujos automáticos puedes marcar si `classify` acertó el perfil (y cuál debía ser). Las métricas muestran el % de acierto y los fallos con el motivo que dio, para ajustar su plantilla.
- **`qaNotes`** (activo en `full`, haiku): plan de pruebas manual a partir del ticket y el diff; se ve en el panel derecho del flujo.

## Cuota, conocimiento del repo y avisos

- **Cuota**: el uso de las ventanas de 5 h y 7 días llega en cada llamada a Claude (`rate_limit_event`). No hay forma gratuita de consultarlo aparte (`/usage` en modo `-p` se lo manda al modelo y gasta), así que entre flujos el medidor indica la antigüedad del dato, cuenta hasta el reinicio y pone la ventana a 0 % cuando se reinicia. Incluye todo tu uso de Claude, no solo el de Nexura. Con el **umbral** (Configuración → General, por defecto 90 %) no se lanzan pasos nuevos con Claude hasta el reinicio.
- **Conocimiento del repo**: cada paso recibe `{{repoMap}}` (mapa de carpetas y scripts sacado de `git ls-files`, gratis y cacheado por commit) y `{{repoNotes}}` (convenciones que enrich descubrió en tickets anteriores, guardadas en `data/repo-notes/<repo>.md` y editables en Configuración → Repos). enrich ya no relee `CLAUDE.md`: Claude Code lo carga solo.
- **Vigilancia de PRs**: cada `prPollSeconds` (por defecto 120 s) se revisan por REST, gratis, las PRs abiertas de los flujos terminados. Si llegan comentarios avisa y marca la pestaña con 💬N; nunca lanza Claude solo. Deja de vigilar cuando la PR se completa o se abandona.
- **Avisos**: toasts dentro de la app cuando un flujo termina, falla, se pausa o espera tu aprobación, y notificaciones del sistema (🔔 en la cabecera) cuando la pestaña no está delante. El título de la pestaña muestra `(n)` con los flujos que te esperan.

## Azure DevOps

Usa la sesión de **Azure CLI** (`az login`), la misma que el plugin `azure-devops`: Nexura pide un token con `az account get-access-token` y llama a la API REST. Sin PAT y sin gastar tokens de Claude. La organización y el proyecto salen del remote `origin` de cada repo (`NEXURA_AZURE_ORG` como alternativa).

- **Cargar work item**: en *Nuevo flujo*, el ID + *Cargar* trae título, descripción, criterios de aceptación (o pasos de reproducción de un bug), últimos comentarios y tareas hijas como checkboxes.
- **PR**: con *Crear PR en Azure DevOps*, `release` prepara el borrador (título del commit principal, descripción a partir de lo que hizo implement, work item enlazado al crear, nunca en el cuerpo) y **se pausa**. Nada se sube hasta *Aprobar: push + crear PR*; *Dejar en local* termina sin push.
- **Comentarios de la PR**: *Comprobar comentarios* lee los hilos activos (gratis). *Atender comentarios* lanza `addressReview` (Claude): corrige, hace commit en local y redacta una respuesta por hilo (`fixed` / `answered` / `wontFix`). Se pausa para aprobar: al aprobar hace push, publica las respuestas marcadas y resuelve los hilos arreglados. Las respuestas a hilos que no existen se descartan.

## Cómo funciona cada paso

- Cada paso de tipo `claude` lanza `claude -p` en el worktree con **`--tools`** (lista dura), `--permission-mode dontAsk`, `--strict-mcp-config` salvo que el paso pida MCP, y `--json-schema` para que devuelva JSON validado.
- `implement` no hace commit: lo hace el orquestador con el `commitMessage` que devuelve (sin trailers de IA).
- `codeReview` → `changes` o `qaCode` → fallo devuelven el trabajo a `implement` con el feedback, hasta `maxLoops` del perfil.
- `qaCode` y `release` son **builtin** (0 tokens): ejecutan los `checks` del repo (+ comandos `npm run ...` del plan) y registran rama/SHA. Push y PR llegan en la fase 5.
- Si salta el límite de uso, el run pasa a `waiting-rate-limit` y se reanuda solo cuando se libera la ventana.
