# OBJETIVO

Que el padre pueda pedir el Excel por WhatsApp: «mándame el excel» y que le llegue.

# CONTEXTO

Sigues en la misma conversación: el IVA por línea (`2f66bd8`) y el export trimestral
(`1c77153`) ya están hechos y en verde. `app/export/service.py` ya sabe generar el libro
de cualquier trimestre y te devuelve `contenido` (los bytes) y `filename`.

Esto **NO es el export automático** (ese ya existe y lo dispara un cron). Esto es la
petición a demanda desde el chat.

**Es lo que el padre eligió**, no una suposición: en `mocks/PREGUNTAS-PADRE.md`,
pregunta 9, respondió **B** — «solo cuando yo lo pida», y descartó explícitamente que
se lo mandes solo cada vez que cree una factura. Respétalo: nada de envíos no pedidos.

# QUÉ HACER

1. **Agente**: una herramienta nueva en `app/conversation/agent.py` para pedir el Excel.
   Sigue el estilo de las que ya hay (`confirmar_factura`, `editar_linea`...).
2. **Qué trimestre**: por defecto, el trimestre **en curso** (lo que lleva hasta hoy) —
   es lo que él quiere ver cuando pregunta cómo va. Que se pueda pedir otro («el del
   trimestre pasado», «el de abril»), pero sin complicarlo: si no lo dice, el actual.
3. **Envío**: reutiliza el camino que ya existe para mandar el PDF de una factura
   (`client.subir_media` + `client.enviar_documento`, y `repos.registrar_mensaje` para
   que quede en el visor del panel). No inventes otro.
4. **Respuesta**: antes del fichero, un mensaje corto con lo que lleva el trimestre.
   El padre eligió el formato escueto (pregunta 10, respuesta **B**): algo como
   «Julio: +557,46 €», no un párrafo. Cíñete a su estilo.
5. **Tests**: para todo lo que toques. Incluye que se pide el trimestre correcto por
   defecto, y que un trimestre sin facturas no revienta (te contesta, no se cae).

# REGLAS DURAS

- **NO** cambies la forma de las preguntas ni el estilo del chat: el usuario es una
  persona mayor y cualquier cambio le desorienta.
- **NO** toques la numeración de facturas ni el flujo de la foto → PDF.
- **NO** mandes el Excel sin que lo pida. Lo dijo él.
- **NO** toques el panel de administración.
- Reutiliza lo que ya hay (`app/export/`, `client.py`, `repos.py`). Léelo antes.

# CRITERIO DE TERMINADO

- Tests en verde, todos: los que ya había y los nuevos.
- Pedir el Excel por chat devuelve un .xlsx válido del trimestre correcto.
- **git commit** explicando el *porqué*, no el *qué*.

# SI TE QUEDAS SIN CUPO

Deja el trabajo consistente y commiteado, y escribe en el commit qué falta.
