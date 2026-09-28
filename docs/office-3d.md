# Oficina 3D

La sección **Oficina 3D** abre [Agent Office](https://github.com/AgentSystemLabs/agent-office), incluido completo en `third_party/agent-office/` a partir del commit [`71d14aba38bb3663d0ea2ced5db59bcb2c330c90`](https://github.com/AgentSystemLabs/agent-office/commit/71d14aba38bb3663d0ea2ced5db59bcb2c330c90). Su código y recursos se distribuyen bajo la [licencia MIT](../third_party/agent-office/LICENSE), que se conserva en la copia. La adaptación local de `src/server/server.ts` permite mostrar sus páginas solo dentro de la UI local de Nexura mediante `frame-ancestors`.

## Arranque

1. Ejecuta `npm run setup` para instalar las dependencias de Nexura y de Agent Office y compilar ambas interfaces.
2. Ejecuta `npm run start:all`. Nexura queda en `http://localhost:4310` y la oficina en `http://localhost:4600`.
3. Abre **Oficina 3D** en la barra lateral. En el primer arranque, Agent Office genera una contraseña y la muestra en la terminal de `npm run start:all`; úsala para entrar. También puedes abrir la oficina en una ventana independiente desde esa sección.

`npm start` arranca solo Nexura, como antes. Para arrancar solo la oficina, usa `npm run serve:office`. Después de editar el código de la oficina, `npm run build:office` recompila su cliente y servidor.

Agent Office reanuda los trabajadores guardados y procesa su cola al arrancar. Por eso `npm run start:all` y `npm run serve:office` son comandos explícitos: pueden activar agentes reales y consumir cuota si la oficina ya tenía trabajo pendiente. Abrir Nexura con `npm start` no arranca esos trabajadores.

## Dos sistemas independientes

**Agentes** sigue mostrando los flujos y subagentes de Nexura en la oficina 2D. **Oficina 3D** ejecuta Agent Office sin cambios en su protocolo: sus trabajadores, terminales, cola, cuentas, voz y proyectos se gestionan allí. Crear un trabajador en la oficina 3D puede consumir cuota de Claude o Codex; abrir la vista no inicia ninguno.

Agent Office guarda sus datos en `~/agent-office` por defecto y puede crear checkouts de proyectos desde el ascensor. Nexura conserva sus datos en `data/`. Ambos servidores escuchan solo en la máquina local al arrancarlos con los scripts de Nexura.

El paquete publicado en npm como `agent-office` tiene una versión y un binario distintos de los del repositorio fijado aquí. Las dependencias de esta copia se instalan dentro de `third_party/agent-office/` mediante su propio `package-lock.json`.
