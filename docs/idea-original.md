# Flujo de IA programático — resumen del proyecto

## Objetivo
Montar un sistema tipo IDE/consola que orqueste un flujo de agentes (Claude Code en modo headless) para resolver tickets de forma autónoma, inspirado en el vídeo de referencia, pero adaptado a mis restricciones reales:

- **Plan de Claude Code**: Pro ($20/mes), no el de $200/mes que usa el creador del vídeo en su empresa. Esto implica **límites de uso mucho más ajustados** (ventanas de 5h / 7 días), así que el diseño tiene que priorizar el **ahorro de tokens y llamadas**, no la máxima autonomía a cualquier coste.
- **Sistema de tickets/PRs**: Azure DevOps (no Linear + GitHub como en el vídeo).
- **Entorno**: portátil de empresa, Windows, PowerShell. Confirmado que `claude -p` funciona en modo headless con `--output-format stream-json --verbose` sin restricciones de seguridad bloqueantes.
- El repo ya tiene un setup de Claude Code con plugins propios: `azure-devops`, `angular`, `core`, `browser`, `storybook`, `context7`, con slash commands ya construidos como `azure-devops:create-pr`, `azure-devops:address-pr-feedback`, `azure-devops:work-item`, `azure-devops:pipeline-failure`, `azure-devops:pr-mechanics`, `core:commit`, `code-review`, etc. — hay base de la que partir, no hace falta montar todo desde cero.

## Mecanismo base
```
claude -p "<prompt del paso>" --output-format stream-json --verbose
```
Un proceso externo (lenguaje da igual — Python, PowerShell, TS) lanza este comando por cada paso del flujo, lee el stdout línea a línea (JSON por evento: `system init`, `assistant` con texto o `tool_use`, `user` con `tool_result`, y al final `result` con `success`/coste/turnos), y decide con código cuándo pasar al siguiente paso o enrutar de vuelta a un paso anterior.

## Los tres pilares (del vídeo)
1. **Autonomía real**: yo doy el ticket + repos implicados, el sistema entrega el trabajo terminado y probado. No hay que estar respondiendo preguntas a mitad de camino — hay que invertir en buenos diseños de entrada para minimizar huecos de información.
2. **Corrección única de errores**: cada fallo se corrige iterando la pieza del sistema que lo causó (prompt, config, o descomposición del paso), no parcheando el output puntual.
3. **Modularidad y granularidad**: piezas pequeñas, una responsabilidad por agente. El que revisa no arregla, el que implementa no decide si está bien.

## Diferencia clave respecto al vídeo: control de coste
Con plan Pro ($20) el criterio "cuantos más pasos y más esfuerzo, mejor" no aplica. Hay que diseñar el flujo pensando en:

- **Pasos flexibles/opcionales**: el flujo no debe ser fijo de 8 pasos siempre. Según el tamaño/riesgo del ticket, decidir programáticamente qué pasos se saltan (p. ej. un ticket trivial no necesita `qa-notes` ni una `code-review` en `high`).
- **Modelo y esfuerzo ajustados por paso**, igual que en el vídeo, pero con más disciplina:
  - Pasos "mecánicos" (leer, resumir título de PR, formatear) → modelo barato (haiku o sonnet), esfuerzo `low`/`medium`.
  - Pasos que requieren juicio real (plan, code-review, decidir si un comentario de PR tiene razón) → modelo más caro, pero solo ahí.
- **Evitar re-ejecuciones completas**: cachear/reutilizar contexto entre pasos (el "libro de tareas" con SHA de commits) para no repetir investigación ya hecha.
- **Medir coste por paso desde el principio**: cada evento `result` del stream trae `total_cost_usd` y `num_turns` — loguearlo por paso para saber dónde se va el presupuesto y poder recortar ahí primero.
- **Empezar con un flujo mínimo** (quizás solo enrich → implement → qa-code → release) e ir añadiendo pasos según se demuestre que hacen falta, en vez de replicar los 8 pasos completos del vídeo desde el día uno.

## Pasos de referencia (adaptables, no fijos)
| Paso | Qué hace | Notas de coste |
|---|---|---|
| enrich | investiga el repo/ticket | modelo barato, esfuerzo medium |
| plan | decide plan + criterios de aceptación ejecutables | esfuerzo alto solo aquí si el ticket es complejo |
| implement | escribe código (subagentes por subtarea) | el que más gasta — vigilar nº de subagentes lanzados |
| code-review | revisa diff, sin permiso de escribir (`Write`/`Edit` quitados) | opcional según tamaño del PR |
| qa-code | ejecuta los criterios de aceptación como comandos | barato, determinista |
| release | crea la PR en Azure DevOps (usar `azure-devops:create-pr` ya existente) | modelo barato |
| qa-notes | genera plan de pruebas manual | opcional, saltar en tickets pequeños |
| address-review | responde/arregla comentarios de la PR (usar `azure-devops:address-pr-feedback`) | por polling, cuidado con el gasto si se deja corriendo mucho rato |

## Estado compartido
- "Libro de tareas": qué hizo cada subagente + SHA del commit, para dar coherencia sin tener que releer todo el contexto en cada paso.
- Log de coste/tokens por paso y por ticket, para poder auditar y recortar.

## Implementación: TypeScript

Orquestador en TS que hace `spawn` de `claude -p ... --output-format stream-json --verbose`, parsea el stream línea a línea (cada línea es un JSON: eventos `system`, `assistant`, `user`, `result`...) y controla el flujo con código normal (promesas, colas, lo que haga falta).

## Perfiles de flujo (configuración)

En vez de un flujo fijo de 8 pasos, definir **perfiles configurables** que combinan qué pasos se ejecutan y con qué modelo/esfuerzo cada uno:

```ts
type StepName = "enrich" | "plan" | "implement" | "codeReview"
  | "qaCode" | "release" | "qaNotes" | "addressReview";

type StepConfig = {
  model: "haiku" | "sonnet" | "opus";
  effort: "low" | "medium" | "high" | "xhigh";
  enabled: boolean;
};

type FlowProfile = {
  name: string;
  steps: Record<StepName, StepConfig>;
};
```

Perfiles de partida sugeridos:
- **minimal**: `enrich → implement → qaCode → release`, todo en modelo barato/esfuerzo bajo-medio. Para tickets pequeños (fix de estilos, cambio puntual).
- **standard**: añade `codeReview` y `addressReview`. Para features normales.
- **full**: los 8 pasos, esfuerzo alto donde corresponda (equivalente al flujo completo del vídeo). Reservado para tickets grandes o de riesgo.

Los perfiles se guardan como config (JSON/TS) versionada junto al proyecto, para poder iterarlos igual que se itera cualquier otra pieza del sistema (pilar 2: corrección única de errores — si un perfil se queda corto o se pasa de gasto, se ajusta el perfil, no se parchea el ticket a mano).

## Modo manual vs. modo automático

- **Manual**: se invoca el orquestador indicando el perfil explícitamente (p. ej. `--profile minimal`).
- **Automático**: un paso adicional `classify`, **siempre barato** (modelo económico, esfuerzo bajo — no tiene sentido gastar en decidir), que se ejecuta antes que nada:
  - Input: ticket + criterios de aceptación de Azure DevOps.
  - Output esperado (JSON forzado): `{ "profile": "minimal" | "standard" | "full", "reason": "..." }`
  - Heurísticas a darle en el prompt: nº aproximado de archivos que toca, si es solo estilos/copy vs. lógica de negocio, si el ticket menciona tests explícitos, tamaño/complejidad de la descripción, si toca componentes compartidos de la librería (`ags-*`) que afectan a más consumidores.
  - El resultado de `classify` decide qué `FlowProfile` carga el orquestador para el resto de la ejecución.
  - Guardar el `reason` en el log del ticket — permite auditar después si el clasificador acertó o no, y ajustar sus heurísticas (mismo principio de corrección única de errores aplicado al propio clasificador).

## Pendiente de decidir
- Umbrales exactos de las heurísticas del `classify` (cuándo es "minimal" vs "standard" vs "full").
- Si `classify` debe poder anular manualmente (override) cuando el usuario no está de acuerdo con el perfil elegido.
- Cómo integrar los slash commands de `azure-devops` ya existentes en el repo dentro del flujo programático (probablemente invocándolos como parte del prompt de cada paso).
