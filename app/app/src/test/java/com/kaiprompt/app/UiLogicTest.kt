package com.kaiprompt.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import kotlinx.coroutines.CancellationException

class UiLogicTest {
    @Test
    fun `failover is limited to connection failures and never cancellation or semantic errors`() {
        assertTrue(isFailoverFailure(ConnectException("refused")))
        assertTrue(isFailoverFailure(SocketTimeoutException("timed out")))
        assertFalse(isFailoverFailure(IllegalArgumentException("bad sealed payload")))
        assertFalse(isFailoverFailure(CancellationException("cancelled")))
    }

    @Test
    fun `pairing URLs accept only bounded HTTP origins`() {
        assertEquals("https://example.com:8443", normalizeHttpBase(" https://example.com:8443/ "))
        listOf("ftp://example.com", "https://user@example.com", "https://example.com/path", "not a url").forEach {
            assertTrue(runCatching { normalizeHttpBase(it) }.isFailure)
        }
    }

    @Test
    fun `notification retention is newest first deduplicated and bounded`() {
        assertEquals(listOf("new", "same", "old"), newestNotificationIds(
            existing = listOf("same", "old"), fresh = listOf("new", "same"), limit = 3,
        ))
    }

    @Test
    fun `delete response decides from this device rather than global pairing mode`() {
        val state = PairingState.parse(
            """{"registered":false,"mode":"connected","protocol":2,"devices":1}""",
        )
        assertFalse(state.registered)
        assertEquals("connected", state.mode)
    }

    private fun quota(status: String = "available", stale: Boolean? = false) = ProviderQuota(
        provider = "claude", status = status, source = QuotaSource(null, null),
        freshness = QuotaFreshness(null, stale), limits = emptyList(), plan = null,
        credits = null, error = null,
    )

    @Test
    fun `quota distingue disponible stale no disponible y error`() {
        assertEquals(QuotaDisplayKind.AVAILABLE, quotaDisplayKind(quota()))
        assertEquals(QuotaDisplayKind.STALE, quotaDisplayKind(quota(stale = true)))
        assertEquals(QuotaDisplayKind.UNAVAILABLE, quotaDisplayKind(quota(status = "unavailable", stale = null)))
        assertEquals(QuotaDisplayKind.ERROR, quotaDisplayKind(quota(status = "error", stale = null)))
    }

    @Test
    fun `porcentaje desconocido no se convierte en cero ni cien`() {
        assertEquals(null, quotaNumber(null))
        assertEquals(null, quotaNumber(Double.NaN))
        assertEquals("0", quotaNumber(0.0))
        assertEquals("37.5", quotaNumber(37.5))
    }

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
    fun `live diff merges into active assistant and dedupes event and diff replay`() {
        val empty = Chat("s", null, "claude", null, null, null, emptyList())
        val diff = Diff("d1", "a.kt", 1, 1, listOf("-old", "+new"))
        val withText = mergeLiveEvent(empty, LiveEvent("e1", "j", "text", text = "working"))
        val once = mergeLiveEvent(withText, LiveEvent("e2", "j", "diff", diff = diff))
        assertEquals(1, once.turns.size)
        assertEquals(listOf("-old", "+new"), once.turns.single().diffs.single().lines)
        assertEquals(once, mergeLiveEvent(once, LiveEvent("e2", "j", "diff", diff = diff)))

        val replayedWithNewEvent = mergeLiveEvent(once, LiveEvent("e3", "j", "diff", diff = diff))
        assertEquals(1, replayedWithNewEvent.turns.single().diffs.size)
        assertTrue("e3" in replayedWithNewEvent.eventIds)
    }

    @Test
    fun `diff-only live event creates a visible turn and display data preserves signs`() {
        val empty = Chat("s", null, "claude", null, null, null, emptyList())
        val lines = listOf("-removed", "+added") + (1..130).map { " context $it" }
        val diff = Diff("d", "file.kt", 1, 1, lines, truncated = true, truncationReason = "line-limit")
        val merged = mergeLiveEvent(empty, LiveEvent("e", "j", "diff", diff = diff))
        assertTrue(merged.turns.single().blocks.isEmpty())
        assertEquals(listOf("-removed", "+added"), diffDisplayLines(diff, expanded = false).take(2))
        assertEquals(120, diffDisplayLines(diff, expanded = true).size)
    }

    @Test
    fun `terminal snapshot merge dedupes canonical diffs and preserves unrepresented live ones`() {
        val first = Diff("same", "a.kt", 1, 1, listOf("-a", "+b"), eventId = "e1")
        val extra = Diff("extra", "b.kt", 1, 0, listOf("+new"), eventId = "e2")
        val current = Chat("s", null, "claude", null, null, null, listOf(
            Turn("assistant", null, emptyList(), listOf(first, extra), live = true),
        ), eventIds = setOf("e1", "e2"))
        val fresh = Chat("s", null, "claude", null, null, null, listOf(
            Turn("assistant", null, emptyList(), listOf(first), live = false),
        ), eventIds = setOf("e1"), terminal = true)
        val merged = mergeChatSnapshot(current, fresh)
        assertEquals(setOf("same", "extra"), merged.turns.flatMap(Turn::diffs).map(Diff::id).toSet())
        assertEquals(2, merged.turns.flatMap(Turn::diffs).size)
        assertEquals(setOf("e1", "e2"), merged.eventIds)
        assertTrue(merged.terminal)
    }

    @Test
    fun `two old rows sharing ref still have distinct stable identities`() {
        val jobs = listOf(
            job("a").copy(target = "one", sessionId = "same", adapter = "claude"),
            job("b").copy(target = "two", sessionId = "same", adapter = "claude"),
        )
        val parsed = ConversationSummary.parse(
            """[{"ref":"same","target":"one","adapter":"claude","sessionId":"same","jobs":["a"]},{"ref":"same","target":"two","adapter":"claude","sessionId":"same","jobs":["b"]}]""",
            state(jobs),
        )
        assertEquals(2, parsed.map { it.conversationId }.toSet().size)
        assertEquals(parsed.map { it.conversationId }, ConversationSummary.parse(
            """[{"ref":"same","target":"one","adapter":"claude","sessionId":"same","jobs":["a"]},{"ref":"same","target":"two","adapter":"claude","sessionId":"same","jobs":["b"]}]""",
            state(jobs),
        ).map { it.conversationId })
    }

    @Test
    fun `server conversation id wins and old server fallback includes engine`() {
        val claude = job("a").copy(target = "same", adapter = "claude")
        val codex = job("b").copy(target = "same", adapter = "codex")
        val modern = ConversationSummary.parse(
            """[{"conversationId":"conv-1","ref":"same","target":"same","adapter":"claude","jobs":["a"]}]""",
            state(listOf(claude)),
        ).single()
        val old = ConversationSummary.derive(state(listOf(claude, codex)))
        assertEquals("conv-1", modern.conversationId)
        assertEquals(2, old.map { it.conversationId }.toSet().size)
    }

    @Test
    fun `stale refresh cannot overwrite a newer hide generation`() {
        assertTrue(acceptsRefresh(3, 3))
        assertFalse(acceptsRefresh(2, 3))
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
