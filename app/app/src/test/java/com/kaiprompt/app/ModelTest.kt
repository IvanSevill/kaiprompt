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
      "quota":{"freePct":73,"resetsAt":1700003600000,"renewed":false}
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
            {"sessionId":"s-1","target":"fixes","dir":"C:/p","turns":[
              {"role":"user","at":"2026-01-01T10:00:00Z","blocks":[{"type":"text","text":"arregla esto"}]},
              {"role":"assistant","at":"2026-01-01T10:00:05Z","blocks":[
                {"type":"text","text":"voy"},
                {"type":"tool","name":"Edit","input":{"file_path":"lib/ui.mjs"}}
              ]}
            ]}
            """
        )
        assertEquals(2, chat.turns.size)
        assertEquals("fixes", chat.target)

        val tool = chat.turns[1].blocks[1] as Block.Tool
        assertEquals("Edit", tool.name)
        assertEquals("lib/ui.mjs", tool.arg)
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
        assertEquals(0, Chat.parse("""{"sessionId":"s","turns":[]}""").turns.size)
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
}
