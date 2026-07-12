package com.kaiprompt.app

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the PC sends, as the app understands it.
 *
 * Parsed by hand from org.json rather than with a serialisation library: the shapes are
 * small, and every field is one the server explicitly chose to send. A missing field must
 * never crash the phone — the PC may be running an older kaip than the app.
 */

data class Pairing(
    val url: String,
    val lan: String?,
    val token: String,
    val key: String,
    val host: String,
    val tunnel: Boolean,
) {
    companion object {
        /** The pairing QR. Anything malformed is rejected loudly — a half-pairing is useless. */
        fun parse(text: String): Pairing {
            val j = JSONObject(text)
            require(j.optInt("v") == 1) { "este QR no es de Kaiprompt" }
            return Pairing(
                url = j.getString("url").trimEnd('/'),
                lan = j.optString("lan").ifBlank { null }?.trimEnd('/'),
                token = j.getString("token"),
                key = j.getString("key"),
                host = j.optString("host", "?"),
                tunnel = j.optBoolean("tunnel", false),
            )
        }
    }
}

data class Job(
    val id: String,
    val status: String,
    val prompt: String?,
    val promptFile: String?,
    val promptError: String?,
    val preview: String,
    val target: String?,
    val sessionId: String?,
    val dir: String?,
    val whenAt: Long?,
    val startedAt: Long?,
    val finishedAt: Long?,
    val error: String?,
) {
    val running get() = status == "running"
    val pending get() = status == "pending"
    val failed get() = status == "error" || status == "missed"

    companion object {
        fun parse(j: JSONObject) = Job(
            id = j.getString("id"),
            status = j.optString("status", "?"),
            prompt = j.optStringOrNull("prompt"),
            promptFile = j.optStringOrNull("promptFile"),
            promptError = j.optStringOrNull("promptError"),
            preview = j.optString("preview", ""),
            target = j.optStringOrNull("target"),
            sessionId = j.optStringOrNull("sessionId"),
            dir = j.optStringOrNull("dir"),
            whenAt = j.optLongOrNull("when"),
            startedAt = j.optLongOrNull("startedAt"),
            finishedAt = j.optLongOrNull("finishedAt"),
            error = j.optStringOrNull("error"),
        )
    }
}

data class DaemonState(val running: Boolean, val next: Long?)
data class Quota(val freePct: Int?, val resetsAt: Long?, val renewed: Boolean)

data class State(
    val host: String,
    val jobs: List<Job>,
    val pending: Int,
    val running: Int,
    val daemon: DaemonState,
    val quota: Quota?,
) {
    /**
     * The question the phone most needs answered, and the one the PC's own GUI kept getting
     * asked: is anything actually going to fire? Scheduled work with the daemon off never
     * runs, and finding that out in the morning is too late.
     */
    val scheduledButDead: Boolean
        get() = !daemon.running && jobs.any { it.pending && it.whenAt != null }

    companion object {
        fun parse(body: String): State {
            val j = JSONObject(body)
            val arr = j.optJSONArray("jobs") ?: JSONArray()
            val jobs = (0 until arr.length()).map { Job.parse(arr.getJSONObject(it)) }
            val counts = j.optJSONObject("counts")
            val d = j.optJSONObject("daemon")
            val q = j.optJSONObject("quota")

            return State(
                host = j.optString("host", "?"),
                jobs = jobs,
                pending = counts?.optInt("pending") ?: jobs.count { it.pending },
                running = counts?.optInt("running") ?: jobs.count { it.running },
                daemon = DaemonState(
                    running = d?.optBoolean("running") ?: false,
                    next = d?.optLongOrNull("next"),
                ),
                quota = q?.let {
                    Quota(
                        freePct = if (it.isNull("freePct")) null else it.optInt("freePct"),
                        resetsAt = it.optLongOrNull("resetsAt"),
                        renewed = it.optBoolean("renewed", false),
                    )
                },
            )
        }
    }
}

/** One turn of a conversation, flattened into what a phone screen can actually show. */
data class Turn(val role: String, val at: String?, val blocks: List<Block>)

sealed class Block {
    data class Text(val text: String) : Block()
    data class Tool(val name: String, val arg: String) : Block()
    data class Thinking(val text: String) : Block()
}

data class Chat(
    val sessionId: String,
    val target: String?,
    val dir: String?,
    val turns: List<Turn>,
) {
    companion object {
        // The tools worth naming, and the one argument of each worth showing. Same choice
        // the PC makes in its own live view, so a launch reads the same in both places.
        private val ARG_KEYS = listOf("file_path", "command", "pattern", "path", "url", "query")

        fun parse(body: String): Chat {
            val j = JSONObject(body)
            val arr = j.optJSONArray("turns") ?: JSONArray()

            val turns = (0 until arr.length()).mapNotNull { i ->
                val t = arr.getJSONObject(i)
                if (t.optBoolean("toolResult") || t.optBoolean("sidechain")) return@mapNotNull null

                val bs = t.optJSONArray("blocks") ?: JSONArray()
                val blocks = (0 until bs.length()).mapNotNull { k ->
                    val b = bs.getJSONObject(k)
                    when (b.optString("type")) {
                        "text" -> b.optStringOrNull("text")?.takeIf { it.isNotBlank() }?.let { Block.Text(it) }
                        "thinking" -> b.optStringOrNull("text")?.let { Block.Thinking(it) }
                        "tool" -> {
                            val input = b.optJSONObject("input")
                            val arg = ARG_KEYS.firstNotNullOfOrNull { key -> input?.optStringOrNull(key) } ?: ""
                            Block.Tool(b.optString("name", "tool"), arg)
                        }
                        else -> null
                    }
                }
                if (blocks.isEmpty()) null else Turn(t.optString("role"), t.optStringOrNull("at"), blocks)
            }

            return Chat(
                sessionId = j.optString("sessionId"),
                target = j.optStringOrNull("target"),
                dir = j.optStringOrNull("dir"),
                turns = turns,
            )
        }
    }
}

// org.json turns a JSON null into the STRING "null", which is how you end up rendering the
// word "null" on screen. These two make absent mean absent.
fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).ifBlank { null }

fun JSONObject.optLongOrNull(key: String): Long? =
    if (isNull(key) || !has(key)) null else optLong(key).takeIf { it != 0L }
