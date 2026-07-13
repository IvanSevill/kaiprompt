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
        /**
         * The pairing QR. Two shapes are accepted, and that is deliberate:
         *
         *   long   {"url","token","key","host","tunnel"}   what the first releases emitted
         *   short  {"u","t","k","l"}                       what they emit now
         *
         * The short one exists because every byte of this payload is a QR module, and the
         * long one came to 232 bytes — a version-11 code, 61x61 modules the camera has to
         * resolve out of a few centimetres of terminal. Right at the edge of scannable, and
         * a long tunnel URL pushed it over.
         *
         * Reading both means an app in someone's pocket keeps working against an older PC,
         * and an older app keeps working against this one.
         */
        fun parse(text: String): Pairing {
            val j = JSONObject(text)
            require(j.optInt("v") == 1) { "este QR no es de Kaiprompt" }

            val url = (j.optStringOrNull("u") ?: j.optStringOrNull("url"))
                ?: throw IllegalArgumentException("al QR le falta la dirección")
            val token = (j.optStringOrNull("t") ?: j.optStringOrNull("token"))
                ?: throw IllegalArgumentException("al QR le falta el token")
            val key = (j.optStringOrNull("k") ?: j.optStringOrNull("key"))
                ?: throw IllegalArgumentException("al QR le falta la clave")

            return Pairing(
                url = url.trimEnd('/'),
                lan = (j.optStringOrNull("l") ?: j.optStringOrNull("lan"))?.trimEnd('/'),
                token = token,
                key = key,
                host = j.optString("host", "?"),
                // Not sent any more: a tunnel is exactly an https address. Derive it.
                tunnel = j.optBoolean("tunnel", url.startsWith("https://")),
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

/**
 * Is anything actually going to fire?
 *
 * `running` is NOT "the daemon process exists" — it is "someone is processing the queue".
 * That someone can be the daemon, or a `kaip run` sitting in a terminal. The app used to
 * conflate the two and show a red "nothing will fire" while a run was about to fire it.
 *
 * `durable` is the distinction worth surfacing: a run dies with its window; the daemon does
 * not. Both keep the promise today; only one keeps it tonight.
 */
data class DaemonState(
    val running: Boolean,
    val next: Long?,
    val kind: String? = null,       // "daemon" | "run" | null
    val durable: Boolean = true,
    val pid: Long? = null,
)
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
    val hasScheduled: Boolean get() = jobs.any { it.pending && it.whenAt != null }

    /** Work scheduled and NOBODY to fire it. The one silent way this tool can betray you. */
    val scheduledButDead: Boolean get() = !daemon.running && hasScheduled

    /**
     * It WILL fire — but by a `kaip run` in a terminal, not the daemon. So it fires today and
     * stops firing the moment that window closes. Worth saying; not worth an alarm.
     */
    val firesButFragile: Boolean
        get() = daemon.running && !daemon.durable && hasScheduled

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
                    kind = d?.optStringOrNull("kind"),
                    durable = d?.optBoolean("durable", true) ?: true,
                    pid = d?.optLongOrNull("pid"),
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
