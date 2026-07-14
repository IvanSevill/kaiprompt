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

/**
 * What the QR carries. Note what it does NOT carry: a name.
 *
 * It used to have `host`, the PC's hostname, and when the compact QR dropped the field to
 * save bytes this class kept a `host` property defaulting to `"?"` — so the `?` was not a
 * missing value being handled, it was a missing value being RENDERED. It got painted in the
 * top bar and shipped inside the "no llego a ?" error message.
 *
 * There is no `host` any more, and there is nowhere left for a `?` to come from. The two
 * names that matter each come from the machine that actually knows them:
 *
 *   the PC's name      the PC sends it in /api/state (`State.host`)
 *   the phone's name   the PHONE sends it to the PC in POST /api/device
 *
 * which is the natural way round, because the name you want to see on the PC's screen when
 * it says "✓ paired" is the phone's, and the PC has never had any way to know that.
 */
data class Pairing(
    val url: String,
    val lan: String?,
    val token: String,
    val key: String,
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
         * and an older app keeps working against this one. A long QR may still carry `host`;
         * we simply ignore it rather than find somewhere to show it.
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
    val pausedUntil: Long?,
    val error: String?,
) {
    val running get() = status == "running"
    val pending get() = status == "pending"
    val failed get() = status == "error" || status == "missed"

    /** Cut short by the quota and put back in the queue. It is NOT broken: it resumes. */
    fun waitingForQuota(now: Long = System.currentTimeMillis()) =
        pending && (pausedUntil ?: 0) > now

    companion object {
        fun parse(j: JSONObject) = Job(
            id = j.getString("id"),
            status = j.optString("status", "pending"),
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
            pausedUntil = j.optLongOrNull("pausedUntil"),
            error = j.optStringOrNull("error"),
        )
    }
}

/**
 * What the PC is doing RIGHT NOW, in one word. Derived on the PC and sent down the wire, so
 * the terminal panel and this screen cannot drift into telling you different stories.
 *
 * The pair that earns this its place at the top of the screen is `quota` and `stalled`. From
 * a phone they look identical — nothing is moving — and they are opposites:
 *
 *   quota    it IS going to run. Sit down. It resumes by itself, at a time we can show you.
 *   stalled  it is NOT going to run. Nobody is draining the queue. Get up.
 *
 * Before this, both showed as "nothing happening", and a person learns to read that as
 * "broken" — which means on the day it really is broken, they shrug at it.
 */
enum class Activity { RUNNING, QUOTA, STALLED, QUEUED, IDLE, UNKNOWN }

data class Now(
    val activity: Activity,
    val jobId: String? = null,
    val preview: String? = null,
    val since: Long? = null,        // running: since when
    val until: Long? = null,        // quota: when it comes back — the whole point
    val next: Long? = null,         // queued: when the next one is due
    val pending: Int = 0,
    val scheduled: Int = 0,
) {
    companion object {
        fun parse(j: JSONObject?): Now {
            if (j == null) return Now(Activity.UNKNOWN)
            val a = when (j.optString("state")) {
                "running" -> Activity.RUNNING
                "quota" -> Activity.QUOTA
                "stalled" -> Activity.STALLED
                "queued" -> Activity.QUEUED
                "idle" -> Activity.IDLE
                else -> Activity.UNKNOWN
            }
            return Now(
                activity = a,
                jobId = j.optStringOrNull("jobId"),
                preview = j.optStringOrNull("preview"),
                since = j.optLongOrNull("since"),
                until = j.optLongOrNull("until"),
                next = j.optLongOrNull("next"),
                pending = j.optInt("pending"),
                scheduled = j.optInt("scheduled"),
            )
        }
    }
}

/** Diagnosis. Everything you only want when something is wrong — so it lives in Settings. */
data class ServerInfo(
    val version: String?,
    val startedAt: Long?,
    val tunnel: String?,
    val clients: List<String>,
) {
    companion object {
        fun parse(j: JSONObject?): ServerInfo {
            val arr = j?.optJSONArray("clients") ?: JSONArray()
            return ServerInfo(
                version = j?.optStringOrNull("version"),
                startedAt = j?.optLongOrNull("startedAt"),
                tunnel = j?.optStringOrNull("tunnel"),
                clients = (0 until arr.length()).mapNotNull {
                    arr.optJSONObject(it)?.optStringOrNull("ip")
                },
            )
        }
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
    val since: Long? = null,        // when whoever holds the queue took it — the uptime
)
data class Quota(
    val freePct: Int?,
    val resetsAt: Long?,
    val renewed: Boolean,
    val freePctWeek: Int?,
    val resetsAtWeek: Long?,
)

data class State(
    val host: String?,
    val jobs: List<Job>,
    val pending: Int,
    val running: Int,
    val daemon: DaemonState,
    val quota: Quota?,
    val now: Now = Now(Activity.UNKNOWN),
    val server: ServerInfo = ServerInfo(null, null, null, emptyList()),
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
                // Null, not "?". The PC always sends this — but if it ever did not, the honest
                // answer is "we do not know yet", and the screen says so in its own words. A
                // "?" is not a value: it is a hole with a face drawn on it.
                host = j.optStringOrNull("host"),
                jobs = jobs,
                pending = counts?.optInt("pending") ?: jobs.count { it.pending },
                running = counts?.optInt("running") ?: jobs.count { it.running },
                daemon = DaemonState(
                    running = d?.optBoolean("running") ?: false,
                    next = d?.optLongOrNull("next"),
                    kind = d?.optStringOrNull("kind"),
                    durable = d?.optBoolean("durable", true) ?: true,
                    pid = d?.optLongOrNull("pid"),
                    since = d?.optLongOrNull("since"),
                ),
                quota = q?.let {
                    val weekly = it.optJSONObject("weekly")
                    Quota(
                        freePct = if (it.isNull("freePct")) null else it.optInt("freePct"),
                        resetsAt = it.optLongOrNull("resetsAt"),
                        renewed = it.optBoolean("renewed", false),
                        freePctWeek = weekly?.let { w -> if (w.isNull("freePct")) null else w.optInt("freePct") },
                        resetsAtWeek = weekly?.optLongOrNull("resetsAt"),
                    )
                },
                now = Now.parse(j.optJSONObject("activity")),
                server = ServerInfo.parse(j.optJSONObject("server")),
            )
        }
    }
}

/** One turn of a conversation, flattened into what a phone screen can actually show. */
data class Diff(val file: String, val added: Int, val removed: Int, val diff: String)

data class Turn(val role: String, val at: String?, val blocks: List<Block>, val diffs: List<Diff>)

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
                val diffs = t.optJSONArray("diffs") ?: JSONArray()
                val parsedDiffs = (0 until diffs.length()).mapNotNull { k ->
                    val d = diffs.optJSONObject(k) ?: return@mapNotNull null
                    d.optStringOrNull("file")?.let { file ->
                        Diff(file, d.optInt("added"), d.optInt("removed"), d.optString("diff", ""))
                    }
                }
                if (blocks.isEmpty()) null else Turn(t.optString("role"), t.optStringOrNull("at"), blocks, parsedDiffs)
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
