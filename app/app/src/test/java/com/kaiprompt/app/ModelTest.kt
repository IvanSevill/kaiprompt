package com.kaiprompt.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Lo que manda el PC, tal cual, y lo que el móvil entiende.
 *
 * Los JSON de aquí están copiados de lo que devuelve lib/server.mjs de verdad. Si el
 * servidor cambia de forma, estos tests se caen en la máquina que compila — que es mucho
 * mejor que enterarse con el móvil en la mano y sin poder depurar.
 */
class ModelTest {

    @Test
    fun `quota canonico conserva limites arbitrarios y desconocidos como null`() {
        val quota = ProviderQuota.parse(
            """{"provider":"codex","status":"available","source":{"kind":"app-server","official":true},"freshness":{"observedAt":"2026-07-15T10:00:00Z","stale":false},"limits":{"requests":{"id":"requests","primary":{"remainingPercent":null,"resetAt":"2026-07-15T12:00:00Z"},"secondary":{"remainingPercent":37.5,"resetAt":null}},"tokens-special":{"id":"tokens-special","primary":{"remainingPercent":9}}},"plan":"plus","credits":{"balance":null,"hasCredits":false,"unlimited":null},"error":null}""",
        )
        assertEquals("codex", quota.provider)
        assertEquals(listOf("requests", "tokens-special"), quota.limits.map { it.id })
        assertNull(quota.limits.first().primary?.remainingPercent)
        assertEquals(37.5, quota.limits.first().secondary?.remainingPercent)
        assertEquals("plus", quota.plan)
        assertEquals(false, quota.credits?.hasCredits)
        assertNull(quota.credits?.balance)
        assertNull(quota.error)
    }

    @Test
    fun `quota no disponible conserva error y frescura desconocida`() {
        val quota = ProviderQuota.parse(
            """{"provider":"claude","status":"unavailable","source":{"kind":null,"official":null},"freshness":{"observedAt":null,"stale":null},"limits":{},"error":{"code":"auth-unavailable","message":null}}""",
        )
        assertEquals("unavailable", quota.status)
        assertNull(quota.freshness.stale)
        assertEquals("auth-unavailable", quota.error?.code)
        assertTrue(quota.limits.isEmpty())
    }

    // --- emparejamiento -----------------------------------------------------------
    @Test
    fun `el QR de emparejamiento se lee entero`() {
        val p = Pairing.parse(
            """{"v":1,"url":"https://algo.trycloudflare.com/","lan":"http://192.168.1.23:7777",
               "token":"tok","key":"clave","host":"MI-PC","tunnel":true}"""
        )
        assertEquals("https://algo.trycloudflare.com", p.url)   // sin la barra final
        assertEquals("tok", p.token)
        assertEquals("clave", p.key)
        assertTrue(p.tunnel)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `un QR que no es de Kaiprompt se rechaza`() {
        Pairing.parse("""{"algo":"otro"}""")
    }

    // --- el estado ------------------------------------------------------------------
    private val estado = """
    {
      "host":"MI-PC","now":1700000000000,
      "jobs":[
        {"id":"j1","status":"pending","prompt":"corre los tests","promptFile":null,
         "promptError":null,"preview":"corre los tests","target":"fixes","sessionId":null,
         "dir":"C:/p","when":1700000600000,"createdAt":1,"startedAt":null,"finishedAt":null,
         "error":null,"hasOutput":false},
        {"id":"j2","status":"done","prompt":"otra cosa","promptFile":null,"promptError":null,
         "preview":"otra cosa","target":null,"sessionId":"s-1","dir":"C:/p","when":null,
         "createdAt":1,"startedAt":2,"finishedAt":3,"error":null,"hasOutput":true}
      ],
      "counts":{"pending":1,"running":0,"done":1,"error":0,"missed":0},
      "daemon":{"running":false,"pid":null,"next":null},
       "quota":{"freePct":73,"resetsAt":1700003600000,"renewed":false,
                "weekly":{"freePct":61,"resetsAt":1700503600000}}
    }
    """

    @Test
    fun `el estado se parsea entero`() {
        val s = State.parse(estado)
        assertEquals("MI-PC", s.host)
        assertEquals(2, s.jobs.size)
        assertEquals(1, s.pending)
        assertEquals("corre los tests", s.jobs[0].prompt)
        assertEquals(73, s.quota?.freePct)
        assertEquals(61, s.quota?.freePctWeek)
        assertEquals(1700503600000L, s.quota?.resetsAtWeek)
    }

    @Test
    fun `job y chat aceptan conversationId aditivo`() {
        val job = State.parse("""{"jobs":[{"id":"j","conversationId":"c-1"}]}""").jobs.single()
        val chat = Chat.parse("""{"sessionId":"s","conversationId":"c-1","turns":[]}""")
        assertEquals("c-1", job.conversationId)
        assertEquals("c-1", chat.conversationId)
    }

    @Test
    fun `snapshot parsea estado y visibilidad en una sola respuesta`() {
        val snapshot = Snapshot.parse(
            """{"state":{"host":"PC","jobs":[{"id":"j","status":"done","conversationId":"c"}]},"conversations":[{"conversationId":"c","ref":"j","status":"done","hidden":true,"jobs":["j"]}]}""",
        )
        assertEquals("PC", snapshot.state.host)
        assertEquals("c", snapshot.conversations.single().conversationId)
        assertTrue(snapshot.conversations.single().hidden)
    }

    @Test
    fun `avisa si hay trabajo agendado y el daemon esta APAGADO`() {
        // La pregunta que el móvil más necesita responder: ¿va a dispararse algo siquiera?
        // Un agendado con el daemon caído no corre nunca, y enterarse por la mañana es tarde.
        assertTrue(State.parse(estado).scheduledButDead)
    }

    @Test
    fun `con el daemon encendido no avisa de nada`() {
        val vivo = estado.replace("\"running\":false", "\"running\":true")
        assertFalse(State.parse(vivo).scheduledButDead)
    }

    @Test
    fun `sin agendados no avisa aunque el daemon este apagado (no hay promesa que romper)`() {
        val sinHora = estado.replace("\"when\":1700000600000", "\"when\":null")
        assertFalse(State.parse(sinHora).scheduledButDead)
    }

    @Test
    fun `un null de JSON NO se convierte en la palabra "null"`() {
        // org.json devuelve el STRING "null", que es como acabas pintando la palabra null
        // en pantalla. Este es el test que impide esa vergüenza.
        val s = State.parse(estado)
        assertNull(s.jobs[0].sessionId)
        assertNull(s.jobs[0].promptFile)
        assertNull(s.jobs[1].target)
        assertNull(s.jobs[0].startedAt)
    }

    @Test
    fun `un campo que el PC no manda (version vieja) no rompe el movil`() {
        val viejo = """{"host":"X","jobs":[{"id":"j1","status":"done"}]}"""
        val s = State.parse(viejo)
        assertEquals(1, s.jobs.size)
        assertNull(s.jobs[0].prompt)
        assertFalse(s.daemon.running)
        assertNull(s.quota)
    }

    @Test
    fun `un PC viejo sin cuota semanal sigue mostrando la cuota de sesion`() {
        val s = State.parse("""{"host":"X","jobs":[],"quota":{"freePct":73,"resetsAt":1,"renewed":false}}""")
        assertEquals(73, s.quota?.freePct)
        assertNull(s.quota?.freePctWeek)
    }

    @Test
    fun `un job enlazado cuyo archivo desaparecio se ve como error, no como prompt vacio`() {
        val roto = """
        {"host":"X","jobs":[{"id":"j1","status":"pending","prompt":null,
         "promptFile":"C:/p/x.md","promptError":"the prompt file is gone","preview":"⚠ x.md"}]}
        """
        val j = State.parse(roto).jobs[0]
        assertNull(j.prompt)
        assertEquals("the prompt file is gone", j.promptError)
    }

    // --- la conversación -------------------------------------------------------------
    @Test
    fun `la conversacion se aplana a lo que cabe en una pantalla`() {
        val chat = Chat.parse(
            """
            {"sessionId":"s-1","target":"fixes","adapter":"opencode","provider":"openai","model":"gpt-5.6-terra","dir":"C:/p","turns":[
              {"role":"user","at":"2026-01-01T10:00:00Z","blocks":[{"type":"text","text":"arregla esto"}]},
               {"role":"assistant","at":"2026-01-01T10:00:05Z","blocks":[
                 {"type":"text","text":"voy"},
                 {"type":"tool","name":"Edit","input":{"file_path":"lib/ui.mjs"}}
               ],"diffs":[{"file":"lib/ui.mjs","added":2,"removed":1,"diff":"-old\n+new"}]}
            ]}
            """
        )
        assertEquals(2, chat.turns.size)
        assertEquals("fixes", chat.target)
        assertEquals("OPENCODE · OPENAI", chat.assistantLabel)

        val tool = chat.turns[1].blocks[1] as Block.Tool
        assertEquals("Edit", tool.name)
        assertEquals("lib/ui.mjs", tool.arg)
        assertEquals(1, chat.turns[1].diffs.size)
        assertEquals(2, chat.turns[1].diffs[0].added)
        assertEquals(listOf("-old", "+new"), chat.turns[1].diffs[0].lines)
    }

    @Test
    fun `los turnos de eco de herramientas no ensucian la conversacion`() {
        // Un turno "user" que solo lleva tool_result es el eco de la herramienta, no la
        // persona. Pintarlo haría parecer que hablaste tú.
        val chat = Chat.parse(
            """
            {"sessionId":"s","turns":[
              {"role":"user","toolResult":true,"blocks":[{"type":"tool_result","text":"ok"}]},
              {"role":"assistant","blocks":[{"type":"text","text":"hecho"}]}
            ]}
            """
        )
        assertEquals(1, chat.turns.size)
        assertEquals("assistant", chat.turns[0].role)
    }

    @Test
    fun `una conversacion vacia no revienta`() {
        val chat = Chat.parse("""{"sessionId":"s","turns":[]}""")
        assertEquals(0, chat.turns.size)
        assertNull(chat.assistantLabel)
    }

    // --- el QR compacto ---------------------------------------------------------
    // Cada byte del payload es un modulo del QR. El formato largo llegaba a 232 bytes: una
    // version 11, 61x61 modulos que la camara tiene que resolver en dos centimetros de
    // terminal. Justo en el limite — y una URL de tunel larga lo empujaba al otro lado. De
    // ahi que un QR que ayer escaneaba hoy no.
    //
    // Leer los DOS formatos es lo que permite que una app vieja siga funcionando contra un
    // PC nuevo, y al reves.

    @Test
    fun `lee el QR compacto`() {
        val p = Pairing.parse("""{"v":1,"u":"https://algo.trycloudflare.com","t":"tok","k":"clave","l":"http://192.168.1.5:7777"}""")
        assertEquals("https://algo.trycloudflare.com", p.url)
        assertEquals("tok", p.token)
        assertEquals("clave", p.key)
        assertEquals("http://192.168.1.5:7777", p.lan)
        assertTrue(p.tunnel)
    }

    @Test
    fun `sigue leyendo el QR largo (un PC viejo no deja de funcionar)`() {
        val p = Pairing.parse("""{"v":1,"url":"http://192.168.1.5:7777","token":"tok","key":"clave","host":"PC","tunnel":false}""")
        assertEquals("http://192.168.1.5:7777", p.url)
        assertEquals("tok", p.token)
        assertFalse(p.tunnel)
    }

    @Test
    fun `el tunel se deduce del esquema (ya no se manda)`() {
        assertTrue(Pairing.parse("""{"v":1,"u":"https://x.trycloudflare.com","t":"a","k":"b"}""").tunnel)
        assertFalse(Pairing.parse("""{"v":1,"u":"http://192.168.1.5:7777","t":"a","k":"b"}""").tunnel)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `un QR sin clave se rechaza (media pareja no sirve de nada)`() {
        Pairing.parse("""{"v":1,"u":"https://x.com","t":"tok"}""")
    }

    // --- BUG 3: el nombre que salia "?" ------------------------------------------
    //
    // El QR compacto dejo de llevar `host`, pero Pairing seguia teniendo un campo `host` que
    // por defecto valia "?". Asi que el "?" no era un hueco gestionado: era un hueco PINTADO.
    // Salia en la barra de arriba, y salia dentro del mensaje de error ("no llego a ?").
    //
    // Ya no existe el campo. El nombre del PC viene de /api/state, que siempre lo manda; el
    // del movil lo manda el movil. Cada nombre, de la maquina que lo sabe.

    @Test
    fun `el emparejamiento ya no acarrea ningun nombre que pintar`() {
        // Si `host` volviera a existir en Pairing, esto no compila. Ese es el punto.
        val campos = Pairing::class.java.declaredFields.map { it.name }
        assertFalse("Pairing no puede volver a tener un host que valga \"?\"", campos.contains("host"))
    }

    @Test
    fun `el QR largo trae host y da igual, no se guarda ni se pinta`() {
        // Compatibilidad: un PC viejo sigue mandando "host". Se ignora, no se rechaza.
        val p = Pairing.parse("""{"v":1,"url":"http://192.168.1.5:7777","token":"t","key":"k","host":"MI-PC"}""")
        assertEquals("http://192.168.1.5:7777", p.url)
    }

    @Test
    fun `el identificador de instalación es un UUID no derivado del nombre del móvil`() {
        val id = DeviceId.new()
        assertTrue(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").matches(id))
    }

    @Test
    fun `el nombre del PC sale de api-state, que siempre lo manda`() {
        assertEquals("MI-PC", State.parse(estado).host)
    }

    @Test
    fun `un job sin status no se queda en "?"`() {
        // status caia a "?" por defecto y se pintaba tal cual en la tarjeta del job.
        val j = State.parse("""{"host":"X","jobs":[{"id":"j1"}]}""").jobs[0]
        assertEquals("pending", j.status)
        assertTrue(j.pending)
    }

    // --- BUG 6: los cinco estados de la franja de arriba --------------------------
    //
    // Los derivamos en el PC y viajan ya hechos, para que el panel del terminal y esta
    // pantalla no puedan contarte historias distintas. Aqui se comprueba que llegan enteros.
    //
    // La pareja que justifica todo esto es `quota` y `stalled`: desde el movil se ven IGUAL
    // —no se mueve nada— y significan lo contrario.

    private fun conActividad(a: String) =
        State.parse("""{"host":"X","jobs":[],"activity":$a}""").now

    @Test
    fun `ejecutando - con que job y desde cuando`() {
        val n = conActividad("""{"state":"running","jobId":"j1","preview":"los tests","since":1700000000000}""")
        assertEquals(Activity.RUNNING, n.activity)
        assertEquals("los tests", n.preview)
        assertEquals(1700000000000L, n.since)
    }

    @Test
    fun `esperando cupo - y CUANDO vuelve`() {
        // El dato entero: sin la hora de vuelta, "esperando" es indistinguible de "colgado".
        val n = conActividad("""{"state":"quota","jobId":"j1","until":1700003600000,"pending":3}""")
        assertEquals(Activity.QUOTA, n.activity)
        assertEquals(1700003600000L, n.until)
        assertEquals(3, n.pending)
    }

    @Test
    fun `parado - hay cola y NADIE que la drene`() {
        val n = conActividad("""{"state":"stalled","pending":2,"scheduled":2}""")
        assertEquals(Activity.STALLED, n.activity)
        assertEquals(2, n.scheduled)
    }

    @Test
    fun `en espera - hay cola y hay quien la drene`() {
        val n = conActividad("""{"state":"queued","pending":1,"next":1700000600000}""")
        assertEquals(Activity.QUEUED, n.activity)
        assertEquals(1700000600000L, n.next)
    }

    @Test
    fun `al dia - no hay nada pendiente`() {
        assertEquals(Activity.IDLE, conActividad("""{"state":"idle","pending":0}""").activity)
    }

    @Test
    fun `un PC viejo que no manda la franja no la inventa`() {
        // UNKNOWN se pinta como "…", no como "Al día". Decir "todo en orden" cuando no lo
        // sabemos es exactamente la mentira que este proyecto se dedica a no contar.
        assertEquals(Activity.UNKNOWN, State.parse("""{"host":"X","jobs":[]}""").now.activity)
    }

    @Test
    fun `un job cortado por el cupo lo dice el propio job`() {
        val ahora = System.currentTimeMillis()
        val j = State.parse(
            """{"host":"X","jobs":[{"id":"j1","status":"pending","pausedUntil":${ahora + 3_600_000}}]}"""
        ).jobs[0]
        assertTrue(j.waitingForQuota(ahora))

        // Y cuando el cupo ya volvio, deja de estarlo: no se queda clavado.
        assertFalse(j.waitingForQuota(ahora + 7_200_000))
    }

    // --- Ajustes ------------------------------------------------------------------
    @Test
    fun `ajustes trae el tunel, las IPs conectadas y las versiones`() {
        val s = State.parse(
            """
            {"host":"MI-PC","jobs":[],
             "daemon":{"running":true,"kind":"daemon","durable":true,"pid":123,"since":1700000000000},
             "server":{"version":"2.0.0","startedAt":1700000000000,
                       "tunnel":"https://algo.trycloudflare.com",
                       "clients":[{"ip":"192.168.1.44","calls":9},{"ip":"10.0.0.2","calls":1}]}}
            """
        )
        assertEquals("https://algo.trycloudflare.com", s.server.tunnel)
        assertEquals(listOf("192.168.1.44", "10.0.0.2"), s.server.clients)
        assertEquals("2.0.0", s.server.version)
        assertEquals(1700000000000L, s.daemon.since)   // cuanto lleva corriendo quien drena
    }

    @Test
    fun `sin tunel (modo wifi) Ajustes no se inventa una direccion`() {
        val s = State.parse("""{"host":"X","jobs":[],"server":{"version":"2.0.0","tunnel":null,"clients":[]}}""")
        assertNull(s.server.tunnel)
        assertTrue(s.server.clients.isEmpty())
    }

    @Test
    fun `chat conserva todos los turnos y los todos estructurados`() {
        val chat = Chat.parse(
            """{"sessionId":"s","cursor":"a:2","turns":[
              {"role":"user","blocks":[{"type":"text","text":"uno"}]},
              {"role":"assistant","live":true,"blocks":[
                {"type":"text","text":"dos","eventId":"a:1"},
                {"type":"todos","eventId":"a:2","todos":[{"content":"probar","status":"in_progress"}]}
              ]}
            ]}"""
        )
        assertEquals(2, chat.turns.size)
        assertEquals("a:2", chat.cursor)
        assertTrue("a:1" in chat.eventIds)
        assertEquals("probar", chat.turns[1].blocks.filterIsInstance<Block.Todos>().single().items.single().content)
    }

    @Test
    fun `evento live y estado de pairing se parsean sin inventar campos`() {
        val event = LiveEvent.parse("""{"id":"x:1","jobId":"j","kind":"tool","name":"Read","input":{"file_path":"a.kt"}}""")
        assertEquals("x:1", event.id)
        assertEquals("a.kt", event.arg)
        assertEquals(PairingState("pairing", false, 2), PairingState.parse("""{"mode":"pairing","registered":false,"protocol":2}"""))
    }

    @Test
    fun `chat y live comparten prioridad de argumentos y parseo de todos`() {
        val chat = Chat.parse(
            """{"sessionId":"s","turns":[{"role":"assistant","blocks":[
              {"type":"tool","name":"Read","eventId":"e:1","input":{"command":"later","file_path":"first.kt"}},
              {"type":"todos","eventId":"e:2","todos":[null,{"content":"probar","activeForm":"probando"}]}
            ]}]}""",
        )
        val liveTool = LiveEvent.parse(
            """{"id":"e:3","kind":"tool","input":{"command":"later","file_path":"first.kt"}}""",
        )
        val liveTodos = LiveEvent.parse(
            """{"id":"e:4","kind":"todos","todos":[null,{"content":"probar","activeForm":"probando"}]}""",
        )

        assertEquals("first.kt", (chat.turns.single().blocks[0] as Block.Tool).arg)
        assertEquals("first.kt", liveTool.arg)
        assertEquals("pending", (chat.turns.single().blocks[1] as Block.Todos).items.single().status)
        assertEquals(liveTodos.todos, (chat.turns.single().blocks[1] as Block.Todos).items)
        assertEquals(setOf("e:1", "e:2"), chat.eventIds)
        assertEquals("e:4", liveTodos.id)
    }

    @Test
    fun `arrays de strings omiten vacios null y valores no textuales`() {
        val chat = Chat.parse(
            """{"sessionId":"s","eventIds":["a","",null,{"id":"no"},"b"],"turns":[]}""",
        )

        assertEquals(setOf("a", "b"), chat.eventIds)
    }

    @Test
    fun `diff-only turns and live canonical diffs retain signs and truncation`() {
        val chat = Chat.parse(
            """{"sessionId":"s","turns":[{"role":"assistant","live":true,"blocks":[],"diffs":[{"id":"d1","file":"a.kt","added":1,"removed":1,"lines":["-old","+new"],"truncated":true,"truncationReason":"line-limit","eventId":"e1"}]}]}""",
        )
        val diff = chat.turns.single().diffs.single()
        assertEquals(listOf("-old", "+new"), diff.lines)
        assertTrue(diff.truncated)
        assertEquals("line-limit", diff.truncationReason)
        assertTrue("e1" in chat.eventIds)

        val event = LiveEvent.parse(
            """{"id":"e2","jobId":"j","kind":"diff","diff":{"id":"d2","file":"b.kt","added":1,"removed":1,"lines":["-gone","+here"]}}""",
        )
        assertEquals(listOf("-gone", "+here"), event.diff?.lines)
        assertEquals("e2", event.diff?.eventId)
    }
}
