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
| 2. UI base | ⏳ |
| 3. Depuración | ⏳ |
| 4. Perfiles y `classify` | ⏳ |
| 5. Azure DevOps | ⏳ |
| 6. Métricas | ⏳ |

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
  api/                      REST + WebSocket (/ws) en :4310
  cli/                      comando nexura
apps/web/                   UI Angular (fase 2)
config/profiles/*.json      minimal / standard / full
config/steps/<paso>/        step.json (tools, allowlist, timeout) · prompt.md · schema.json
config/repos.json           tus repos (local, gitignored; ver repos.example.json)
fixtures/                   stream-json reales + fake-claude.mjs para tests sin tokens
```

## Uso

```bash
npm install
cp config/repos.example.json config/repos.json   # y ajusta rutas/checks

npm run nexura -- run --repo AgsAngularComponentLib --ticket-id 1234   --ticket "Título del ticket

Descripción..." --task "Subtarea 1" --profile auto
npm run nexura -- runs                   # lista
npm run nexura -- show <runId>           # detalle, paso fallido y su sesión
npm run nexura -- retry <runId> [--resume --instruction "..."] [--model opus] [--skip]
npm run nexura -- cleanup <runId> [--delete-branches]
npm run serve                            # API en http://localhost:4310

npm test          # parser + orquestador con claude falso (no gasta tokens)
npm run typecheck
npm run spike     # vuelve a grabar los fixtures reales (gasta un poco de cuota)
```

## Cómo funciona cada paso

- Cada paso de tipo `claude` lanza `claude -p` en el worktree con **`--tools`** (lista dura), `--permission-mode dontAsk`, `--strict-mcp-config` salvo que el paso pida MCP, y `--json-schema` para que devuelva JSON validado.
- `implement` no hace commit: lo hace el orquestador con el `commitMessage` que devuelve (sin trailers de IA).
- `codeReview` → `changes` o `qaCode` → fallo devuelven el trabajo a `implement` con el feedback, hasta `maxLoops` del perfil.
- `qaCode` y `release` son **builtin** (0 tokens): ejecutan los `checks` del repo (+ comandos `npm run ...` del plan) y registran rama/SHA. Push y PR llegan en la fase 5.
- Si salta el límite de uso, el run pasa a `waiting-rate-limit` y se reanuda solo cuando se libera la ventana.
