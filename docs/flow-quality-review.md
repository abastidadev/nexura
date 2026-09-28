# Revisión de calidad y consumo — 27 septiembre 2026

Fuente: [comparación Nexura frente a Claude directo](https://claude.ai/artifact/J2t4cZrvMLTuCuM1y421WZ). Se ha leído el informe y contrastado el mecanismo del flujo con el código de Nexura. No se han vuelto a ejecutar las dos soluciones ni verificado independientemente sus PRs.

## Qué se puede concluir

La ejecución presentada favorece claramente al agente directo. Incluso el recorrido «limpio» estimado del informe consume más; corregir solo los incidentes no demuestra que Nexura vaya a ganar. Ese recorrido es un contrafactual, no una segunda ejecución medida.

La comparación cambia simultáneamente la arquitectura del flujo y el modelo de implementación, y tiene una sola muestra por variante. Sirve para detectar fallos, no para afirmar que un modelo sea siempre más barato ni que varios pasos siempre mejoren o empeoren la calidad. Las notas de un revisor LLM son una señal complementaria: los errores reproducibles de lint, Storybook y requisitos son evidencia más fuerte.

La variación de cuota incluye otra sesión; no permite calcular el coste exacto del subagente perdido. El coste registrado en una ejecución interrumpida no debe interpretarse como consumo completo.

Los tokens sí se recuperan: cada paso suma el `usage` de los mensajes `assistant` de su stream (agente principal y subagentes, una vez por mensaje). Lo que supera al informe final del CLI, o todo si el proceso muere sin él, se añade a `usage` y queda aparte en `unreportedUsage`, con un aviso en el paso. Es una cota inferior y no tiene precio: `costUsd` no lo incluye. Con este cálculo, el implement fallido de la comparación habría registrado 3,58 M tokens de lectura de caché y 150 k de escritura que se perdieron. En ejecuciones completas grabadas, la entrada y la caché observadas coinciden exactamente con el informe, así que no hay avisos falsos.

## Correcciones implementadas

- `plan.acceptanceCriteria` admite `repo` y `workdir`. Un script de `frontend/package.json` se expresa así:

  ```json
  { "description": "Storybook construye", "command": "npm run build-storybook", "repo": "nombre-del-repo", "workdir": "frontend" }
  ```

  Se comprueba el directorio real dentro del worktree, el manifiesto y la existencia del script antes de ejecutar los trabajos. Un comando del plan con repo, directorio o script incorrectos se omite con un aviso en el paso y en el libro de tareas (`configErrors` en la salida de QA) y nunca devuelve el trabajo a implementación; los checks configurados del repo y el resto de comandos válidos se ejecutan igualmente. Solo si no queda ningún comando ejecutable, QA falla como «sin verificar». Los planes antiguos usan el primer repo y `.`.
- Los comandos generados por el plan usan `npm run <script>` o `npm run <script> -- <argumentos>`. Para seleccionar paquetes se usan `repo`/`workdir`, no `--prefix`/`--workspace`. Los checks configurados por el usuario conservan su sintaxis shell y se ejecutan desde la raíz del worktree.
- QA sin ningún comando pasa a fallo explícito, no a éxito. Los fallos reales de los scripts siguen produciendo feedback de implementación.
- `implement` y `addressReview` dejan de ofrecer la herramienta `Agent`; se deniega `git worktree` y se prohíbe por prompt lanzar agentes o tareas en segundo plano. Se permite `node` para scripts de edición. Son controles del flujo, no un sandbox que impida cualquier proceso indirecto.
- Implementación debe comprobar sus cambios, reutilizar código existente y comunicar checks no verificados. Ya no se le pide conformarse con que compile. Plan y review distinguen compilar Angular de construir Storybook.
- Perfil experimental `focused`: `implement` con Opus medium → QA determinista → release. Sin pasos LLM separados de investigación, planificación o revisión. `autoSelect: false` exige selección manual y se conserva al guardar el perfil. La salida local o PR sigue dependiendo de la solicitud del usuario.

## Configuración necesaria antes de comparar

En Configuración → Repos, configurar los checks reales del repositorio objetivo. No se ha modificado `config/repos.json` ni el perfil local `optimo`.

Para un paquete situado en `frontend`, los checks configurados pueden usar `cd frontend && npm run <script-existente>`. Añadir lint, tests y build real de Storybook cuando correspondan, además de compilación y traducciones. Confirmar los nombres en el package.json del proyecto; Nexura no puede asumir que todos los repos tengan esos scripts. El nuevo `workdir` pertenece a los criterios del plan, no al formulario de repos.

`focused` necesita estos checks porque no genera un plan separado. Si faltan, QA detendrá el flujo después de implementación. No hay revisión independiente en este perfil: no es una recomendación automática para cambios de seguridad, migraciones o tareas de alto riesgo.

## Comparación siguiente

1. Usar varios tickets representativos, el mismo commit inicial, instrucciones, herramientas, modelo y esfuerzo. Primero comparar agente directo con `focused` para aislar el coste de Nexura; después cambiar un factor cada vez.
2. Repetir cada variante y evaluar sin conocer el origen de cada diff. Contar todas las ejecuciones, reintentos, intervenciones y fallos, incluidos los que no llegan a PR.
3. Registrar cumplimiento de requisitos, pruebas objetivas, defectos de revisión, tiempo total y tokens por categoría. No mezclar lectura de caché con generación como si tuvieran el mismo coste, ni atribuir toda una ventana de cuota a un flujo.
4. Añadir revisión independiente o planificación separada solo si reducen defectos o coste total en esas tareas. QA ya se ejecuta antes de codeReview para evitar revisar implementaciones que no superan los checks.

La hipótesis viable es que Nexura mejore aislamiento, seguimiento, verificaciones y recuperación manteniendo un agente competente como núcleo. No hay evidencia para prometer que un pipeline fijo con más agentes produzca siempre mejor código y consuma menos que ese mismo agente trabajando directamente.

## Optimización del flujo implementada

El orden base pasa a implementación → QA → revisión → release. Cada corrección vuelve a pasar QA antes de otra revisión. Si un paso personalizado posterior a QA hace cambios que Nexura comitea, se programa otra comprobación antes de continuar; esa comprobación extra sale de la secuencia en cuanto se ejecuta o se salta, así que en una vuelta posterior solo se repite si el paso vuelve a cambiar algo. Los perfiles que deshabilitan QA siguen respetando esa elección.

Las correcciones automáticas intentan continuar la última sesión de implementación del mismo flujo, solo si terminó bien y coinciden agente, modelo y esfuerzo. El nuevo mensaje contiene el feedback y el contrato de salida, sin reenviar ticket, plan, memoria y libro de tareas. Claude reanuda esa misma sesión; los otros adaptadores usan su reanudación existente. No se reutilizan sesiones de revisión.

La sesión compatible se reanuda en cada corrección permitida por `maxLoops`, aunque acumule más de 80 turnos, mientras su contexto real (entrada más caché de su última llamada, `contextMetrics.contextTokens`) no pase de `MAX_CONTEXT_TOKENS` (400.000, punto de partida a calibrar); por encima, la corrección o la fase siguiente empiezan sesión nueva con el ticket, el plan y el feedback. Una sesión fallida, ausente o incompatible provoca sesión nueva.

### Una sesión principal con contexto estable

- **Qué fases la comparten:** todos los pasos de trabajo (plan, implement, correcciones, addressReview y los pasos propios) continúan la misma sesión de Claude. classify, codeReview, prReview y qaNotes arrancan limpios.
- **enrich y plan son una sola fase:** plan investiga y decide, y guarda las convenciones nuevas que encuentra. Los perfiles de serie ya no llevan enrich; sigue disponible para perfiles propios.
- **Mismo envoltorio en todas las fases:** Claude cachea el prompt por prefijo (herramientas, system prompt y mensajes). Una fase que añada o quite una herramienta, un servidor MCP o el protocolo de memoria reescribe en la caché toda la conversación: en la comparación, la primera llamada tras cambiar de modelo escribió 117.288 tokens y leyó 0. Por eso todas las fases usan la unión de sus herramientas, `disallowedTools`, servidores MCP (`@auto` se resuelve una vez para todas) y el modo de memoria más amplio. Cada fase se limita con sus permisos: plan tiene Edit en su lista de herramientas, pero no en `--allowedTools`, y con `dontAsk` no puede usarlo; tampoco `mem_save`.
- **Continuar no reenvía lo que ya está en la conversación:** el prompt de la fase lleva sus instrucciones y los datos nuevos (resultado de QA, feedback de la revisión), sin el ticket, el mapa, las notas, la memoria ni las salidas de las fases que corrieron en esa sesión.
- **Se mide y se avisa:** cada paso guarda en `contextMetrics` el contexto real (`contextTokens`), la caché leída y escrita por su primera llamada y las huellas de herramientas (del `init` del CLI), schema de salida y system prompt. Si una continuación escribe la conversación en vez de leerla, el paso lo avisa y dice qué cambió.
- **Lo que sigue variando:** el modelo o el esfuerzo si el perfil los cambia entre fases, y el schema de salida de cada fase (`--json-schema`). Si el CLI lo envía como herramienta, cada cambio de fase perdería la caché; el aviso lo dirá con la primera ejecución real («Cambió: schema de salida»), y entonces convendría un schema único para la sesión. Un prompt de reintento explícito y `resumeSession: false` impiden la reanudación automática; la reanudación manual mantiene su comportamiento. Si el CLI rechaza una sesión que parecía válida, el paso falla visiblemente: no se paga otro intento automáticamente para ocultarlo.

El libro de tareas conserva todo en disco; el prompt recibe hasta 4.000 caracteres con la última entrada por paso, priorizando las recientes. El ticket, el plan y el feedback actual conservan sus secciones propias. La memoria se consulta antes de cada paso usando el ticket y el foco disponible (tareas, feedback o ficheros modificados); intercala resultados y elimina duplicados, sin añadir observaciones solo por ser recientes. Su inyección total queda limitada a 4.000 caracteres por paso. `mem_search`, `mem_get` y `mem_context` siguen disponibles según los permisos del paso. La revisión de código predeterminada solo lee memoria.

Los pasos principales usan `mcpServers: ["@auto"]`. Es una selección determinista y limitada a servidores conocidos que ya estén habilitados: Context7 para los pasos de código, Angular CLI si el contexto indica Angular y Playwright para implementación/respuesta a revisión si hay indicios de interfaz o navegador. No intenta adivinar la función de MCP personalizados. Se pueden añadir sus nombres en Configuración → Pasos, que avisa de qué servidores de tus repos deja fuera `@auto` (en AgsConectaWeb, `dxdocs`, `chrome-devtools` y `azure-devops`); las selecciones explícitas se conservan y `*` sigue cargando todos los activos. La lista de candidatos (`AUTO_MCP_SERVERS`) vive en `packages/shared` para que servidor y UI no diverjan. `@auto` no sustituye una configuración específica cuando el proyecto necesita otras herramientas.

## Cómo observar el resultado

Cada ejecución de agente guarda `contextMetrics` en su `StepRun`, accesible con el detalle del flujo por API. El registro visible del paso también muestra un resumen al iniciar y al terminar:

| Campo | Qué mide |
| --- | --- |
| `promptChars` | Caracteres del mensaje enviado por Nexura; excluye instrucciones añadidas por CLI, historial reanudado, schemas y protocolos de sistema. |
| `memoryChars`, `ledgerChars` | Tamaño de esas secciones cuando están presentes en el mensaje. |
| `mcpServers` | Servidores cargados; no sus credenciales ni el tamaño de sus schemas. |
| `resumedFrom`, `resumeDepth`, `sessionTurnsBefore`, `sessionDecision` | Procedencia y motivo de conservar o reiniciar contexto. |
| `toolCalls`, `toolResultChars` | Llamadas normalizadas y caracteres devueltos por herramientas. |
| `readCalls`, `repeatedReadCalls` | Llamadas explícitas a `Read`; una repetición exige el mismo path y rango. No cubre lecturas por shell ni demuestra que una repetición sea innecesaria. |

Estas medidas no se presentan como tokens ahorrados. Para comparaciones reales deben acompañarse de `usage` (entrada, salida y caché reportadas por CLI), tiempo, resultados de QA, defectos e intervenciones. Los tests fake verifican el comportamiento del flujo, no la calidad de un modelo ni un porcentaje de ahorro. `unreportedUsage` recupera los tokens de procesos que mueren, pero no su coste en dólares.
