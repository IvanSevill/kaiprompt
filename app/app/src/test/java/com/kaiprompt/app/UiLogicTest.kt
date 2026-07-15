package com.kaiprompt.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UiLogicTest {
    private fun job(id: String = "j1", prompt: String? = null, preview: String = "") = Job(
        id = id, status = "pending", prompt = prompt, promptFile = null, promptError = null,
        preview = preview, target = null, sessionId = null, dir = null, whenAt = null,
        startedAt = null, finishedAt = null, pausedUntil = null, error = null,
    )

    private fun state(jobs: List<Job>) = State(
        host = "pc", jobs = jobs, pending = jobs.count { it.pending }, running = jobs.count { it.running },
        daemon = DaemonState(false, null), quota = null,
    )

    @Test
    fun `prompt uses full text then preview then id`() {
        assertEquals("full", displayPrompt(job(prompt = "full", preview = "short")))
        assertEquals("short", displayPrompt(job(preview = "short")))
        assertEquals("j1", displayPrompt(job()))
    }

    @Test
    fun `wrapped and explicit lines can expand after three rows`() {
        assertFalse(canExpandPrompt("one short line"))
        assertTrue(canExpandPrompt("one\ntwo\nthree\nfour"))
        assertTrue(canExpandPrompt("x".repeat(145)))
        assertTrue(canExpandPrompt("x".repeat(49) + "\n" + "y".repeat(49)))
    }

    @Test
    fun `thinking preview is compact without losing its meaning`() {
        assertEquals("first line second line", thinkingPreview("  first line\n  second line  "))
        val preview = thinkingPreview("word ".repeat(30), maxLength = 24)
        assertEquals(24, preview.length)
        assertTrue(preview.endsWith("…"))
    }

    @Test
    fun `live events append once and replace the current todo list`() {
        val empty = Chat("s", "t", "opencode", "openai", "gpt", null, emptyList())
        val text = LiveEvent("a:1", "j", "text", text = "working")
        val once = mergeLiveEvent(empty, text)
        assertEquals(1, once.turns.size)
        assertEquals(once, mergeLiveEvent(once, text))

        val firstTodos = mergeLiveEvent(once, LiveEvent(
            "a:2", "j", "todos", todos = listOf(TodoItem("one", null, "pending")),
        ))
        val replaced = mergeLiveEvent(firstTodos, LiveEvent(
            "a:3", "j", "todos", todos = listOf(TodoItem("two", null, "in_progress")),
        ))
        val todoBlocks = replaced.turns.last().blocks.filterIsInstance<Block.Todos>()
        assertEquals(1, todoBlocks.size)
        assertEquals("two", todoBlocks.single().items.single().content)
    }

    @Test
    fun `terminal statuses stop streaming while pending and running remain live`() {
        val chat = Chat("s", null, "opencode", null, null, null, emptyList())
        assertTrue(shouldStreamChat("pending", chat))
        assertTrue(shouldStreamChat("running", chat))
        assertFalse(shouldStreamChat("done", chat))
        assertFalse(shouldStreamChat("error", chat))
        assertFalse(shouldStreamChat("missed", chat))
    }

    @Test
    fun `status events advance cursor and make chat terminal`() {
        val chat = Chat("s", null, "opencode", null, null, null, emptyList())
        val ended = mergeLiveEvent(chat, LiveEvent("a:4", "j", "status", status = "error"))
        assertEquals("a:4", ended.cursor)
        assertEquals("error", ended.status)
        assertTrue(ended.terminal)
    }

    @Test
    fun `late callbacks are accepted only for the active job generation`() {
        assertTrue(acceptsLiveEvent("b", 2, "b", 2, "b"))
        assertFalse(acceptsLiveEvent("a", 1, "b", 2, "a"))
        assertFalse(acceptsLiveEvent("b", 1, "b", 2, "b"))
        assertFalse(acceptsLiveEvent("b", 2, "b", 2, "a"))
    }

    @Test
    fun `engine label is concise and does not repeat model`() {
        assertEquals("OpenCode/openai", engineLabel(job().copy(adapter = "opencode", provider = "openai", model = "gpt")))
        assertEquals("Claude", engineLabel(job().copy(adapter = "claude")))
    }

    @Test
    fun `conversation parser uses enriched summaries without prompt-derived concepts`() {
        val queued = job(prompt = "private prompt").copy(adapter = "opencode", provider = "openai", model = "gpt")
        val parsed = ConversationSummary.parse(
            """[{"ref":"j1","concept":null,"status":"pending","adapter":"opencode","provider":"openai","model":"gpt","currentJobId":"j1","runningJobId":null,"updatedAt":9,"chatAvailable":true,"jobs":["j1"],"target":null,"sessionId":null}]""",
            state(listOf(queued)),
        ).single()

        assertEquals(null, parsed.concept)
        assertEquals("j1", parsed.ref)
        assertEquals("j1", parsed.currentJobId)
        assertTrue(parsed.chatAvailable)
    }

    @Test
    fun `legacy targets and missing endpoint state derive useful summaries`() {
        val running = job("run").copy(status = "running", target = "release", sessionId = "ses", adapter = "claude")
        val legacy = ConversationSummary.parse(
            """[{"target":"release","sessionId":"ses","adapter":"claude","updatedAt":7,"jobs":["run"]}]""",
            state(listOf(running)),
        ).single()
        val derived = ConversationSummary.derive(state(listOf(running))).single()

        assertEquals("release", legacy.concept)
        assertEquals("running", legacy.status)
        assertEquals("ses", legacy.ref)
        assertEquals(legacy.copy(updatedAt = derived.updatedAt), derived)
    }

    @Test
    fun `conversation status precedence includes quota`() {
        val now = 1_000L
        val jobs = listOf(
            job("missed").copy(status = "missed"),
            job("done").copy(status = "done"),
            job("error").copy(status = "error"),
            job("quota").copy(status = "pending", pausedUntil = now + 1),
            job("running").copy(status = "running"),
        )
        assertEquals("running", currentConversationJob(jobs, now)?.id)
        assertEquals("quota", currentConversationJob(jobs.dropLast(1), now)?.id)
        assertEquals("quota", conversationStatus(jobs[3], now))
        assertEquals("error", currentConversationJob(jobs.take(3), now)?.id)
        assertEquals("done", currentConversationJob(jobs.take(2), now)?.id)
    }

    @Test
    fun `remote unpair success clears local pairing`() {
        assertEquals(
            UnpairDecision.CLEAR_LOCAL_PAIRING,
            unpairDecision(UnpairAttemptKind.REMOTE_SUCCESS),
        )
    }

    @Test
    fun `down and timeout offer local recovery`() {
        assertEquals(UnpairDecision.OFFER_LOCAL_FORGET, unpairDecision(UnpairAttemptKind.API_DOWN))
        assertEquals(UnpairDecision.OFFER_LOCAL_FORGET, unpairDecision(UnpairAttemptKind.TIMEOUT))
    }

    @Test
    fun `unauthorized offers local recovery`() {
        assertEquals(
            UnpairDecision.OFFER_LOCAL_FORGET,
            unpairDecision(UnpairAttemptKind.UNAUTHORIZED),
        )
    }
}
