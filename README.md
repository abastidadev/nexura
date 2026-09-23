# Nexura <sub>by abastidadev</sub>

IDE local para orquestar flujos de Claude Code (`claude -p` en modo headless) que resuelven tickets de Azure DevOps paso a paso: enrich → plan → implement → review → qa → release. Muestra en qué paso va cada flujo, lo que consume y los errores, y permite depurar y corregir el paso exacto que falló.

- Plan completo: [docs/plan.md](docs/plan.md)
- Idea original: [docs/idea-original.md](docs/idea-original.md)
- Hallazgos de la fase 0: [docs/spike-findings.md](docs/spike-findings.md)

## Estado

| Fase | Estado |
|---|---|
| 0. Spike del CLI | ✅ hecho |
| 1. Núcleo backend | 🟡 en curso: tipos compartidos, runner y parser del stream (con tests) |
| 2. UI base | ⏳ |
| 3. Depuración | ⏳ |
| 4. Perfiles y `classify` | ⏳ |
| 5. Azure DevOps | ⏳ |
| 6. Métricas | ⏳ |

## Estructura

```
packages/shared/   tipos: eventos normalizados, perfiles, Run/StepRun
apps/server/       runner de claude -p, orquestador, API (en curso)
apps/web/          UI Angular (fase 2)
config/            perfiles y definición de pasos (fase 1)
fixtures/stream/   salidas reales de stream-json para los tests
```

## Comandos

```bash
npm install
npm test          # vitest con los fixtures reales (no gasta tokens)
npm run typecheck
npm run spike     # vuelve a grabar los fixtures (gasta un poco de cuota, haiku/low)
```
