package com.kaiprompt.app

import java.util.Locale
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlinx.coroutines.CancellationException

internal fun displayPrompt(job: Job): String = job.prompt ?: job.preview.ifBlank { job.id }

internal fun estimatedPromptLines(prompt: String, charactersPerLine: Int = 48): Int =
    prompt.lines().sumOf { line -> maxOf(1, (line.length + charactersPerLine - 1) / charactersPerLine) }

internal fun canExpandPrompt(prompt: String, collapsedLines: Int = 3): Boolean =
    estimatedPromptLines(prompt) > collapsedLines

internal fun jobUpdatedAt(job: Job): Long = job.finishedAt ?: job.startedAt ?: job.createdAt ?: job.whenAt ?: 0L

internal fun conversationStatus(job: Job?, now: Long = System.currentTimeMillis()): String = when {
    job == null -> "done"
    job.pending && (job.pausedUntil ?: 0L) > now -> "quota"
    else -> job.status
}

internal fun currentConversationJob(jobs: List<Job>, now: Long = System.currentTimeMillis()): Job? {
    val rank = mapOf("running" to 5, "pending" to 4, "quota" to 4, "error" to 3, "done" to 2, "missed" to 1)
    return jobs.maxWithOrNull(compareBy<Job> { rank[conversationStatus(it, now)] ?: 0 }.thenBy(::jobUpdatedAt))
}

internal fun legacyConversationIdentity(
    ref: String,
    target: String?,
    adapter: String?,
    sessionId: String?,
    jobIds: List<String>,
): String = listOf("legacy", adapter.orEmpty(), target.orEmpty(), sessionId.orEmpty(), ref, jobIds.sorted().joinToString(","))
    .joinToString(":")

internal fun acceptsRefresh(expectedGeneration: Long, currentGeneration: Long): Boolean =
    expectedGeneration == currentGeneration

internal fun isFailoverFailure(cause: Throwable): Boolean = when (cause) {
    is CancellationException -> false
    is SocketTimeoutException, is ConnectException, is NoRouteToHostException,
    is UnknownHostException, is SocketException -> true
    else -> false
}

internal fun newestNotificationIds(existing: List<String>, fresh: List<String>, limit: Int = 200): List<String> =
    (fresh + existing).filter(String::isNotBlank).distinct().take(limit)

internal enum class QuotaDisplayKind { AVAILABLE, STALE, UNAVAILABLE, ERROR }

internal fun quotaDisplayKind(quota: ProviderQuota): QuotaDisplayKind = when {
    quota.freshness.stale == true -> QuotaDisplayKind.STALE
    quota.status == "available" -> QuotaDisplayKind.AVAILABLE
    quota.status == "unavailable" -> QuotaDisplayKind.UNAVAILABLE
    else -> QuotaDisplayKind.ERROR
}

internal fun quotaNumber(value: Double?): String? = value?.takeIf { it.isFinite() }?.let {
    if (it % 1.0 == 0.0) it.toLong().toString() else String.format(Locale.US, "%.1f", it)
}

internal enum class UnpairAttemptKind { REMOTE_SUCCESS, API_DOWN, TIMEOUT, UNAUTHORIZED }

internal enum class UnpairDecision { CLEAR_LOCAL_PAIRING, OFFER_LOCAL_FORGET }

internal fun unpairDecision(attempt: UnpairAttemptKind): UnpairDecision = when (attempt) {
    UnpairAttemptKind.REMOTE_SUCCESS -> UnpairDecision.CLEAR_LOCAL_PAIRING
    UnpairAttemptKind.API_DOWN,
    UnpairAttemptKind.TIMEOUT,
    UnpairAttemptKind.UNAUTHORIZED -> UnpairDecision.OFFER_LOCAL_FORGET
}

internal fun thinkingPreview(text: String, maxLength: Int = 96): String {
    val singleLine = text.trim().lineSequence().joinToString(" ") { it.trim() }
        .replace(Regex("\\s+"), " ")
    return if (singleLine.length <= maxLength) singleLine else singleLine.take(maxLength - 1).trimEnd() + "…"
}

private val TERMINAL_STATUSES = setOf("done", "error", "missed")

internal fun isTerminalStatus(status: String?): Boolean = status?.lowercase() in TERMINAL_STATUSES

internal fun shouldStreamChat(jobStatus: String, chat: Chat): Boolean =
    !chat.terminal && !isTerminalStatus(chat.status ?: jobStatus)

internal fun acceptsLiveEvent(
    expectedJobId: String,
    expectedGeneration: Long,
    activeJobId: String?,
    activeGeneration: Long,
    eventJobId: String?,
): Boolean = expectedJobId == activeJobId && expectedGeneration == activeGeneration &&
    (eventJobId == null || eventJobId == expectedJobId)

internal fun mergeLiveEvent(chat: Chat, event: LiveEvent): Chat {
    val id = event.id
    if (id != null && id in chat.eventIds) return chat
    if (event.kind == "reset") return chat
    if (event.kind == "diff" && event.diff != null) {
        val knownDiffs = chat.turns.flatMap(Turn::diffs).map(Diff::id).toSet()
        if (event.diff.id in knownDiffs) return chat.copy(
            cursor = id ?: chat.cursor,
            eventIds = chat.eventIds + listOfNotNull(id),
        )
        val turns = chat.turns.toMutableList()
        val last = turns.lastOrNull()
        val diff = event.diff.copy(eventId = event.diff.eventId ?: id)
        if (last?.role == "assistant" && last.live) {
            turns[turns.lastIndex] = last.copy(diffs = last.diffs + diff)
        } else {
            turns += Turn("assistant", null, emptyList(), listOf(diff), live = true)
        }
        return chat.copy(
            turns = turns, cursor = id ?: chat.cursor, eventIds = chat.eventIds + listOfNotNull(id),
            status = event.status ?: chat.status, terminal = chat.terminal || isTerminalStatus(event.status),
        )
    }
    val block = when (event.kind) {
        "text" -> event.text?.let { Block.Text(it, id) }
        "thinking" -> event.text?.let { Block.Thinking(it, id) }
        "tool" -> Block.Tool(event.name ?: "tool", event.arg, id)
        "todos" -> Block.Todos(event.todos, id)
        else -> null
    } ?: return chat.copy(
        cursor = id ?: chat.cursor,
        eventIds = chat.eventIds + listOfNotNull(id),
        status = event.status ?: chat.status,
        terminal = chat.terminal || isTerminalStatus(event.status),
    )

    val turns = chat.turns.toMutableList()
    val last = turns.lastOrNull()
    if (last?.role == "assistant" && last.live) {
        val blocks = if (block is Block.Todos) {
            last.blocks.filterNot { it is Block.Todos } + block
        } else last.blocks + block
        turns[turns.lastIndex] = last.copy(blocks = blocks)
    } else {
        turns += Turn("assistant", null, listOf(block), emptyList(), live = true)
    }
    return chat.copy(
        turns = turns, cursor = id ?: chat.cursor, eventIds = chat.eventIds + listOfNotNull(id),
        status = event.status ?: chat.status, terminal = chat.terminal || isTerminalStatus(event.status),
    )
}

internal fun diffDisplayLines(diff: Diff, expanded: Boolean): List<String> =
    diff.lines.take(if (expanded) 120 else 6)

internal fun mergeChatSnapshot(current: Chat?, fresh: Chat): Chat {
    if (current == null) return fresh
    val freshDiffIds = fresh.turns.flatMap(Turn::diffs).map(Diff::id).toSet()
    val missingDiffs = current.turns.flatMap(Turn::diffs).filter { it.id !in freshDiffIds }
    val missingBlocks = current.turns.flatMap(Turn::blocks).filter { block ->
        val eventId = when (block) {
            is Block.Text -> block.eventId
            is Block.Tool -> block.eventId
            is Block.Thinking -> block.eventId
            is Block.Todos -> block.eventId
        }
        eventId != null && eventId !in fresh.eventIds
    }
    if (missingBlocks.isEmpty() && missingDiffs.isEmpty()) {
        return fresh.copy(eventIds = fresh.eventIds + current.eventIds, cursor = fresh.cursor ?: current.cursor)
    }
    val turns = fresh.turns.toMutableList()
    val last = turns.lastOrNull()
    if (last?.role == "assistant" && last.live) {
        turns[turns.lastIndex] = last.copy(blocks = last.blocks + missingBlocks, diffs = last.diffs + missingDiffs)
    } else {
        turns += Turn("assistant", null, missingBlocks, missingDiffs, live = true)
    }
    return fresh.copy(
        turns = turns,
        eventIds = fresh.eventIds + current.eventIds,
        cursor = fresh.cursor ?: current.cursor,
    )
}

internal fun engineLabel(job: Job): String = when (job.adapter) {
    "opencode" -> listOfNotNull("OpenCode", job.provider).joinToString("/")
    null -> ""
    else -> job.adapter.replaceFirstChar(Char::uppercase)
}

internal fun engineLabel(summary: ConversationSummary): String = when (summary.adapter) {
    "opencode" -> listOfNotNull("OpenCode", summary.provider, summary.model).joinToString("/")
    null -> ""
    else -> listOfNotNull(summary.adapter.replaceFirstChar(Char::uppercase), summary.model).joinToString("/")
}
