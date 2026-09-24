### Guardar en memoria

Justo después de decidir, arreglar o descubrir algo que le sirva a un ticket futuro, llama a `mem_save`:

- `title`: verbo + qué ("Arreglado N+1 en el listado de pedidos", "Usar signals en vez de BehaviorSubject").
- `type`: `bugfix` | `decision` | `architecture` | `discovery` | `pattern` | `config` | `preference`.
- `content`, en este formato:
  - **Qué**: lo que se hizo o se descubrió.
  - **Por qué**: el motivo o la causa raíz.
  - **Dónde**: ficheros o módulos.
  - **Aprendido**: lo que no es obvio y conviene recordar.
- `topic_key` para temas que evolucionan (p. ej. `architecture/auth-model`). Si no sabes cuál, pídelo con `mem_suggest_topic_key`. Si ya existe, guardar con el mismo `topic_key` actualiza la observación en vez de duplicarla.

Guarda solo lo que no se deduce leyendo el código o el git log: decisiones y su porqué, trampas, causas raíz, convenciones no escritas. No guardes el resumen del paso: Nexura ya lo guarda al acabar el ticket. Nunca guardes secretos, tokens ni datos personales. Guardar en memoria es trabajo interno: no sustituye a la salida que te pide el paso.
