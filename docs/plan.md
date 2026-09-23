# Plan — "Nexura by abastidadev": IDE local para orquestar flujos de Claude Code

## Contexto
Quieres un sistema que resuelva tickets de Azure DevOps de forma autónoma encadenando pasos de `claude -p ... --output-format stream-json --verbose` (enrich → plan → implement → review → qa → release…), diseñado para el **plan Pro** (ahorro de tokens, perfiles minimal/standard/full, modo auto con `classify`). Encima de eso quieres una **UI tipo IDE** donde:
- eliges flujo/perfil (manual, automático o uno nuevo),
- marcas con checkboxes los **repos** y las **tareas** a tratar junto al **prompt**,
- ves en vivo en qué paso va, qué consume (coste, tokens, turnos), respuestas, tool calls y errores,
- lanzas **varios flujos a la vez** (tabs),
- cuando algo falla ves **exactamente en qué paso** y puedes depurarlo y corregir la pieza (prompt/config/paso), no el output.

Decisiones tomadas contigo: **app web local** (Node/TS + Angular), **git worktree por flujo**, **allowlist de herramientas por paso**.

Proyecto nuevo **Nexura** (marca: "Nexura by abastidadev", visible en el header y en la pantalla de inicio de la UI) en **`C:\SCB-Development\nexura`** (repo git propio, independiente de AgsAngularComponentLib). Paquetes npm con scope `@nexura/*` (`@nexura/shared`, `@nexura/server`, `@nexura/web`) y CLI `nexura` (p. ej. `nexura run --ticket 1234 --profile minimal`).

Comprobado en tu máquina: Claude Code 2.1.280, Node 24.21. El CLI ya soporta lo que necesitamos: `--model`, `--effort`, `--json-schema` (salida estructurada forzada), `--session-id` / `--resume` / `--fork-session` (depurar reanudando), `--allowedTools` / `--disallowedTools`, `--permission-mode`, `--add-dir` (multi-repo), `--max-budget-usd`, `--append-system-prompt`, `--include-partial-messages`.

---

## Arquitectura

```
nexura/
  package.json            (npm workspaces)
  packages/shared/        tipos compartidos: eventos stream-json, Run, StepRun, FlowProfile, WS messages
  apps/server/            Node 24 + TS (Fastify + WebSocket)
    src/runner/           ClaudeProcess: spawn + parser JSONL + kill/timeout
    src/orchestrator/     máquina de estados del flujo, routing, cola de concurrencia
    src/workspace/        gestión de git worktrees por run/repo
    src/ledger/           "libro de tareas" (resúmenes + SHAs) por run
    src/store/            persistencia (node:sqlite, sin dependencias nativas) + logs JSONL crudos
    src/azure/            lectura de work items (REST + PAT) — opcional, fase 5
    src/terminal/         PTY para la terminal embebida (@lydell/node-pty, con prebuilds Windows)
    src/api/              REST (runs, profiles, repos) + WS (eventos en vivo)
  apps/web/               Angular 22 + Tailwind v4 (signals, standalone, OnPush — mismas convenciones que ya usas)
  config/
    profiles/*.json       minimal / standard / full / custom (versionados)
    steps/<step>/prompt.md       plantilla del prompt de cada paso
    steps/<step>/schema.json     JSON Schema de su salida (--json-schema)
    steps/<step>/step.json       tools permitidas, modelo/esfuerzo por defecto, timeouts
    repos.json            repos conocidos (nombre, ruta local, rama base, comandos de check)
  data/                   (gitignored) sqlite + runs/<runId>/{steps/*.jsonl, ledger.md, prompts/*}
```

### Conceptos
- **Run**: ticket + repos seleccionados + tareas seleccionadas + prompt extra + perfil. Estado: `queued | running | paused | waiting-rate-limit | failed | done | cancelled`.
- **StepRun**: una ejecución de un paso = un proceso `claude -p`. Guarda: prompt final renderizado, flags usados, `session_id`, todos los eventos, salida estructurada, `total_cost_usd`, `usage` (tokens), `num_turns`, duración, intento nº, error.
- **FlowProfile**: el tipo del documento (`Record<StepName, {model, effort, enabled}>`) ampliado con `maxLoops` (reintentos review→implement / qa→implement) y `budgetUsd` opcional.
- **Ledger**: fichero por run con lo que hizo cada paso + SHA de commit. Cada paso recibe el ledger + la salida estructurada de los pasos previos en vez de re-investigar (ahorro de tokens).

### Runner (pieza central)
`ClaudeProcess.start({cwd, prompt, model, effort, allowedTools, addDirs, jsonSchema, sessionId, resume})`
- `spawn("claude", ["-p", prompt, "--output-format","stream-json","--verbose", ...])` con `cwd` = worktree del repo principal; el prompt se pasa por stdin para evitar límites/escapes de la línea de comandos en Windows.
- Parser línea a línea → eventos tipados (`system/init`, `assistant` texto/`tool_use`, `user/tool_result`, `result`). Cada evento se persiste en JSONL y se emite por WS.
- Detecta: `is_error`, `subtype` de error del `result`, salida no válida contra el schema, exit code ≠ 0, timeout, y **límite de uso** (→ estado `waiting-rate-limit`, no fallo; reanuda cuando se libera).
- Como `cwd` es el repo, se cargan sus `.claude` plugins/skills: los pasos `release` y `addressReview` invocan `/azure-devops:create-pr` y `/azure-devops:address-pr-feedback` dentro del prompt.

### Orquestador
- Cola global con **concurrencia configurable (por defecto 2)** — con plan Pro no tiene sentido más.
- Máquina de estados por run: ejecuta los pasos `enabled` del perfil en orden; cada paso devuelve JSON (vía `--json-schema`) con un campo de decisión que el código usa para enrutar:
  - `codeReview` → `{verdict: "approve" | "changes", issues[]}` → si `changes`, vuelve a `implement` con los issues (máx `maxLoops`).
  - `qaCode` → `{passed, failures[]}` → igual.
  - `classify` → `{profile, reason}` → fija el perfil del resto del run (override manual siempre posible desde la UI).
- **Breakpoints**: modo "paso a paso" que pausa antes de cada paso para revisar/editar el prompt.
- Allowlist por paso (`step.json`): p.ej. `codeReview` sin `Edit/Write`, `enrich` solo lectura + MCP Azure, `implement` con `Edit/Write/Bash(npm *)/Bash(git *)`.

### Worktrees
Por cada run y repo seleccionado: `git worktree add <repo>.worktrees/flow-<runId> -b <type>/<ticket>-<slug>` desde la rama base de `repos.json`. Primer repo = `cwd`, resto por `--add-dir`. Limpieza al cancelar o tras `release` (configurable).

---

## UI (Angular)

1. **Barra de tabs** arriba: un tab por run abierto (icono de estado + coste acumulado), más "+ Nuevo flujo".
2. **Nuevo flujo** (formulario):
   - ID de ticket (o texto libre) → botón "cargar" que trae título/descripción/criterios/tareas hijas.
   - **Checkboxes de repositorios** (de `repos.json`).
   - **Checkboxes de tareas** (hijas del work item o escritas a mano; se pueden añadir/quitar).
   - Textarea de **prompt** adicional.
   - **Perfil**: `Automático (classify)` / minimal / standard / full / custom, con vista previa de pasos y modelo/esfuerzo; botón "Crear perfil nuevo".
   - Opciones: paso a paso (breakpoints), presupuesto máx.
3. **Vista del run** (layout IDE):
   - Izquierda: **pipeline de pasos** (stepper vertical) con estado, modelo/esfuerzo, coste, tokens, turnos, duración, nº de intento y bucles de vuelta. El paso fallido en rojo.
   - Centro: **timeline de eventos** del paso seleccionado: texto del asistente, tool calls plegables (input/resultado), errores resaltados, salida estructurada final. Pestañas: *Eventos* · *Prompt renderizado* · *Salida JSON* · *Raw JSONL*.
   - Derecha: **checklist de tareas** que se va marcando en vivo, repos/worktrees/ramas, **ledger**, totales de coste.
   - Abajo: **terminal embebida** (xterm.js + PTY).
4. **Depuración de un paso fallido** (acciones sobre el paso):
   - *Reintentar* tal cual.
   - *Editar prompt y reintentar* (opción: "guardar el cambio en la plantilla del paso" → corrección única del sistema, pilar 2).
   - *Cambiar modelo/esfuerzo y reintentar*.
   - *Continuar la sesión* con una instrucción (`--resume <session_id>` o `--fork-session` para no ensuciar la original).
   - *Abrir en terminal*: lanza `claude --resume <session_id>` interactivo en la terminal embebida, en el worktree del run.
   - *Saltar paso* / *Reanudar flujo desde aquí*.
5. **Editor de perfiles** y **editor de pasos** (prompt.md, schema, tools) con historial en git.
6. **Métricas**: coste/tokens por paso, por perfil y por ticket; aciertos del `classify` (marcar si acertó) para ajustar heurísticas.

---

## Fases (poco a poco)

0. **Spike (½ día)**: script TS que lanza un `claude -p` real en Windows, guarda el stream como *fixtures* y valida `--json-schema`, `--resume`, `--allowedTools`, `--effort`, prompt por stdin y cómo se reporta el límite de uso.
1. **Núcleo backend**: runner + parser (tests con fixtures), orquestador con perfil `minimal` (enrich → implement → qaCode → release en modo "sin push"), worktrees, SQLite, ledger, API REST/WS. Usable ya desde el CLI `nexura run --ticket ... --profile minimal`.
2. **UI base**: tabs, formulario de nuevo flujo (checkboxes repos/tareas + prompt + perfil), vista del run con pipeline y timeline en vivo.
3. **Depuración**: reintentar/editar/resume/fork/saltar, breakpoints, terminal embebida.
4. **Perfiles**: editor, perfiles standard/full, paso `classify` (haiku, low) y routing review/qa → implement con `maxLoops`.
5. **Azure DevOps**: carga de ticket por REST (PAT en `.env`, cero tokens), `release` con `/azure-devops:create-pr`, `addressReview` con polling espaciado y tope de ejecuciones.
6. **Métricas y ajuste**: dashboard de coste, feedback del clasificador, `qaNotes`.

## Verificación
- Tests unitarios (vitest) del parser y del orquestador con fixtures reales del spike (sin gastar tokens), incluyendo casos de error, schema inválido y rate limit.
- E2E de la fase 1: run `minimal` sobre un repo de prueba (p.ej. `C:\SCB-Development\practice`) con un ticket falso: comprobar worktree creado, commits con SHA en el ledger, coste por paso registrado, limpieza.
- Forzar un fallo (prompt de `qaCode` con un comando que falla) y verificar que la UI marca el paso, muestra el error y que "editar y reintentar" / "resume" funcionan.
- Dos runs en paralelo sobre el mismo repo → worktrees distintos, sin interferencias.
- UI comprobada en navegador con Playwright (skill `browser:browser-check`).

## Pendiente (lo decidimos en marcha)
- Umbrales de heurística de `classify`.
- Si `release` hace push/PR real o se queda en rama local hasta confirmar (propuesta: confirmación manual al principio).
