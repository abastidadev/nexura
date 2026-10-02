# Ideas para la Oficina 3D y su integración con Nexura

Lista de funcionalidades nuevas para mejorar la experiencia de la [Oficina 3D](office-3d.md). Está escrita contra Agent Office en upstream `1bc3028`, que ya trae la vista 2D `/lite`, mapas de castillo, coches en el garaje, dardos y hachas en la azotea, la paleta de comandos (Ctrl+K) y la arquitectura de registros (`docs/code-layout.md` de upstream).

Cada idea indica qué es, por qué merece la pena y dónde se engancharía. El esfuerzo es aproximado: **S** (un día o menos), **M** (unos días), **L** (una semana o más). Ninguna gasta tokens: todo sale de datos que Nexura ya tiene (runs, pasos, coste, logros, PR) o de git.

Regla para todas: el código va en `src/server/nexura/` y `src/client/nexura/`, con enganches de una línea en upstream (ver [agent-office.patches.md](../third_party/agent-office.patches.md)). Con los registros, casi todo entra como una pieza propia: un `Fixture` en `floorPlan()`, un `ctx.interactions.define(...)`, una ruta en `http/routes/index.ts`.

## Estado

Todas las ideas de abajo están hechas, junto con un sistema de monedas y una tienda diaria (ver [README](../README.md#tienda-y-monedas) y [office-3d.md](office-3d.md#tienda-monedas-y-salas)). Donde lo hecho difiere de lo propuesto:

- **Bloqueado en la tienda**: solo ocio. La Galería de la fama (2.3) y los tres juegos (3.3, 3.4 y 3.5) se compran. La sala de control, aprobar, los tableros y la máquina de cuota son de trabajo y nunca se bloquean.
- **Gran Premio (3.4)**: un circuito de sobremesa en la sala de juegos de cada planta, no en la azotea, para tenerlo junto a los otros juegos y a la vista de los flujos.
- **Futbolín (3.5)**: contra la máquina o a dos jugadores en el mismo teclado. Jugar en línea entre dos navegadores necesitaría mensajes nuevos en el protocolo de la oficina, que las reglas de parches no permiten (solo campos opcionales).
- **Coste en la tarjeta (1.4)**: en la tarjeta y en la barra de ayuda de la mesa, como texto (`$0.42`), no como el contador de tokens de upstream, que Nexura no envía por flujo.
- **Agentes nuevos sin la nota de Azure DevOps (5)**: Claude la recibe como system prompt; los demás, delante de su primer prompt. Un trabajador contratado sin prompt no la recibe: los otros CLI no admiten un system prompt que la oficina les pueda pasar.
- **Cuentas por persona (5)**: el monedero y la ropa son de quien usa Nexura. Solo se muestran en la oficina abierta dentro de Nexura o en la propia máquina; el resto de la planta ve tu ropa, pero no tus monedas.

## Recomendación: por dónde empezar

| # | Idea | Esfuerzo | Por qué primero |
|---|---|---|---|
| 1 | Aprobar y continuar un flujo desde su mesa | M | Hoy un flujo «esperando aprobación» obliga a salir de la oficina. Es lo que más fricción quita. |
| 2 | Comandos de Nexura en la paleta (Ctrl+K) | S | Upstream ya tiene la paleta; solo hay que añadir entradas. |
| 3 | Sala de control de flujos | M | Una vista de un golpe de todos los runs activos, dentro del 3D. |
| 4 | El paso del flujo se ve en el personaje | S | El bridge ya manda `step`; falta dibujarlo. |
| 5 | Temporadas de patitos | S | Da vida a los logros sin tocar el servidor de Nexura más que una línea. |

## 1. Integración con los flujos de Nexura

### 1.1 Aprobar y continuar desde la mesa — M
Un run en modo paso a paso, o esperando la aprobación del PR, aparece como `needs_input` («esperando aprobación»). Hoy la única acción es E, que abre el run en Nexura.
- **Propuesta**: en la mesa de un flujo, **P** abre un diálogo pequeño con el resumen del paso (lo que ya pinta el portátil, `NexuraScreen`) y los botones *Continuar*, *Saltar paso* y *Abrir en Nexura*.
- **Cómo**: una ruta `POST /api/nexura/continue` (con sesión y `sameOrigin`, como `/api/nexura/open`) que reenvía a `POST /api/runs/:id/continue` de Nexura con el token compartido. En el cliente, `nexuraDeskKey` ya recibe la tecla.
- **Ojo**: editar el prompt o los borradores de PR se queda en Nexura; aquí solo continuar o saltar.

### 1.2 Tarjeta de issue → flujo de Nexura — S
Se puede coger la tarjeta de un issue del tablero y llevarla a una mesa o a la cola. Hoy, soltarla sobre un flujo de Nexura la rechaza (`nexuraCardRefusal`).
- **Propuesta**: un **buzón de Nexura** junto al tablero de issues. Soltar la tarjeta ahí abre *Nuevo flujo* con el ticket y el repo rellenos, igual que el botón «Resolve with Nexura».
- **Cómo**: un fixture con un interactuable `nexura` (`nexura: 'inbox'`) y su caso en `nexuraInteract`; `parts.cards.dropCard` necesitaría un enganche de una línea para aceptar ese destino.

### 1.3 El paso del flujo se ve en el personaje — S
`NexuraWorker.step` ya llega al bridge, pero el personaje solo enseña la acción de la herramienta (`read`, `edit`, `test`, `web`).
- **Propuesta**: un accesorio por paso. `enrich`: lupa. `implement`: teclado. `qaCode`: probeta. `codeReview`: gafas. `release`: caja de envío. Y el color del agente (Claude, Codex o Copilot) en la gorra.
- **Cómo**: mapear `step` a `WorkerAction` en `bridge.ts` o añadir un `WorkerInfo.external.step` y pintarlo en `features/workers/views.ts` con un enganche junto a `nexuraScreen`.

### 1.4 Coste y tokens en el bocadillo — S
`WorkerInfo.usage` existe y la oficina ya sabe pintarlo (`usageLabel`). El bridge no lo rellena.
- **Propuesta**: enviar el coste acumulado del run en el snapshot (Nexura ya lo tiene en `totalCostUsd`) y mostrarlo en la barra de ayuda y el panel de trabajadores.

### 1.5 Celebración al terminar un flujo — S
Cuando un PR de un flujo de Nexura se fusiona, que suene el gong y caiga confeti sobre su mesa, igual que con los trabajadores propios (`features/gong`, `burstOver`).
- **Cómo**: detectar en el bridge el paso de `pr` abierto a fusionado (o `status: done` con `release: pr`) y emitir el mismo mensaje que usa upstream para el gong.

## 2. Salas nuevas

### 2.1 Sala de control de flujos — M
Una pared de monitores en la oficina de atrás (el *back office* que upstream construye con `wing`): una fila por run activo con su pipeline (`enrich → implement → qaCode → codeReview → release`), el paso actual iluminado, el agente y el tiempo en el paso.
- **Por qué**: hoy hay que ir mesa por mesa. Con varios flujos en paralelo, aquí se ve cuál está atascado.
- **Cómo**: un `Fixture` en `src/client/nexura/control-room.ts` que pinte con `textPlane` a partir de `store.workers` filtrando `external`. Sin cambios de servidor.

### 2.2 Sala de revisiones — M
Un tablón con los PR abiertos que Nexura puede revisar (Revisiones, `/api/repos/:name/pull-requests`). Cada PR es una tarjeta; E la abre en Revisiones, y soltarla en una mesa libre prepara una revisión `prReview` (con confirmación en Nexura, como el resto).
- **Por qué**: Revisiones es una parte grande de Nexura que la oficina no muestra.

### 2.3 Muro de PR fusionados — S
Un pasillo con un cuadro por cada PR fusionado a partir de un flujo de Nexura: título, ticket, fecha y agente. Usa el sistema de cuadros colgados de upstream (`features/hanging`).

### 2.4 Máquina de cuota — S
Una máquina expendedora en la cocina que enseña lo gastado hoy y la cuota que queda de cada plan (Claude, ChatGPT/Codex, Copilot), con los datos de Métricas de Nexura. Con E se abre Métricas.
- **Ojo**: solo lectura de datos que Nexura ya guarda; nunca lanzar `claude -p` para medir.

## 3. Juegos

### 3.1 Temporadas de patitos — S
Los cinco patitos están siempre en el mismo sitio. Una vez encontrados, no queda nada que buscar.
- **Propuesta**: cada semana ISO cambian de escondite, eligiendo con la semana como semilla entre una lista de huecos revisados a mano. Encontrar los cinco de una semana da un logro de temporada.
- **Cómo**: `DUCKS` pasa a ser una lista de candidatos más una función de la semana. En Nexura, el evento `duck` lleva la semana.
- **Lección de esta actualización**: upstream pone calabazas en Halloween justo donde estaba el patito 4. Cada hueco nuevo se comprueba con el test de visibilidad (pintar el patito de magenta y contar píxeles), que convendría dejar como script en `fixtures/`.

### 3.2 Porra del flujo — S
Antes de que un run llegue a QA, apuesta en su mesa si pasará `qaCode` a la primera. Aciertos y fallos cuentan para un logro nuevo de la categoría *Oficina 3D*. Sin dinero ni puntos canjeables.

### 3.3 Trivial del repo en la recreativa — M
Una segunda máquina recreativa que pregunta cosas del repo sacadas de git, sin tokens: «¿quién tocó por última vez `orchestrator.ts`?», «¿en qué mes se añadió el perfil `full`?», «¿qué fichero ha cambiado más este mes?». Récords por planta, como el Tetris de upstream (`features/cabinet`).

### 3.4 Carrera de flujos en la azotea — S
Con dos o más runs en paralelo, una pista en la azotea con un coche por run que avanza según los pasos completados. Puramente visual, pero hace que lanzar varios flujos se sienta como una carrera.

### 3.5 Futbolín multijugador — L
Mesa de futbolín para dos personas conectadas a la misma planta. Upstream ya sincroniza pelotas (`BallClientMsg`), así que el modelo de red existe, pero es lo más caro de la lista.

## 4. Experiencia y calidad de vida

### 4.1 Comandos de Nexura en la paleta (Ctrl+K) — S
`features/palette` ya lista trabajadores, mesas y sitios. Añadir: *Nuevo flujo*, *Ir al flujo #N* (camina hasta su mesa), *Abrir Revisiones*, *Abrir Métricas* y *Ver logros*.

### 4.2 Resumen del día en la pizarra — S/M
Al final de la jornada (o con E en un botón de la pizarra), la pizarra de upstream (`features/whiteboard`) muestra: runs terminados, PR abiertos y fusionados, coste del día y logros nuevos. Todo sale de la API de Nexura.

### 4.3 El heraldo anuncia los flujos — M
En el mapa de castillo, el heraldo (`features/herald`) ya acompaña a los trabajadores a su sitio. Que también pregone los flujos de Nexura que terminan o se atascan («¡El flujo #43 aguarda la venia de su señor!»).

### 4.4 Visita guiada al llegar — S
La primera vez que alguien entra desde Nexura, un recorrido corto: la mesa de un flujo, la vitrina, el buzón de issues y la sala de control. Se guarda en `localStorage` que ya se hizo.

### 4.5 La oficina de píxeles de Nexura, a la par — M
La oficina 2D de Nexura (`apps/web/src/app/shared/pixel-office`) no tiene vitrina ni patitos. Una vitrina en píxeles que abra la página de Logros acercaría las dos vistas.

## 5. Deuda detectada al actualizar

Cosas que no son nuevas funciones, pero que estorban a la experiencia y conviene cerrar antes o a la vez:

- **Agentes nuevos de upstream sin la nota de Azure DevOps**: upstream añade Pi, Grok, Muse Code y DeepSeek Harness. En plantas de ADO solo Claude recibe la equivalencia `gh` → `az` (`withNexuraArgs`); Codex y OpenCode tampoco la reciben. Los proveedores ya son adaptadores (`src/server/providers/`), así que la nota podría ir por proveedor.
- **Ascensor**: al elegir un repo de Nexura, el pie sigue diciendo «Cloned into … with gh».
- **Cuentas por persona**: upstream permite que cada persona use su propia cuenta de Claude y GitHub (#146). Nexura sigue enviando sus flujos con una sola identidad; habría que decidir si los flujos de Nexura deben verse como de alguien.
