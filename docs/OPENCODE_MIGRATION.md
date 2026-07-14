# OpenCode en kaiprompt — investigación con el binario delante

**Estado: investigación, no implementación.** No existe `adapters/opencode.mjs` y este documento
no lo escribe. Aquí sólo hay hechos comprobados, hipótesis etiquetadas como tales, y un veredicto.

- **Binario:** `opencode` v1.17.18, instalado vía npm global (`~/AppData/Roaming/npm/opencode`).
- **Fecha de las pruebas:** 2026-07-14. Windows 11, Git Bash.
- **Máquina de pruebas:** credenciales de OpenCode configuradas: **Google (api)** y **OpenCode Zen (api)**.
  Ninguna de Anthropic.

Todo lo que sigue marcado como **VERIFICADO** se ejecutó de verdad y la salida está pegada.
Lo marcado como **NO VERIFICADO** es exactamente eso: no lo pude comprobar, y digo por qué.

---

## Veredicto (léelo primero)

**Es viable, pero no es un adaptador — es una reforma del núcleo.** OpenCode tiene todo lo que
kaiprompt necesita a nivel de proceso (NDJSON, session id, reanudación, modo desatendido), y eso
es mejor de lo que el doc original se atrevía a suponer. El problema está en otro sitio:

> **La detección de cupo de kaiprompt no funciona con OpenCode. Cero de seis.**
> `quota.mjs` reconoce el texto de la *suscripción* de Claude Code, no los 429 de una API.
> Y la reanudación por cupo es el corazón de kaiprompt.

Eso no se arregla en `adapters/opencode.mjs`: hay que tocar `lib/quota.mjs`, que es código
compartido con Claude y está cubierto por los tests. Además, el texto del error **ni siquiera
llega a stdout** (OpenCode lo enmascara), así que el mecanismo de captura también cambia.

**Recomendación honesta: hoy sí compensa, pero sólo si se hace en el orden del plan de abajo
y aceptando que la Fase 2 toca el núcleo.** Un adaptador hecho "en un rato" copiando `claude.mjs`
produciría un sistema que, al primer 429 de madrugada, **marca el job como fallido y pierde el
trabajo** — que es exactamente el bug que kaiprompt existe para no tener.

---

## Lo que el doc original decía y es FALSO

El doc anterior lo escribió Gemini sin acceso al binario y tuvo la decencia de decirlo. Acertó en
varias cosas (ver más abajo). Estas son las que **no** son ciertas, y son las caras:

### 1. FALSO — «RULE: NO debes quitar `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` del entorno»

Estaba listado bajo **"Strict Rules (100% Certainty)"**. No es que sea peligroso: es que **es
irrelevante**. OpenCode no saca las credenciales del entorno, las saca de
`~/.local/share/opencode/auth.json`.

```
$ opencode providers list
┌  Credentials  ~\.local\share\opencode\auth.json
│
●  Google         api
●  OpenCode Zen   api
│
└  2 credentials
```

Y la precedencia va a favor de `auth.json`. Metí una clave basura por entorno y **el run funcionó
igual**, lo que prueba que la clave del entorno ni se mira cuando hay credencial guardada:

```
$ GOOGLE_GENERATIVE_AI_API_KEY=bogus-key-12345 opencode run --format json --auto \
    -m google/gemini-2.5-flash-lite "Reply PONG" </dev/null
EXIT=0
"text":"PONG"
```

**VERIFICADO.** Consecuencia práctica: la regla no hay que "cumplirla", hay que *ignorarla*. Si un
día alguien copia el `delete env.ANTHROPIC_API_KEY` de `claude.mjs` al adaptador de OpenCode, no
romperá nada en esta máquina. El doc presentaba como crítico algo que no lo es, y eso desvía
atención de lo que sí importa (el punto 2).

> **NO VERIFICADO:** si OpenCode *sí* lee claves del entorno cuando el proveedor **no** está en
> `auth.json`. Es plausible (así funcionan los proveedores de models.dev), pero no tengo una clave
> de repuesto de un proveedor sin configurar para probarlo, así que no lo afirmo.

### 2. FALSO — «OpenCode opera vía llamadas API estándar a proveedores»

Dicho así, sin matices, es incorrecto: **OpenCode soporta login con la suscripción Claude Pro/Max**,
no sólo claves de API. Está en el binario, en todos los idiomas de la UI:

```
$ grep -a -o -E "Claude Pro/Max[a-zA-Z /]{0,20}" opencode.exe | sort -u
Claude Pro/Max
Claude Pro/Max oder API      # alemán: "...o API"
Claude Pro/Max ou chave de API
```

**VERIFICADO** (que la opción existe en el binario). Importa mucho, porque el doc construía sobre
esta premisa toda la sección de "OpenCode va por API": **la facturación no es una propiedad de
OpenCode, es una propiedad del proveedor que elijas**. Ver la sección de dinero.

### 3. FALSO (por optimista) — «puede que baste con generar un id local si OpenCode no devuelve session id»

No hace falta ningún apaño: OpenCode emite el `sessionID` **en todos y cada uno de los eventos**, y
la reanudación funciona de verdad. Esto es mejor de lo que el doc esperaba. Ver pregunta 3.

### 4. FALSO (por incompleto) — «capturar stdout podría romper `frames.mjs` por los colores ANSI»

Con `--format json` **no hay ANSI en stdout**: es NDJSON limpio. La sección "busca la manera de
quitar los códigos de escape ANSI" describe un trabajo que no hay que hacer. El riesgo real está en
otro sitio y el doc no lo vio: **stdin** (pregunta 2) y **el enmascarado de errores** (pregunta 4).

### Lo que el doc original acertó, y hay que decirlo

- El prompt va como **argumento**, no por stdin, y `stdio` de entrada debe ser `'ignore'`. Acertó, y
  ahora sé *por qué* importa tanto: si no, el proceso **se cuelga para siempre** (pregunta 2).
- Que hay que interceptar el 429 y dejar que `quota.mjs` reencole en vez de fallar. Acertó en el
  qué; lo que no podía saber es que **el `quota.mjs` actual no lo va a reconocer** (pregunta 4).
- `opencode serve` como futura evolución (un servidor en vez de un proceso por job) existe de
  verdad: está en `opencode --help`.

---

## Las 6 preguntas

### 1. ¿Existe? — **SÍ. VERIFICADO**

```
$ opencode --version
1.17.18
```

### 2. Salida: ¿hay algo tipo `--output-format stream-json`? — **SÍ, se llama `--format json`. VERIFICADO**

`opencode run --help` lo documenta así:

```
--format   format: default (formatted) or json (raw JSON events)
                        [string] [choices: "default", "json"] [default: "default"]
```

Y produce **NDJSON**, una línea por evento, sin colores. Salida real de un run:

```
$ opencode run --format json --auto --dir /tmp/octest -m google/gemini-2.5-flash-lite \
    "Reply with exactly the word PONG and nothing else." </dev/null
EXIT=0

{"type":"step_start","timestamp":1784008464151,"sessionID":"ses_0a0cf3487ffeMAxnCdBCEYNnvS","part":{...,"type":"step-start"}}
{"type":"text","timestamp":1784008464152,"sessionID":"ses_0a0cf3487ffeMAxnCdBCEYNnvS","part":{"type":"text","text":"PONG","time":{...}}}
{"type":"step_finish","timestamp":1784008464742,"sessionID":"ses_0a0cf3487ffeMAxnCdBCEYNnvS","part":{"type":"step-finish","reason":"stop","tokens":{"total":9340,"input":474,"output":2,"reasoning":0,"cache":{"write":0,"read":8864}},"cost":0.00013684}}
```

Esto es **buena noticia**: la vista en vivo de kaiprompt se alimenta de NDJSON y aquí hay NDJSON.
No hay que quitar ANSI de nada.

Diferencias de forma con Claude Code, que el adaptador tendrá que absorber:

| | Claude Code | OpenCode |
|---|---|---|
| id de sesión | `session_id` | `sessionID` |
| texto | evento `text` | evento `text`, en `part.text` |
| resultado final | evento `result` con el texto completo | **no existe** |
| coste | — | `part.cost` en `step_finish` |

**El que duele es "no existe `result`".** `claude.mjs` se apoya en ese evento para saber el texto
final y si hubo error (`is_error`). Con OpenCode hay que **acumular los eventos `text`** y decidir
el éxito por el código de salida más la ausencia de eventos `error`.

#### ⚠️ La trampa: `stdin` abierto **cuelga el proceso**. VERIFICADO

Esto no lo dice ninguna documentación y me costó dos minutos de timeout descubrirlo. Con el mismo
comando, cambiando **sólo** la redirección de stdin:

```
# stdin cerrado  → funciona
$ opencode run --format json ... "Reply with exactly PONG" </dev/null
EXIT=0   stdout=1043 bytes

# stdin heredado (una tubería abierta que nadie cierra) → SE CUELGA
$ opencode run --format json ... "Reply with exactly PONG"
EXIT=124   (timeout a los 45s)   stdout=0 bytes
último log: message=init      ← se queda ahí para siempre
```

**Cero bytes.** Un adaptador copiado de `claude.mjs` (que hace `stdio: ['pipe', ...]` para escribir
el prompt) y al que se le olvide cerrar stdin **no falla: se cuelga a las 3am sin escribir nada**,
que es el peor modo de fallo posible. `stdio[0]` **debe** ser `'ignore'`.

### 3. Session id y reanudación — **SÍ A TODO. VERIFICADO. Es la mejor noticia del informe**

- **Lo emite:** en el campo `sessionID` de **cada** evento NDJSON (formato `ses_0a0cf3487ffe…`).
  No hay que parsear texto ni inventarse un id local.
- **Se reanuda:** `opencode run -s <session-id>` (también `-c` para "la última", y `--fork` para
  bifurcar). Está en `opencode run --help`.

Y no es sólo que acepte el flag: **conserva el contexto de verdad.** Reanudé la sesión del PONG y le
pregunté por el turno anterior:

```
$ opencode run --format json --auto -s ses_0a0cf3487ffeMAxnCdBCEYNnvS \
    "What single word did you reply with a moment ago? Answer with just that word." </dev/null
EXIT=0
TEXT: "PONG" | sessionID: ses_0a0cf3487ffeMAxnCdBCEYNnvS
```

Recordó el turno anterior y **reusó el mismo id**. Por tanto **`--target` y la reanudación por cupo
son posibles**. Sin esto el encargo se habría acabado aquí; con esto, sigue vivo.

### 4. Límites: ¿qué escupe con un 429? — **PARCIALMENTE VERIFICADO. Y es el problema gordo**

Aquí hay dos hallazgos, y los dos son malos.

#### 4a. OpenCode **enmascara** los errores en stdout. VERIFICADO

Provoqué dos errores distintos (modelo inexistente; proveedor sin credenciales). Los dos dieron
**exactamente el mismo** evento genérico, **exit 1**, y **stderr completamente vacío**:

```
$ opencode run --format json -m google/does-not-exist-9000 "hi" </dev/null
EXIT=1
stdout: {"type":"error","timestamp":...,"sessionID":"ses_...","error":{"name":"UnknownError",
         "data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_d21db488"}}}
stderr: (vacío)
```

El texto real del error **no está**. Sólo un `ref`. Y `quota.mjs` detecta el cupo **por el texto**.

**El texto real sí aparece en stderr, pero sólo si pasas `--print-logs`:**

```
$ opencode run --format json -m anthropic/claude-sonnet-4-5 --print-logs --log-level ERROR "hi" </dev/null
EXIT=1
stderr: timestamp=... level=ERROR message=failed ref=err_653c4dad
        error="ProviderModelNotFoundError: Model not found: anthropic/claude-sonnet-4-5..."
```

Conclusión para el adaptador: **hay que lanzar siempre con `--print-logs --log-level ERROR`** y
sacar el motivo de la línea `message=failed ... error="…"` de **stderr**, no del evento de stdout.
Un port ingenuo que alimente `isQuotaExhausted()` con `err` (como hace `claude.mjs`) recibiría
**cadena vacía siempre** → nunca detecta cupo → **el job se marca fallido y el trabajo se pierde**.

#### 4b. El regex de `quota.mjs` no reconoce NINGÚN mensaje de API. VERIFICADO

Esto es lo más importante del informe. Pasé mensajes reales de 429 por el `isQuotaExhausted()` que
hay hoy en `lib/quota.mjs`:

```
$ node -e "…import('./lib/quota.mjs')… isQuotaExhausted(s)"

MISSED   | 429 Too Many Requests
MISSED   | Rate limit exceeded. Please retry after 30s
MISSED   | RESOURCE_EXHAUSTED: Quota exceeded for quota metric
MISSED   | You exceeded your current quota, please check your plan and billing details
MISSED   | the quota has been exceeded
MISSED   | Error: Overloaded
DETECTED | You've hit your session limit · resets 1:30pm (Europe/Madrid)     ← Claude Code
```

**Seis de seis fallados.** El regex actual…

```js
const LIMIT_RE = /(hit|reached|exceeded).{0,24}\b(session|usage|rate|weekly|week)\s*limit|limit reached|out of (usage|credits)/i;
```

…exige el verbo **antes** del sustantivo ("*exceeded* your *rate limit*"), pero las APIs lo dicen al
revés ("*Rate limit* **exceeded**"). Por eso ni el caso más obvio pasa.

Y hay un segundo nivel: aunque se arregle la detección, **`parseResetAt()` tampoco sirve**. Busca
`"resets 1:30pm"`, que es lenguaje de suscripción. Una API no dice cuándo se renueva: manda una
cabecera `Retry-After` (segundos). Con lo que hay hoy, `quotaVerdict()` caería al `source:
'fallback'` y **aparcaría el job 5 horas** cuando el límite se levanta en 30 segundos.

> **NO VERIFICADO:** el texto **exacto** que produce OpenCode en un 429 real. No he podido forzar uno:
> requeriría martillear una API de pago hasta que me corte, lo cual cuesta dinero y es abusivo.
> Lo que sí sé es que las cadenas están dentro del binario (`429 Too Many Requests`,
> `.RateLimitError`, `the quota has been exceeded`, `RESOURCE_EXHAUSTED`), y que **el texto que llegue
> lo pondrá el proveedor, no OpenCode** — o sea que será distinto para Google, Anthropic o Zen.
> **Esto hay que capturarlo del primer 429 real que ocurra**, no adivinarlo.

### 5. Desatendido: ¿cuál es su `--dangerously-skip-permissions`? — **`--auto`. VERIFICADO**

De `opencode run --help`, textualmente:

```
--auto   auto-approve permissions that are not explicitly denied (dangerous!)
                                                    [boolean] [default: false]
```

Todos los runs de este informe se lanzaron con `--auto` y ninguno pidió confirmación. El
equivalente existe, el job de las 3am no se queda esperando una tecla. (El doc original lo llamaba
`--yes` / `--auto-confirm`: el nombre era inventado, el concepto correcto.)

También relevante para el adaptador: **`--dir <ruta>`** hace lo que `cwd` en `claude.mjs`.

### 6. Autenticación y **dinero** — **VERIFICADO, y el doc lo tenía al revés**

Ya está arriba: no hay que quitar claves del entorno porque **el entorno no es de donde salen**
(`auth.json`), y OpenCode **sí** puede usar suscripción Claude Pro/Max además de claves de API.

Pero lo que importa es la factura. **En esta máquina, los dos proveedores configurados (Google y
OpenCode Zen) son API de pago.** Lanzar un job con OpenCode **gasta dinero real**, y no es teórico:

```
$ opencode stats
│ Total Cost      $13.37 │
│ Avg Cost/Day     $0.21 │
```

Cada run devuelve su coste exacto en el `step_finish` (`"cost":0.00013684` por el PONG de prueba).

**Kaiprompt existe en parte para NO gastar API** — `claude.mjs` borra las claves precisamente para
forzar la suscripción. Un adaptador que lance por API invierte esa decisión, así que **tiene que
decirlo en la cara antes de lanzar nada.** Cómo debería avisar:

1. **Al encolar** (`kaip add … --agent opencode`), no al ejecutar: avisar cuando el usuario ya se ha
   ido a dormir no sirve de nada.
2. **Decir el proveedor y que se factura**, no un genérico "esto puede costar dinero":
   > ⚠️  `opencode` + `google/gemini-2.5-flash-lite` → **API de pago**. Esta cola gastará dinero real
   > (a día de hoy llevas $13.37). Claude Code va por suscripción y no cobra por uso.
   > Confirma con `--yes-i-pay` (o `kaip config opencode.confirmed true`).
3. **Exigir confirmación explícita la primera vez** y guardarla; no preguntar en cada `add`.
4. **Acumular el coste real** de los `step_finish` y enseñarlo al terminar la tanda (kaiprompt ya
   tiene dónde: el resumen de la tanda). Es dato gratis, sería tonto tirarlo.
5. Si algún día se configura el login **Claude Pro/Max** en OpenCode, el aviso **no debe salir**:
   ahí no se factura. El aviso depende del **proveedor**, no del agente.

---

## Qué se pierde respecto a Claude Code

- **La red de seguridad del cupo, tal cual está hoy** (§4). Es lo más grave.
- **`resets_at` fiable.** Claude Code te dice *cuándo* vuelve el cupo. Una API no. Además
  `lib/quota.mjs` lee `~/.claude/usage.json`, que es un artefacto **de Claude Code** y con OpenCode
  no existe: `readUsage()` devolverá `null` y `resetFromUsage()` también.
- **El evento `result`**, es decir, "el texto final de la respuesta" servido en bandeja (§2).
- **Coste cero.** Se cambia cupo de suscripción por factura (§6).

Y se **gana**: elección de modelo (`-m proveedor/modelo`), `--fork` de sesiones, `opencode serve`
para no pagar el arranque de un proceso por job, y coste medido por run.

---

## Plan por fases (si se decide seguir)

**Fase 0 — decidir el proveedor antes que nada.** Si la respuesta es "Claude Pro/Max por OAuth", casi
todo el problema de dinero desaparece y el 429 cambia de forma. Si es "Google/Zen por API", asumimos
factura y el aviso de §6 es obligatorio. *No se escribe código hasta que esto esté decidido*, porque
determina la Fase 2 entera.

**Fase 1 — el adaptador, sin tocar el núcleo.** `adapters/opencode.mjs`:
- `stdio[0] = 'ignore'` — **innegociable**, o se cuelga (§2).
- Prompt como argv; `--format json`, `--auto`, `--dir`, `-m`, `-s <sid>`.
- **Siempre `--print-logs --log-level ERROR`**, y el motivo del fallo se saca de **stderr** (§4a).
- Normalizar los eventos a la forma que espera la vista (`sessionID`→`session_id`, `part.text`→`text`)
  y **sintetizar el `result`** acumulando los `text`.
- Salida esperada: los jobs corren y se ven en vivo. **El cupo aún no funciona.** Y hay que decirlo,
  no dejar que parezca terminado.

**Fase 2 — el núcleo: `lib/quota.mjs`.** Aquí está el trabajo de verdad, y toca código compartido con
Claude (hay tests que lo cubren, y ninguno debe ponerse rojo):
- Extender `LIMIT_RE` para los mensajes de API (§4b) — cubriendo el orden invertido
  ("rate limit exceeded") y `429` / `RESOURCE_EXHAUSTED` / `quota exceeded`.
- Enseñar a `parseResetAt()` los reintentos relativos (`Retry-After: 30`, "retry after 30s"), que hoy
  no entiende: sin esto, un límite de 30 segundos aparca el job 5 horas.
- Que `readUsage()`/`resetFromUsage()` degraden limpiamente cuando no hay `usage.json` (caso OpenCode).
- **Tests con los textos reales**, no con los que yo he supuesto.

**Fase 3 — el aviso de dinero** (§6): confirmación al encolar, coste acumulado en el resumen de tanda.

**Fase 4 — opcional: `opencode serve`.** Un servidor en vez de un proceso por job. Es la idea buena
del doc original y sigue en pie, pero es optimización: no antes de que las fases 1-3 estén verdes.

**Regla que me ahorraría el susto:** el primer 429 real que ocurra en producción, **guardar el texto
crudo** en algún sitio. Es el único dato que este informe no ha podido conseguir, y es el que decide
si la Fase 2 está bien hecha.

---

## Reproducibilidad

Todos los comandos de este documento se ejecutaron en `/tmp/octest` (repo git vacío) contra
`google/gemini-2.5-flash-lite`. Coste total de la investigación: **por debajo de $0.01**.

Los tests de kaiprompt siguen verdes — **418 pasan, 0 fallan** — porque **no se ha tocado ni una
línea de código**. (El encargo hablaba de 371; el árbol de trabajo ya traía cambios sin commitear
que añaden tests. No son míos.)
