# Fase 0 — Hallazgos del spike (2026-09-23)

Claude Code 2.1.280 · Node 24.21 · Windows 11. Fixtures en `fixtures/stream/` (`npm run spike` los regenera).
Coste total del spike: ~0,10 USD nominales con haiku/low. Uso de la ventana de 5 h: 7 %.

| Caso | Resultado |
|---|---|
| 01 texto plano | OK. Eventos: `system/hook_*`, `system/init`, `assistant`, `rate_limit_event`, `result/success` |
| 02 `--json-schema` | OK. La respuesta llega en `result.structured_output`, ya validada (el CLI inyecta un turno sintético `[structured-output-enforce]` si hace falta) |
| 03 tool use | OK. `assistant.tool_use` ↔ `user.tool_result` enlazados por `tool_use_id` |
| 04 `--allowedTools Read` | **No restringe**: Bash se ejecutó igual porque los settings del usuario ya permiten `git status` |
| 05 `--resume <id>` | OK. Recuerda la conversación anterior → sirve para "continuar la sesión" al depurar |
| 06 `--tools Read --strict-mcp-config` | **Sí restringe**: `init.tools = ["Read"]`, Bash no existe |

## Decisiones que salen de aquí
- **Allowlist por paso = `--tools`** (lista dura de herramientas) + `--permission-mode dontAsk`. `--allowedTools` solo para reglas finas encima (p. ej. `Bash(npm run *)`), y `--disallowedTools` para prohibir siempre (`Bash(git push *)`).
- **`--strict-mcp-config` por defecto**: sin él cada paso carga los MCP del usuario (Claude Docs, etc.) y engorda el contexto. Solo los pasos que lo necesiten (`enrich`, `release`) activan MCP.
- **`rate_limit_event` trae la utilización de las ventanas de 5 h y 7 días** (`unifiedWindows.five_hour.utilization`, `resetsAt`). La UI mostrará un indicador de cuota en vivo y el orquestador puede pausar runs antes de agotarla.
- **`result` trae todo lo de métricas**: `total_cost_usd`, `num_turns`, `duration_ms`, `usage` (incluye `thinking_tokens` y cache), `permission_denials`, `terminal_reason`, `subagent_stats`.
- El coste de arranque de cada `claude -p` es ~10-25k tokens de cache (system prompt + herramientas + hooks). Con plan Pro compensa **pocos pasos más completos** antes que muchos pasos minúsculos.
- El hook `SessionStart` del usuario se ejecuta en cada paso (aparece como `system/hook_*`). Se muestra en el timeline y no bloquea.
- En Windows se lanza directamente `claude.exe` (el `.cmd` de npm pasa por cmd.exe y rompe el escapado) y el prompt va por **stdin**.
