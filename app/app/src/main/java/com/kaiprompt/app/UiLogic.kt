package com.kaiprompt.app

internal fun displayPrompt(job: Job): String = job.prompt ?: job.preview.ifBlank { job.id }

internal fun estimatedPromptLines(prompt: String, charactersPerLine: Int = 48): Int =
    prompt.lines().sumOf { line -> maxOf(1, (line.length + charactersPerLine - 1) / charactersPerLine) }

internal fun canExpandPrompt(prompt: String, collapsedLines: Int = 3): Boolean =
    estimatedPromptLines(prompt) > collapsedLines

internal fun thinkingPreview(text: String, maxLength: Int = 96): String {
    val singleLine = text.trim().lineSequence().joinToString(" ") { it.trim() }
        .replace(Regex("\\s+"), " ")
    return if (singleLine.length <= maxLength) singleLine else singleLine.take(maxLength - 1).trimEnd() + "…"
}

internal fun mergeLiveEvent(chat: Chat, event: LiveEvent): Chat {
    val id = event.id
    if (id != null && id in chat.eventIds) return chat
    if (event.kind == "reset") return chat
    val block = when (event.kind) {
        "text" -> event.text?.let { Block.Text(it, id) }
        "tool" -> Block.Tool(event.name ?: "tool", event.arg, id)
        "todos" -> Block.Todos(event.todos, id)
        else -> null
    } ?: return chat.copy(cursor = id ?: chat.cursor, eventIds = chat.eventIds + listOfNotNull(id))

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
    return chat.copy(turns = turns, cursor = id ?: chat.cursor, eventIds = chat.eventIds + listOfNotNull(id))
}

internal fun engineLabel(job: Job): String = when (job.adapter) {
    "opencode" -> listOfNotNull("OpenCode", job.provider).joinToString("/")
    null -> ""
    else -> job.adapter.replaceFirstChar(Char::uppercase)
}
