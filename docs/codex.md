# Desarrollar Nexura con Codex y Claude

Abre Codex desde la raíz de Nexura. La configuración está en
`.codex/config.toml`; requiere un Codex reciente con agentes personalizados,
hooks y `http_headers_helper` (validación inicial con CLI 0.157.0).
El proyecto debe estar marcado como confiable para cargar su configuración.
Tras cambiarla, abre una sesión nueva o recarga la extensión.

## Instrucciones, skills y revisores

`AGENTS.md` dirige Codex a `CLAUDE.md`, que sigue siendo la fuente compartida
de convenciones. `.agents/skills/` contiene adaptadores de las skills existentes:

- `$try-fake`: arranca UI/API con agentes falsos y datos temporales.
- `$new-step`: añade un paso integrado; se invoca explícitamente, como en Claude.

Los revisores `step-config-reviewer` y `security-reviewer` se declaran en
`.codex/agents/`. Reutilizan las instrucciones de `.claude/agents/`, heredan el
modelo de la sesión y usan un sandbox de solo lectura. Sus conexiones MCP con
capacidad de escritura están desactivadas.

## MCP

`codex mcp list` carga la configuración y muestra los cinco
servidores. La lista confirma el registro, no la conexión. En una nueva sesión,
usa `/mcp` para comprobar su estado.

- **angular-cli**: CLI local de Angular en modo de solo lectura; requiere `npm install`.
- **playwright**: `npx` descarga/ejecuta el mismo paquete que Claude. La primera
  navegación puede requerir instalar el navegador mediante su herramienta.
- **github**: reutiliza `.claude/mcp/github-headers.mjs` mediante
  `http_headers_helper`. Requiere una sesión de `gh auth login --web`; no guarda
  tokens en TOML ni requiere exportarlos al entorno de la extensión.
- **context7**: conexión HTTP al mismo servidor que Claude.
- **nexura-memory**: usa la memoria compartida con origen `codex`. No editar su
  SQLite a mano. Las pruebas de integración deben usar una base temporal.

## Hooks y permisos

Los hooks `PreToolUse` y `Stop` reutilizan los scripts de Claude para impedir
atribuciones en commits/PRs y comprobar tipos cuando hay cambios TypeScript.
Codex normaliza las ejecuciones de shell como `Bash`, compatible con el hook.
El hook Git `.githooks/commit-msg` funciona con ambos asistentes; en un clon nuevo
se activa con `git config core.hooksPath .githooks`.

Codex exige revisar y confiar cada definición de hook antes de ejecutarla:
abre `/hooks` y acepta los dos hooks del proyecto. Los hooks nuevos o modificados
se omiten hasta entonces. No se desactiva este control desde el repositorio.
Mientras tanto, `AGENTS.md` exige los mismos checks y convenciones.

Las listas `permissions` de Claude no se importan como controles técnicos de
Codex. Las restricciones del proyecto también están expresadas en `AGENTS.md`;
el sandbox y las aprobaciones de Codex siguen la configuración del usuario.
El plugin `typescript-lsp` continúa siendo de Claude: Codex usa lectura/búsqueda
de código y los checks de TypeScript, sin instalar un plugin equivalente.

Referencias oficiales: [MCP](https://learn.chatgpt.com/docs/extend/mcp),
[skills](https://learn.chatgpt.com/docs/build-skills),
[agentes](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[hooks](https://learn.chatgpt.com/docs/hooks).

## Validación inicial

Comprobado con Codex CLI 0.157.0:

- App server con `--strict-config`: configuración aceptada sin errores de agentes.
- `skills/list`: ambas skills de repositorio detectadas, sin errores.
- `codex debug prompt-input`: instrucciones y ambos revisores presentes, sin
  ejecutar un turno de modelo.
- Conexión MCP y `tools/list`: Angular (6 herramientas), Playwright (25),
  GitHub (48), Context7 (2) y memoria (4). Memoria probada con SQLite temporal.
- Hooks: bloqueo de atribución en mensaje directo y archivo de PR; aceptación
  de comando válido; protección frente a repetición del Stop; ambos typechecks
  completados correctamente sobre el árbol de trabajo actual.

El listado de herramientas comprueba el protocolo y la autenticación; no implica
haber navegado con Playwright ni haber ejecutado todas las operaciones disponibles.
