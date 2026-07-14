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
    fun `engine label is concise and does not repeat model`() {
        assertEquals("OpenCode/openai", engineLabel(job().copy(adapter = "opencode", provider = "openai", model = "gpt")))
        assertEquals("Claude", engineLabel(job().copy(adapter = "claude")))
    }
}
