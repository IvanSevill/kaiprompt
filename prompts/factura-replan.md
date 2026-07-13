# OBJETIVO

Decirme **qué hay que hacer ahora** en FacturaSevi, y dejar el plan escrito y ordenado.

Esto **no es una tarea de código**. Es de criterio. No implementes nada.

# CONTEXTO

FacturaSevi digitaliza facturas manuscritas de un autónomo de construcción: foto por
WhatsApp → Gemini extrae → se confirma por chat → PDF numerado. El usuario final es el
padre del dueño del repo: persona mayor, baja alfabetización digital, **no sabe expresar
lo que quiere** y se queja de que no es lo que quería. Por eso se le pregunta en A/B.

Arranca leyendo, en este orden, y **no des nada por supuesto**:

- `Docs/idea.txt` — la especificación original.
- `Docs/feedback.txt` — lo que el dueño ha ido pidiendo por encima de la spec.
- `mocks/PREGUNTAS-PADRE.md` — **el más importante**: el cuestionario A/B que ya se pasó
  al padre, **con sus respuestas y sus notas a mano**. Ahí hay requisitos que no están en
  ningún otro sitio (agrupar gastos por proveedor, la columna «Obra», los tres
  trabajadores y sus horas, que los gastos llegan también en PDF, qué es «gasto personal»,
  y un requisito nuevo sobre clientes y deudas al final del todo).
- `git log` y el código: qué está hecho **de verdad**, no lo que la spec dice que debería.

# QUÉ HACER

1. **Inventario honesto.** Qué está hecho, qué está a medias y qué no está. Contrasta la
   spec y las respuestas del padre contra el código real. Si algo está construido pero no
   se dispara, o construido a medias, dilo — vale más que una lista de deseos.
2. **Los cabos sueltos que ya conozco** (verifícalos, no te fíes de mí):
   - El **Excel de contabilidad del padre** (el de los mocks: gastos e ingresos por
     trimestre, obras, proveedores, trabajadores, resumen anual) **no existe**. El que se
     hizo es el de la gestoría, que es otra cosa. Es el hueco más grande.
   - **Entrada de gastos**: el padre dijo que manda foto del ticket, y que **a veces le
     llegan en PDF**. Hoy el flujo es solo foto → factura emitida.
   - **Trabajadores y horas**: respondió A **y** B a la vez, y sus notas se contradicen
     con la pregunta. Está sin resolver.
   - Recordatorios de cobro, rectificativas y detección de duplicados: en la spec, sin
     construir.
3. **Prioriza por valor real**, no por orden de la spec. El criterio: qué le ahorra más
   trabajo al padre y qué desbloquea a lo demás. Justifica el orden en una línea cada uno.
4. **Lo que hay que preguntarle al padre antes de construir**: preguntas **cerradas A/B**,
   concretas, como las de `PREGUNTAS-PADRE.md`. Nada de preguntas abiertas: no sabe
   contestarlas. Si algo se puede decidir sin preguntarle, decídelo tú y dilo.
5. **Deja el plan escrito** en `Docs/plan.md`: estado actual, orden de trabajo, y las
   preguntas pendientes. Que sirva para arrancar el siguiente prompt sin releer todo.

# REGLAS DURAS

- **NO escribas código de producción.** El único entregable es el plan.
- **NO te inventes lo que quiere el padre.** Si no está en sus respuestas, es una pregunta
  pendiente, no una decisión tomada.
- Sé directo. Si algo que se construyó no sirve o hay que rehacerlo, dilo.

# CRITERIO DE TERMINADO

- `Docs/plan.md` escrito, ordenado y sin humo.
- Las preguntas para el padre, en A/B, listas para pasárselas tal cual.
- **git commit** del plan.
- En tu respuesta final: **qué harías tú lo siguiente, y por qué.**
