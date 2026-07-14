# Ideas

## Follow-ups after v1.3.5

These are non-blocking improvements. The automated Node and Android suites cover the release,
including a real `kaip serve` process going from QR to connected and back to QR.

- Run the notification and unpair flows on physical Android devices from at least two vendors.
  This environment has no device attached through ADB, so OEM battery restrictions and channel
  settings cannot be reproduced here.
- Add a multi-device screen to show exactly which phone is connected. The server already keeps
  independent installation IDs, but the terminal panel intentionally remains a compact summary.
- Exercise the final usage screen in a small pseudo-terminal matrix (Windows Terminal, conhost,
  and a narrow SSH terminal). Width behavior is unit-tested, but visual rendering varies by font.

## Implemented Since This Note

This is a historical product note, not a current backlog. These items are now implemented and
should not be planned again: provider/model selection per job, OpenCode execution, quota details in
the UI, saved usage/cost data, and manual retry of failed jobs (`kaip retry <id>` or `t` in the
guided UI). Remaining sections are proposals only and may describe an older implementation.

Nada de esto está implementado. Es una lista para decidir, no un backlog para ejecutar.

La pregunta que la ordena no es "¿qué molaría?", sino **"¿qué sabe ya la herramienta y no está
mirando?"**. Porque resulta que sabe bastante más de lo que enseña.

---

## Lo que ya sabe (y tira a la basura)

Antes de proponer nada, los datos. Salen de mirar `data/queue.json` de esta máquina —
**11 lanzamientos reales**, no hipótesis:

| | |
|---|---|
| Lanzamientos con `--target` | **11 de 11** |
| Con `--from` (el prompt en un fichero) | **11 de 11** |
| Con `--dir` | **11 de 11** |
| Secuenciales (sin hora) | **9 de 11** |
| Agendados (`--at`) | **2 de 11** |
| Con `--first` | **0** |
| Con `--perm` | **0** |
| Que se quedaron sin cupo | **4 de 11** (36 %) |
| Duraciones reales | 5, 8, 10, 18, 18, 20, 28, 38 min |

Tres cosas saltan a la cara:

1. **El cupo es el problema dominante.** Más de un tercio de los lanzamientos se quedaron sin
   él. Todo lo demás es secundario.
2. **Sabe cuánto tarda cada cosa** — tiene `startedAt` y `finishedAt` de cada lanzamiento — y
   no usa ese dato para nada.
3. **`--first` y `--perm` no los ha usado nadie. Nunca.**

Y dos cosas que descubrí abriendo el código y que cambian el precio de la mitad de esta lista:

- **`publish()` solo se llama cuando un job TERMINA** (`notify.mjs:29`). El canal SSE existe,
  `/api/events` existe, la app ya lo consume. El runner ya emite cada evento (`onEvent`) para
  pintar la vista en vivo del PC. **Nadie conectó los dos cables.**
- **El adaptador de Claude lee `evt.result` y tira `evt.usage`** (`claude.mjs:71`). Los tokens
  que gastó cada lanzamiento **llegan y se descartan en la misma línea**.

Eso no es "no tiene el dato". Es que lo tiene en la mano y lo suelta.

---

## Las ideas, por valor / esfuerzo

### 1. Ver la conversación EN VIVO en el móvil ⭐ — *el cable que falta*

**Problema real:** estás fuera, el lanzamiento lleva 25 minutos y no sabes si está trabajando
o colgado. Hoy la app te enseña la conversación **cuando ya ha terminado**, que es justo cuando
deja de importarte.

**Coste: bajo.** No hay que construir nada nuevo, hay que **enchufar dos cosas que ya existen**:
el `onEvent` del runner (que ya alimenta la vista en vivo del PC) al `publish()` del servidor
(que ya tiene SSE y una app suscrita). El trabajo de verdad está en la app: pintar los eventos
según llegan.

**Qué la rompe:** un lanzamiento largo son cientos de eventos; mandarlos todos por el túnel a un
móvil con 4G es mucho ruido. Hay que decidir qué se emite (texto y herramientas, sí; el JSON
crudo, no) y que la app no se coma la batería repintando.

**Por qué podría ser mala idea:** puede que mirar el stream en vivo sea *ansiedad*, no
información — te quedas mirando el móvil en el autobús viendo a Claude leer ficheros. Lo que
de verdad querías saber es "¿va bien o se ha atascado?", y eso lo contesta mejor la idea nº 2
con muchísimo menos ancho de banda.

---

### 2. "¿Cabe en el cupo que queda?" ⭐ — *el cupo como recurso que se planifica*

**Problema real:** el 36 % de los lanzamientos se quedaron sin cupo. Hoy te enteras **cuando ya
ha pasado**. La herramienta sabe (a) cuánto cupo queda y cuándo vuelve, y (b) que este target ha
tardado 18, 20 y 38 minutos las últimas tres veces. **Nunca ha juntado las dos.**

> quedan ~47 min de cupo · este job ha tardado 18/20/38 min → **probablemente NO cabe**
> el siguiente (5 min de media) **sí cabe**

**Coste: bajo.** `readUsage()` ya está. Las duraciones están en la cola. Es una división y una
línea en la pantalla.

**Qué la rompe:** las duraciones varían muchísimo (5 → 38 min, casi ×8). Una media es una
mentira cómoda. Hay que enseñar el rango, no un número: "entre 18 y 38 min", o directamente los
últimos tres.

**Por qué podría ser mala idea:** es más floja de lo que parece, y hay que decirlo. **Quedarse
sin cupo ya no es un fallo** — el job vuelve a la cola, conserva su sitio y *continúa* la
conversación cuando el cupo vuelve. Esa red ya está puesta y funciona. Así que el aviso no evita
un desastre: evita una *molestia*. Sigue mereciendo la pena porque es casi gratis y porque te
deja **elegir**: si sabes que no cabe, encolas el corto en su lugar y el largo cuando vuelva la
ventana.

*(El "elegir el orden para que no se corte nada", del enunciado, es la versión ambiciosa de
esto — y creo que **no** merece la pena, por lo mismo: optimizas para evitar un corte que ya no
te cuesta casi nada. Ver "Lo que NO haría".)*

---

### 3. Mirar los tokens que ya le están llegando ⭐ — *"tengo la sensación de que los tokens vuelan"*

**Problema real:** tuyo, literal. Y la herramienta **no puede ayudarte a averiguarlo porque tira
el dato**: el evento `result` de Claude Code trae el `usage` y `claude.mjs` lo descarta.

**Coste: muy bajo.** Guardar `usage` en el job cuando llega. Con eso, un subcomando de
estadísticas sale casi solo: tokens por lanzamiento, por target, por proyecto. Y la pregunta que
de verdad quieres contestar —*¿reanudar un `--target` largo sale más caro que empezar de cero?*—
pasa de ser una intuición a ser un número.

**Qué la rompe:** el formato del `usage` es de Claude Code y puede cambiar; hay que leerlo a la
defensiva. Y no es directamente comparable entre adaptadores.

**Por qué podría ser mala idea:** ninguna que yo vea. Es el dato más barato de la lista y el que
contesta una pregunta que ya te estás haciendo. **Si solo se hace una cosa de este documento,
que sea esta.**

---

### 4. Los `.md` y los prompts, en inglés — *el ahorro más tonto que hay*

**Problema real:** tuyo también. El español cuesta ~1,3–1,5× más tokens que el inglés para decir
lo mismo, y **cada prompt se paga en cada lanzamiento**. `/prompt` genera prompts en español, y
esos ficheros se mandan enteros.

**Coste: trivial.** Es editar la skill. Cero código.

**Qué la rompe:** nada.

**Por qué podría ser mala idea:** que los leas peor. Pero el prompt no es para ti, es para el
modelo — tú lo lees una vez y lo mandas cien. (Los comentarios del código y este documento son
otra cosa: **esos** sí son para humanos, y se quedan como están.)

---

### 5. Avisar en la app de que algo se quedó a medias — *sin notificación*

**Problema real:** tuyo, tal cual lo pediste. Un lanzamiento se queda parado esperando cupo y
no te enteras salvo que abras la app y mires. Y **no** quieres otra notificación: quieres un
estado visible.

**Coste: casi nulo en el PC** — `pausedUntil` **ya viaja en el DTO** y ya está comentado en el
código como "la diferencia, desde un móvil, entre *está roto* y *está esperando*". El trabajo
está en la app: que eso sea una banda persistente en la pantalla principal, no una fila más.

**Qué la rompe:** poco. Es UI.

**Por qué podría ser mala idea:** por ninguna. Es la idea más barata después de la 3, y arregla
una queja concreta.

---

### 6. Encolar desde el móvil

**Problema real:** se te ocurre algo en el autobús. Hoy lo apuntas en notas y lo encolas al
llegar — o se te olvida.

**Coste: medio.** La API ya tiene autenticación, sellado y la app ya habla con ella. Falta un
`POST /api/jobs` y que la app tenga un formulario. `addJob()` ya existe y ya valida.

**Qué la rompe:**
- `--dir` desde un móvil no significa nada: hay que ofrecer la lista de proyectos que el PC ya
  conoce (`suggestDirs()` existe), no un campo de texto.
- El teclado del móvil no es un sitio para escribir un prompt de 40 líneas. Esto sirve para
  *capturar la idea*, no para redactar el prompt bueno.

**Por qué podría ser mala idea:** un móvil que puede encolar es un móvil que puede **gastarte el
cupo** — y va con el token metido dentro. Hoy la superficie es de solo lectura y eso es una
propiedad de seguridad, no una carencia. Si se hace, que sea encolar **secuencial y nada más**:
nunca `--at`, nunca lanzar. Que quede esperando a que tú, en el PC, lo mires y le des salida.

---

### 7. Rehacer la pantalla de chat de la app ("se ve feísimo")

**Problema real:** tuyo. Y no es cosmética: la conversación es **el producto** de esta
herramienta. Si es incómoda de leer en el sitio donde más la vas a leer, la herramienta cumple
a medias.

**Coste: medio-alto.** Es trabajo de Compose, no de kaip. No lo abarata nada de lo que hay.

**Qué la rompe:** nada técnico.

**Por qué podría ser mala idea:** por ninguna — pero **hazla después de la nº 1**, porque el
diseño de una conversación *en vivo* (que crece por abajo mientras la miras) no es el mismo que
el de una conversación muerta. Rediseñarla dos veces sería el error caro.

---

### 8. Encadenar jobs (`--needs <id>`)

**Problema real:** "pasa los tests y, **si están verdes**, haz el commit". Hoy no se puede
expresar.

**Coste: medio.** Un campo `needs` y una condición en `schedule.mjs` (que ya decide qué es
lanzable). Lo caro no es eso: es decidir **qué pasa cuando la dependencia se queda sin cupo**.
No ha fallado — está esperando. La cadena tiene que esperar con ella, no romperse. Si eso se
hace mal, el encadenado se convierte en una forma nueva de perder trabajo.

**Por qué podría ser mala idea — y esta es fuerte:** **la herramienta ya sabe encadenar, y se
llama `--target`.** Dos jobs en el mismo target continúan la misma conversación, en orden. Y un
solo prompt que diga "pasa los tests y si están verdes commitea" hace lo mismo **en una sola
conversación, sin pagar el contexto dos veces** — que es más barato *y* más listo, porque el
modelo ve el resultado de los tests con sus propios ojos en vez de que un `if` de JavaScript
mire un código de salida.

El encadenado real solo gana cuando los pasos son **de proyectos distintos** o **muy separados
en el tiempo**. Eso es un caso mucho más estrecho de lo que parecía al proponerlo. **Yo no lo
haría todavía.**

---

### 9. Ruteo por modelo (lo tonto al barato, lo difícil al bueno)

**Problema real:** gastar cupo de Opus en "actualiza el README".

**Coste: ya está medio hecho** — `--model` acaba de dejar de ser una bandera que se tiraba a la
basura, así que **elegir modelo por job ya funciona**. Lo que faltaría es que **kaip elija solo**.

**Por qué podría ser mala idea:** para decidir si un job es "difícil" hay que **entenderlo**, y
eso es una llamada al modelo — **gastas cupo para decidir cómo gastar cupo**. Y la clasificación
va a fallar precisamente en el caso caro: el prompt que parecía tonto y era un avispero.

La versión que sí compensa es **manual y con memoria**: que kaip recuerde con qué modelo lanzaste
la última vez cada `--target` y lo proponga por defecto. Cero adivinación, cero coste.

---

### 10. Reintento con criterio — implemented as a manual retry

**Problema real:** un job falló porque los tests estaban en rojo. Reintentarlo tal cual es
**repetir el error, y pagarlo otra vez**.

**Coste: medio.** Hoy `settle()` ya distingue lo único que importa de verdad: *sin cupo* (vuelve
a la cola) contra *fallo* (se queda como error). Afinar más significa **leer la salida y
juzgarla**.

**Por qué podría ser mala idea — y por eso está tan abajo:** juzgar por qué falló algo es, otra
vez, una llamada al modelo. Gastas cupo para decidir si gastar cupo. Y la respuesta correcta
casi siempre es **no reintentar y enseñarte el error**, que es exactamente lo que ya hace.

The tool now exposes the safe version: the user decides. `kaip retry <id>` and the guided UI's `t`
put an error job back in the queue without discarding its existing session.

---

## Lo que sobra

Esta lista es más corta de escribir y más difícil de admitir. Casi toda está respaldada por los
11 jobs reales: **no es que crea que no se usa, es que no se ha usado.**

### `--perm` — **0 usos de 11, y se lleva un paso entero del asistente**

Nunca lo has tocado. Siempre `bypass`, que además **tiene que ser el default** (un lanzamiento a
las 3am que se para a pedir permiso no hace nada). Pero el asistente de `add` tiene **5 pasos y
uno es este**: cada vez que añades algo, pulsas enter en una pregunta cuya respuesta no has
cambiado jamás.

**Fuera del asistente.** Que siga existiendo como bandera de la CLI para el día raro que haga
falta. Un paso menos en cada `add`, todos los días.

### `--first` — **0 usos de 11**

Tiene campo propio, lógica propia en `schedule.mjs`, tests propios y un apartado en el README —
y no lo has usado nunca. **Pero no se puede borrar**, y conviene saber por qué: lo usa la oferta
de "conversación a medias" por dentro para colar la continuación la primera.

Así que: **que deje de ser público.** Fuera del README y de la ayuda; que sea lo que en realidad
es, el mecanismo interno de la oferta.

### `--file` (el que pega el contenido) — **0 usos; `--from` gana 11-0**

Dos maneras de hacer lo mismo, y llevas 11 lanzamientos usando siempre la buena. `--from` guarda
la **ruta** y lee el fichero **al lanzar**, que es lo que te deja seguir afilando el prompt hasta
el último segundo. `--file` congela el texto al encolar. **Fuera.**

### `run --parallel` — *el candidato incómodo*

Trae carriles, `run-parallel.mjs`, `startable()` y `laneOf()`. Y **fue la causa del bug de
sessions.json** que se acaba de arreglar (tres carriles cargaban el fichero a la vez y el último
en terminar borraba a los otros dos).

Y el cuello de botella de esta herramienta **no es la CPU: es el cupo.** Tres lanzamientos a la
vez vacían la ventana de 5 horas tres veces más rápido y **se mueren los tres juntos**. Paralelo
resuelve un problema que no tienes a cambio de complejidad que sí has pagado, en forma de un bug
que te comió sesiones de verdad.

**Yo lo quitaría.** Si algún día el cupo deja de ser el límite, se vuelve a poner: no es difícil,
solo era prematuro.

### `adapters/opencode.mjs` — un adaptador que solo sabe decir "no implementado"

Existe para *prometer*. Aparece en la ayuda, en `ENGINES`, en un test que comprueba que falla
limpiamente, y en el layout del README. **O se termina, o se borra.** Un stub que lleva meses
siendo un stub es una mentira ordenada.

(A `codex.mjs` le doy un margen: acaba de aterrizar y **sí** construye la invocación de verdad.
Pero si dentro de un mes no ha lanzado nada en serio, se va por lo mismo.)

### `PROMPTHEUS_HOME` y `PROGRAM_PROMPT_HOME`

Dos nombres viejos de variable de entorno, mantenidos vivos "por si alguien los tiene
exportados". El alguien **eres tú**, y ya migraste. **Fuera.**

### `kaip mobile`

Un codificador de QR completo, en pantalla, para abrir una URL de GitHub. Tienes el móvil en la
mano y un navegador dentro. (El QR de **emparejar** es otra cosa completamente: ese es la
frontera de seguridad, porque mete la clave de cifrado en el móvil sin pasarla por el túnel. Ese
se queda.)

### `kaip sessions set`

Cirugía manual sobre `sessions.json`. Existe desde el principio y no aparece ni en el README.

---

## Lo que NO haría (y por qué)

- **Ordenar la cola para que ningún job se corte a mitad.** Suena bien y es la trampa más
  elegante de la lista. Cortarse **ya no cuesta casi nada**: el job vuelve a la cola, mantiene
  su sitio y *continúa* la conversación. Estarías construyendo un planificador para evitar una
  interrupción que ya está resuelta — y encima con estimaciones de duración que varían ×8.
  El aviso barato (idea nº 2) te da el 90 % del valor por el 5 % del trabajo.

- **Que kaip juzgue por qué falló un job, o cómo de difícil es.** Las dos cosas son una llamada
  al modelo para decidir cómo gastar el modelo. Cuando la herramienta tenga que gastar cupo para
  ahorrar cupo, ha perdido el hilo.

- **Un subsistema de configuración.** El doc de migración ya citó uno que no existe y el test de
  comandos fantasma lo cazó. La configuración de esta herramienta cabe en dos ficheros JSON que
  ya existen. No hace falta un subsistema.

  *(Y este documento acaba de tropezar con la misma piedra: escribí los comandos que propongo
  como si se pudieran teclear, en backticks, y el test los cazó a los tres. Por eso arriba se
  habla de "un subcomando de estadísticas" y no del comando escrito tal cual. Un test que caza a
  quien lo escribió es un test que sirve.)*

---

## Si solo hay tiempo para tres

1. **Guardar el `usage` que ya llega** (nº 3). El dato más barato del proyecto, y contesta la
   pregunta que ya te estás haciendo.
2. **Conectar `onEvent` → `publish()`** (nº 1). El cable que falta entre dos mitades que ya
   existen, y es lo que más has pedido.
3. **Quitar el paso de `--perm` del asistente** (Lo que sobra). Un enter menos, cada vez, para
   siempre.

Las tres juntas son menos trabajo que cualquiera de las ideas de la mitad de abajo.
