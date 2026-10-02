# Oficina 3D

La sección **Oficina 3D** abre [Agent Office](https://github.com/AgentSystemLabs/agent-office), incluido completo en `third_party/agent-office/` en el commit indicado en [`third_party/agent-office.upstream.json`](../third_party/agent-office.upstream.json). Su código y recursos se distribuyen bajo la [licencia MIT](../third_party/agent-office/LICENSE), que se conserva en la copia. Los cambios locales sobre esa copia están inventariados en [`third_party/agent-office.patches.md`](../third_party/agent-office.patches.md).

## Actualizar a lo último de upstream

Agent Office recibe decenas de commits al día. Para traerlos:

```bash
npm run update:office            # rama main de upstream
npm run update:office -- <ref>   # otra rama, tag o commit
```

El script exige que `third_party/agent-office/` no tenga cambios sin confirmar, descarga el ref con `git fetch` (sin añadir remotos) y aplica el diff de upstream entre el commit fijado y el nuevo como merge a tres bandas sobre nuestra copia. Parte del `package-lock.json` de upstream y añade las dependencias locales con npm. Si algún cambio de upstream choca con un parche local, deja marcadores de conflicto, lista los archivos y se detiene; si no, reinstala y recompila la oficina (`npm run setup:office`) y ejecuta su typecheck y sus tests. Nunca confirma: revisa el diff y haz commit tú. Conviene actualizar de forma periódica, no a diario, para trabajar sobre una versión probada.

## Arranque

1. Ejecuta `npm run setup` para instalar las dependencias de Nexura y de Agent Office y compilar ambas interfaces.
2. Ejecuta `npm run start:all`. Nexura queda en `http://localhost:4310` y la oficina en `http://localhost:4600`.
3. Abre **Oficina 3D** en la barra lateral. En el primer arranque, Agent Office genera una contraseña y la muestra en la terminal de `npm run start:all`; úsala para entrar. También puedes abrir la oficina en una ventana independiente desde esa sección.

`npm start` arranca solo Nexura, como antes. Para arrancar solo la oficina, usa `npm run serve:office`. Después de editar el código de la oficina, `npm run build:office` recompila su cliente y servidor.

Agent Office reanuda los trabajadores guardados y procesa su cola al arrancar. Por eso `npm run start:all` y `npm run serve:office` son comandos explícitos: pueden activar agentes reales y consumir cuota si la oficina ya tenía trabajo pendiente. Abrir Nexura con `npm start` no arranca esos trabajadores.

`npm run start:all` (`scripts/start-all.mjs`) arranca los dos servidores con un token aleatorio compartido (`NEXURA_OFFICE_TOKEN`) y con `NEXURA_OFFICE_URL`/`NEXURA_URL`, que es lo que activa la integración descrita abajo. Por separado (`npm start` y `npm run serve:office`), cada uno funciona solo, como antes.

## Integración con Nexura

**Agentes** sigue mostrando los flujos y subagentes de Nexura en la oficina 2D. Los trabajadores propios de la oficina 3D (terminales interactivas, cola, voz, reuniones) se gestionan allí; crear uno puede consumir cuota de Claude o Codex. Abrir la vista no inicia ninguno. Con `npm run start:all`, además:

### Los flujos de Nexura se sientan en la oficina

`apps/server/src/office/office-bridge.ts` envía a la oficina cada flujo vivo, o terminado hace menos de 15 minutos, como un trabajador "virtual". Lo manda después de cada cambio y cada 20 s: `POST /nexura/workers` con el token. Vale para Claude, Codex y Copilot, y para Azure DevOps y GitHub, porque la oficina solo lo pinta y quien ejecuta es Nexura.

- **Planta**: la del checkout que contiene el repo del flujo. Si no hay ninguna, la primera planta.
- **Mesa**: se ocupan desde el fondo de la sala, y la oficina ya no contrata en ellas.
- **Estado**:
  - `working` mientras hay un paso en marcha; la animación sale de la herramienta que está usando (leer, editar, tests…).
  - `needs_input` cuando está en pausa (aprobación, PR) o esperando cuota. Cuenta en "🙋 waiting" y la tecla N lleva hasta él.
  - `done` al terminar y `exited` si falla o se cancela.
- **Abrir el flujo**: con E (o desde la lista de trabajadores, las notificaciones…) se abre el flujo en Nexura. Dentro del iframe, la página **Oficina 3D** navega a `/runs/:id`. Solo acepta mensajes de su propio iframe. Con O se abre su PR.
- Un flujo no tiene terminal: el portátil muestra lo que hace, y no se le puede escribir ni mandar a casa desde la oficina.

### Tableros de Azure DevOps

En una planta cuyo `origin` está en Azure DevOps (`dev.azure.com`, `visualstudio.com`), los tableros **Issues** y **Pull Requests** se llenan desde Nexura (`apps/server/src/office/office-api.ts` y `azure-board.ts`), con su autenticación de Azure DevOps (`az login`, o el PAT de `NEXURA_AZURE_PAT_FILE`; ver el README). Las plantas de GitHub siguen usando el `gh` de la oficina. En esas plantas las ventanas dicen "Azure DevOps" donde upstream dice "GitHub", los `#N` del Markdown enlazan al work item N y las líneas añadidas y quitadas de los PR abiertos salen del checkout local.

| En la oficina | En Azure DevOps |
|---|---|
| Issues | work items del proyecto: abiertos y los 40 cerrados más recientes |
| Labels | el tipo de work item y sus tags |
| Asignarse (al empezar una tarea) | `System.AssignedTo` |
| Cerrar | el estado final de su tipo (`Completed`, o `Removed` si "not planned") |
| Pull requests | activos, completados y abandonados |
| Revisión | los votos de los revisores |
| Checks | las directivas del PR |
| Merge | completar con squash, merge (no fast-forward) o rebase; también auto-complete |
| Diff | se calcula con `git` en el checkout local, porque ADO no lo da por REST |

En la ventana de un issue (de ADO o de GitHub), **🚀 Resolve with Nexura** abre **Nuevo flujo** en Nexura con el ticket, el origen y el repo rellenados. No lanza nada hasta que eliges perfil y modelo y confirmas.

Si la oficina está en una ventana aparte y Nexura ya está abierto, los flujos y **Resolve with Nexura** se abren en esa ventana de Nexura sin crear otra pestaña. El portátil de cada trabajador de Nexura muestra una vista reducida del flujo o de su PR, con pasos y actividad reciente.

### Trabajadores de la oficina en repos de Azure DevOps

- **Plantas**: el ascensor ofrece los repos configurados en Nexura como `nexura/<nombre>`. Al elegir uno, su carpeta se abre como planta tal cual, sin clonar, porque `gh` no puede clonar desde ADO.
- **Claude**: en esas plantas recibe con `--append-system-prompt` la equivalencia de los comandos `gh` a `az` (Azure CLI con la extensión `azure-devops`, `az extension add --name azure-devops`). Todos los comandos de esa nota se han probado contra una organización real. Necesitan `az login` o, en organizaciones sin Entra, `AZURE_DEVOPS_EXT_PAT` en el entorno de la oficina.
- **PR**: los que se abren desde una mesa o desde **Changes** se crean a través de Nexura. Si el prompt dice `Closes #N`, el PR queda enlazado al work item N.
- **Pendiente**: las limitaciones están en [`third_party/agent-office.patches.md`](../third_party/agent-office.patches.md).

### Logros

Los logros de Nexura (sección **Logros**) también están en la oficina. Todo pasa por el servidor de la oficina, que habla con `NEXURA_URL`; sin Nexura la vitrina queda vacía.

- **Vitrina**: en la pared este, entre el tablero Services y la tele. Muestra una copa por logro conseguido, con el color de su nivel, y siluetas de los que faltan. Con E se abre la lista completa, con los secretos ocultos.
- **Lo que haces en la oficina cuenta**: acariciar al perro, tomar café, tocar el gong, jugar en la recreativa, bajar por la barra, subir a la azotea… Cada E sobre un objeto se manda a Nexura (`POST /api/nexura/achievements`, validado en los dos servidores).
- **Secretos**: cinco patitos de goma escondidos (cambian de sitio cada semana, ver abajo), el código Konami, pasar por la oficina de madrugada y un hoyo en uno en el golf del balcón.
- **Aviso**: dentro de Nexura, el toast del trofeo lo pone Nexura; con la oficina en su propia ventana, lo pone la oficina, arriba a la derecha. Dura 20 segundos y no genera una segunda notificación del navegador.

### Tienda, monedas y salas

El monedero y la tienda son de Nexura (`apps/server/src/rewards`, catálogo y sorteo diario en `packages/shared/src/rewards.ts`). La oficina los pide a través de su servidor (`src/server/nexura/proxy.ts`, solo las rutas de esa lista) y, para pintar sus salas, pide a Nexura un resumen de una vez (`GET /api/office/digest`): flujos en marcha, PR integradas, el día en números, PR por revisar y cuota.

Como Nexura es personal, el monedero, la tienda y la ropa solo aparecen en la oficina abierta dentro de Nexura o en la propia máquina (`localhost`). Si comparte la oficina con más gente, ven tu ropa puesta, pero no tus monedas.

- **Monedas**: arriba a la izquierda; con un clic, la tienda.
- **Tienda**: un puesto con toldo contra la pared norte del ala oeste, junto a la galería de la fama (E). La misma ventana que la sección Tienda de Nexura: ofertas del día y tu colección para ponerte y quitarte cosas.
- **Tu personaje**: lo que llevas puesto lo ve toda la planta (`PeerInfo.nexura`). Los sombreros, complementos, mascotas, estelas y placas se construyen en `src/client/nexura/cosmetics.ts`. Un sombrero tapa el de Halloween o Navidad.
- **Patitos**: cinco por planta, en 5 de los 12 escondites de `src/client/nexura/ducks.ts` (`DUCK_SPOTS`), que cambian cada semana ISO. Cada uno paga monedas una vez por temporada, y los cinco, un extra. Para los logros siguen contando del 1 al 5.

Las salas y cosas nuevas, y dónde están (`src/shared/nexura-places.ts`):

| Qué | Dónde | Qué hace |
|---|---|---|
| 🛰️ Sala de control | Contra la pared oeste, al fondo del edificio, bajo el monitor de la máquina | Un monitor por flujo en marcha, con su pipeline, agente, coste y si te espera (si hay más de tres, se turnan). Con E, la lista: aprobar, apostar o abrir. |
| ✋ Aprobar desde la mesa | La mesa de cada flujo | Con P, un flujo en pausa sigue tal como lo propone Nexura (el paso, la PR o las respuestas) o se salta el paso (`POST /api/office/runs/:id/continue`). Editarlo sigue siendo cosa de Nexura. |
| 🎲 Porra | La mesa de cada flujo (C) o la sala de control | Apostar si pasa a la primera. |
| 📮 Buzón | Pared norte, junto a la esquina del tablero de Issues | Soltar ahí una tarjeta del tablero de Issues abre Nuevo flujo en Nexura con ella. |
| 👁️ Por revisar | Junto a la escalera | Las PR de otras personas que esperan tu revisión. Con E, la lista, y cada una abre Revisiones. |
| 📅 Hoy en Nexura | Junto a la pizarra | Flujos terminados, PR, revisiones, gasto, monedas y logros del día. Con E, Métricas. |
| 🥤 Máquina de cuota | Al final de la encimera de la cocina | Cuánta cuota de Claude queda (5 h y semana). |
| 🖼️ Galería de la fama | Ala oeste, contra la pared norte | Un cuadro por PR integrada de tus flujos. Se compra en la tienda; hasta entonces, cordón y cuadros tapados. |
| 🎮 Sala de juegos | En medio del ala oeste, lejos de las islas (la esquina suroeste es la cancha de la canasta) | Futbolín (contra la máquina o dos en un teclado; ganar paga, con tope diario), Trivial del repo (preguntas sacadas de `git log` de tus repos) y el Gran Premio (un circuito de sobremesa: cada flujo es un coche que avanza según sus pasos). Cada juego se compra en la tienda; hasta entonces, bajo una lona. |

Además:

- Cada flujo lleva una gorra del color de su agente y el objeto de su paso (lupa, teclado, probeta…). Su tarjeta dice cuánto lleva gastado, y el gong suena cuando se integra su PR.
- En el mapa de castillo, el heraldo pregona los flujos que esperan o terminan.
- El perro de cada planta se llama **Nala** mientras nadie le cambie el nombre en ⚙️ Settings (`dogDefaults` en `src/shared/dog.ts`).
- Al subirte a una mesa o a cualquier objeto, si te quedas con el centro del cuerpo fuera del borde resbalas y caes, en vez de quedarte flotando en el aire hasta 0,32 m más allá (`ledgeSlide` en `src/client/player/collide.ts`).
- La paleta (Ctrl+K) encuentra todo lo anterior y las páginas de Nexura.
- La primera vez hay una visita guiada, que vuelve desde la paleta («Visita guiada de Nexura»).

### Un edificio más amplio

La planta de la oficina es 10 m más ancha que la de upstream, hacia el oeste (`FLOOR.minX` -28 en vez de -18), para que lo de Nexura no apriete las islas ni el salón. Lo que estaba contra la pared oeste se ha movido con ella (ventanas, puerta y escalera de salida, monitor de la máquina, escalera de mano, pufs junto a las ventanas, plantas de las esquinas, la canasta y su cancha) y también los árboles de la calle de ese lado; hay una ventana más en la pared sur y una menos en la oeste (la más al norte, donde está la sala de control). Las cosas de Nexura ocupan esa ala oeste (`src/shared/nexura-places.ts`), y los trabajadores y el perro las rodean (`nexuraObstacles` en la navegación). La ciudad que se ve desde la azotea tiene las manzanas más anchas (`PERIOD` 66 en vez de 56), para que la calle oeste no atraviese el edificio.

### Modo god (`npm run demo`)

Para enseñar Nexura: `npm run demo` compila la UI y la oficina y arranca las dos con datos nuevos en una carpeta temporal (ningún logro ni historial), el monedero con 999.999.999 monedas y la contraseña `demo`. Por defecto usa los agentes falsos y un repo de prueba (`fixtures/sandbox.mjs`, el mismo de `/try-fake`) con un `claude` falso delante en el `PATH` de la oficina, así que no gasta cuota. Opciones de `node scripts/demo.mjs`: `--real` (tus agentes y `config/repos.json`, que **sí** gastan cuota), `--coins <n>`, `--port`, `--office-port` y `--delay` (ms de los agentes falsos).

### Probar sin cuota

`/try-fake` más una oficina con un `claude` falso por delante en el `PATH`:

1. Arranca Nexura con `NEXURA_OFFICE_TOKEN=t NEXURA_OFFICE_URL=http://127.0.0.1:4602 NEXURA_URL=http://localhost:<port> NEXURA_OFFICE_WEB_URL=http://localhost:4602 node .claude/skills/try-fake/start.mjs --port <port>`.
2. Arranca la oficina con `node third_party/agent-office/bin/agent-office.js <temp>/sandbox --port 4602 --password test`. Antes, define:
   - `NEXURA_OFFICE_TOKEN=t` y `NEXURA_URL=http://localhost:<port>`;
   - `NEXURA_FRAME_ANCESTORS=http://localhost:<port>`;
   - un `AGENT_OFFICE_HOME` temporal;
   - un directorio al principio del `PATH` con un `claude.cmd` que ejecute `fixtures/fake-claude.mjs`, porque la oficina lanza `claude -p` para leer los límites del plan.

Agent Office guarda sus datos en `~/agent-office` por defecto y puede crear checkouts de proyectos desde el ascensor. Nexura conserva sus datos en `data/`. Ambos servidores escuchan solo en la máquina local al arrancarlos con los scripts de Nexura.

El paquete publicado en npm como `agent-office` tiene una versión y un binario distintos de los del repositorio fijado aquí. Las dependencias de esta copia se instalan dentro de `third_party/agent-office/` mediante su propio `package-lock.json`.

Los tests de la oficina se ejecutan con `npm test --prefix third_party/agent-office`; los de nuestra integración, con `node --import tsx --test tests/nexura-*.test.ts` dentro de esa carpeta. En Windows, el script de tests ejecuta aparte `workers.test.ts` para que ConPTY no mantenga abierta la suite al terminar.
