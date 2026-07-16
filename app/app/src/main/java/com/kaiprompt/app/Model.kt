package com.kaiprompt.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

internal val TOOL_ARG_KEYS = listOf("file_path", "command", "pattern", "path", "url", "query")

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
                url = normalizeHttpBase(url),
                lan = (j.optStringOrNull("l") ?: j.optStringOrNull("lan"))?.let(::normalizeHttpBase),
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
    val conversationId: String? = null,
    val adapter: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val dir: String?,
    val whenAt: Long?,
    val startedAt: Long?,
    val finishedAt: Long?,
    val pausedUntil: Long?,
    val error: String?,
    val createdAt: Long? = null,
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
            conversationId = j.optStringOrNull("conversationId"),
            adapter = j.optStringOrNull("adapter"),
            provider = j.optStringOrNull("provider"),
            model = j.optStringOrNull("model"),
            dir = j.optStringOrNull("dir"),
            whenAt = j.optLongOrNull("when"),
            startedAt = j.optLongOrNull("startedAt"),
            finishedAt = j.optLongOrNull("finishedAt"),
            pausedUntil = j.optLongOrNull("pausedUntil"),
            error = j.optStringOrNull("error"),
            createdAt = j.optLongOrNull("createdAt"),
        )
    }
}

data class ConversationSummary(
    val ref: String,
    val concept: String?,
    val status: String,
    val adapter: String?,
    val provider: String?,
    val model: String?,
    val currentJobId: String?,
    val runningJobId: String?,
    val updatedAt: Long?,
    val chatAvailable: Boolean,
    val jobIds: List<String>,
    val target: String?,
    val sessionId: String?,
    val conversationId: String,
    val hidden: Boolean = false,
) {
    companion object {
        fun parse(body: String, state: State): List<ConversationSummary> {
            val rows = JSONArray(body)
            val byId = state.jobs.associateBy(Job::id)
            val covered = mutableSetOf<String>()
            val summaries = (0 until rows.length()).mapNotNull { index ->
                val row = rows.optJSONObject(index) ?: return@mapNotNull null
                val ids = row.optJSONArray("jobs").strings()
                covered += ids
                val jobs = ids.mapNotNull(byId::get)
                from(row, jobs)
            }.toMutableList()

            val remaining = state.jobs.filterNot { it.id in covered }
            val groups = remaining.groupBy { job ->
                when {
                    job.target != null -> "target:${job.target}:${job.adapter}"
                    job.sessionId != null -> "session:${job.sessionId}"
                    else -> "job:${job.id}"
                }
            }
            summaries += groups.values.map(::fromJobs)
            return summaries.sortedByDescending { it.updatedAt ?: 0L }
        }

        fun derive(state: State): List<ConversationSummary> =
            state.jobs.groupBy { job ->
                when {
                    job.target != null -> "target:${job.target}:${job.adapter}"
                    job.sessionId != null -> "session:${job.sessionId}"
                    else -> "job:${job.id}"
                }
            }.values.map(::fromJobs).sortedByDescending { it.updatedAt ?: 0L }

        private fun from(row: JSONObject, jobs: List<Job>): ConversationSummary? {
            val current = currentConversationJob(jobs)
            val target = row.optStringOrNull("target")
            val sessionId = row.optStringOrNull("sessionId")
            val ref = row.optStringOrNull("ref") ?: sessionId ?: target ?: current?.id ?: return null
            val adapter = row.optStringOrNull("adapter") ?: current?.adapter
            val serverConversationId = row.optStringOrNull("conversationId")
            return ConversationSummary(
                ref = ref,
                concept = row.optStringOrNull("concept") ?: target,
                status = row.optStringOrNull("status") ?: conversationStatus(current),
                adapter = adapter,
                provider = row.optStringOrNull("provider") ?: current?.provider,
                model = row.optStringOrNull("model") ?: current?.model,
                currentJobId = row.optStringOrNull("currentJobId") ?: current?.id,
                runningJobId = row.optStringOrNull("runningJobId") ?: jobs.lastOrNull { it.running }?.id,
                updatedAt = row.optLongOrNull("updatedAt") ?: jobs.maxOfOrNull(::jobUpdatedAt),
                chatAvailable = if (row.has("chatAvailable")) row.optBoolean("chatAvailable")
                    else sessionId != null || adapter in setOf("opencode", "codex"),
                jobIds = row.optJSONArray("jobs").strings(),
                target = target,
                sessionId = sessionId,
                conversationId = serverConversationId ?: legacyConversationIdentity(
                    ref, target, adapter, sessionId, jobs.map(Job::id),
                ),
                hidden = row.optBoolean("hidden", false),
            )
        }

        private fun fromJobs(jobs: List<Job>): ConversationSummary {
            val current = currentConversationJob(jobs) ?: requireNotNull(jobs.lastOrNull())
            val sessionId = current.sessionId ?: jobs.firstNotNullOfOrNull(Job::sessionId)
            return ConversationSummary(
                ref = sessionId ?: current.target ?: jobs.first().id,
                concept = current.target,
                status = conversationStatus(current),
                adapter = current.adapter,
                provider = current.provider,
                model = current.model,
                currentJobId = current.id,
                runningJobId = jobs.lastOrNull { it.running }?.id,
                updatedAt = jobs.maxOfOrNull(::jobUpdatedAt),
                chatAvailable = sessionId != null || current.adapter in setOf("opencode", "codex"),
                jobIds = jobs.map(Job::id),
                target = current.target,
                sessionId = sessionId,
                conversationId = current.conversationId ?: legacyConversationIdentity(
                    sessionId ?: current.target ?: jobs.first().id,
                    current.target, current.adapter, sessionId, jobs.map(Job::id),
                ),
            )
        }
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

data class QuotaWindow(
    val remainingPercent: Double?,
    val resetAt: String?,
    val durationMinutes: Double?,
)
data class QuotaLimit(val id: String, val primary: QuotaWindow?, val secondary: QuotaWindow?)
data class QuotaSource(val kind: String?, val official: Boolean?)
data class QuotaFreshness(val observedAt: String?, val stale: Boolean?)
data class QuotaCredits(
    val balance: Double?, val hasCredits: Boolean?, val unlimited: Boolean?, val resetAt: String?,
    val spendRemainingPercent: Double?,
)
data class QuotaError(val code: String, val message: String?)
data class ProviderQuota(
    val provider: String,
    val status: String,
    val source: QuotaSource,
    val freshness: QuotaFreshness,
    val limits: List<QuotaLimit>,
    val plan: String?,
    val credits: QuotaCredits?,
    val error: QuotaError?,
) {
    companion object {
        private fun number(j: JSONObject?, key: String): Double? =
            if (j == null || !j.has(key) || j.isNull(key)) null else j.optDouble(key).takeIf { it.isFinite() }

        private fun window(j: JSONObject?): QuotaWindow? = j?.let {
            QuotaWindow(number(it, "remainingPercent"), it.optStringOrNull("resetAt"), number(it, "durationMinutes"))
        }

        fun parse(body: String): ProviderQuota {
            val j = JSONObject(body)
            val source = j.optJSONObject("source")
            val freshness = j.optJSONObject("freshness")
            val rawLimits = j.optJSONObject("limits") ?: JSONObject()
            val limits = rawLimits.keys().asSequence().toList().sorted().mapNotNull { id ->
                rawLimits.optJSONObject(id)?.let { limit ->
                    QuotaLimit(limit.optStringOrNull("id") ?: id, window(limit.optJSONObject("primary")), window(limit.optJSONObject("secondary")))
                }
            }.toList()
            val rawCredits = j.optJSONObject("credits")
            val credits = rawCredits?.let {
                val spend = it.optJSONObject("spendControl")
                QuotaCredits(
                    number(it, "balance"),
                    if (it.has("hasCredits") && !it.isNull("hasCredits")) it.optBoolean("hasCredits") else null,
                    if (it.has("unlimited") && !it.isNull("unlimited")) it.optBoolean("unlimited") else null,
                    it.optStringOrNull("resetAt"),
                    number(spend, "remainingPercent"),
                )
            }
            val rawError = j.optJSONObject("error")
            return ProviderQuota(
                provider = j.optString("provider"),
                status = j.optString("status", "error"),
                source = QuotaSource(source?.optStringOrNull("kind"), source?.let {
                    if (it.has("official") && !it.isNull("official")) it.optBoolean("official") else null
                }),
                freshness = QuotaFreshness(
                    freshness?.optStringOrNull("observedAt"),
                    freshness?.let { if (it.has("stale") && !it.isNull("stale")) it.optBoolean("stale") else null },
                ),
                limits = limits,
                plan = j.optStringOrNull("plan"),
                credits = credits,
                error = rawError?.optStringOrNull("code")?.let { QuotaError(it, rawError.optStringOrNull("message")) },
            )
        }
    }
}

internal fun normalizeHttpBase(value: String): String {
    require(value.length <= 2048) { "dirección demasiado larga" }
    val uri = runCatching { URI(value.trim()) }.getOrElse { throw IllegalArgumentException("dirección inválida") }
    require(uri.scheme?.lowercase() in setOf("http", "https")) { "la dirección debe usar http o https" }
    require(!uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null) {
        "dirección inválida"
    }
    require(uri.port in -1..65535) { "puerto inválido" }
    require(uri.path.isNullOrBlank() || uri.path == "/") { "la dirección no puede incluir una ruta" }
    return URI(uri.scheme.lowercase(), null, uri.host, uri.port, null, null, null).toString().trimEnd('/')
}

/** Historical usage is deliberately distinct from quota: no made-up limits or percentages. */
data class UsageValue(val value: Long, val partial: Boolean)
data class UsageCost(val value: Double, val partial: Boolean)
data class UsageTotals(
    val input: UsageValue?,
    val output: UsageValue?,
    val total: UsageValue?,
    val cost: UsageCost?,
)
data class UsageSession(
    val session: String?,
    val target: String?,
    val jobId: String?,
    val totals: UsageTotals,
)
data class UsageScope(
    val key: String,
    val engine: String,
    val provider: String?,
    val sessions: List<UsageSession>,
    val totals: UsageTotals,
)
data class Usage(val scopes: List<UsageScope>) {
    companion object {
        private fun value(j: JSONObject, key: String): UsageValue? {
            val item = j.optJSONObject(key) ?: return null
            if (item.isNull("value")) return null
            return UsageValue(item.optLong("value"), item.optBoolean("partial"))
        }
        private fun cost(j: JSONObject): UsageCost? {
            val item = j.optJSONObject("cost") ?: return null
            if (item.isNull("value")) return null
            return UsageCost(item.optDouble("value"), item.optBoolean("partial"))
        }
        private fun totals(j: JSONObject?) = j?.let {
            UsageTotals(value(it, "input"), value(it, "output"), value(it, "total"), cost(it))
        } ?: UsageTotals(null, null, null, null)

        fun parse(body: String): Usage {
            val scopes = JSONObject(body).optJSONArray("scopes") ?: JSONArray()
            return Usage((0 until scopes.length()).mapNotNull { index ->
                val scope = scopes.optJSONObject(index) ?: return@mapNotNull null
                val sessions = scope.optJSONArray("sessions") ?: JSONArray()
                UsageScope(
                    key = scope.optString("key", ""),
                    engine = scope.optString("engine", ""),
                    provider = scope.optStringOrNull("provider"),
                    sessions = (0 until sessions.length()).mapNotNull { sessionIndex ->
                        val row = sessions.optJSONObject(sessionIndex) ?: return@mapNotNull null
                        UsageSession(
                            session = row.optStringOrNull("session"), target = row.optStringOrNull("target"),
                            jobId = row.optStringOrNull("jobId"), totals = totals(row.optJSONObject("usage")),
                        )
                    },
                    totals = totals(scope.optJSONObject("totals")),
                )
            }.filter { it.key.isNotBlank() })
        }
    }
}

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

/** Bounded canonical diff. Lines retain their literal unified-diff prefixes. */
data class Diff(
    val id: String,
    val file: String,
    val added: Int,
    val removed: Int,
    val lines: List<String>,
    val truncated: Boolean = false,
    val truncationReason: String? = null,
    val eventId: String? = null,
)

data class Turn(val role: String, val at: String?, val blocks: List<Block>, val diffs: List<Diff>, val live: Boolean = false)

data class TodoItem(val content: String, val activeForm: String?, val status: String)

sealed class Block {
    data class Text(val text: String, val eventId: String? = null) : Block()
    data class Tool(val name: String, val arg: String, val eventId: String? = null) : Block()
    data class Thinking(val text: String, val eventId: String? = null) : Block()
    data class Todos(val items: List<TodoItem>, val eventId: String? = null) : Block()
}

data class Chat(
    val sessionId: String,
    val target: String?,
    val adapter: String?,
    val provider: String?,
    val model: String?,
    val dir: String?,
    val turns: List<Turn>,
    val cursor: String? = null,
    val eventIds: Set<String> = emptySet(),
    val status: String? = null,
    val terminal: Boolean = false,
    val conversationId: String? = null,
) {
    val assistantLabel: String?
        get() = when (adapter?.lowercase()) {
            "claude" -> "CLAUDE"
            "codex" -> "CODEX"
            "opencode" -> listOfNotNull("OPENCODE", provider?.uppercase()).joinToString(" · ")
            null, "" -> null
            else -> adapter.uppercase()
        }

    companion object {
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
                        "text" -> b.optStringOrNull("text")?.takeIf { it.isNotBlank() }?.let { Block.Text(it, b.eventId()) }
                        "thinking" -> b.optStringOrNull("text")?.let { Block.Thinking(it, b.eventId()) }
                        "tool" -> Block.Tool(b.optString("name", "tool"), b.toolArg(), b.eventId())
                        "todos" -> Block.Todos(b.todos(), b.eventId())
                        else -> null
                    }
                }
                val diffs = t.optJSONArray("diffs") ?: JSONArray()
                val parsedDiffs = (0 until diffs.length()).mapNotNull { k -> diffs.optJSONObject(k)?.canonicalDiff() }
                if (blocks.isEmpty() && parsedDiffs.isEmpty()) null
                else Turn(t.optString("role"), t.optStringOrNull("at"), blocks, parsedDiffs, t.optBoolean("live"))
            }

            return Chat(
                sessionId = j.optString("sessionId"),
                target = j.optStringOrNull("target"),
                adapter = j.optStringOrNull("adapter"),
                provider = j.optStringOrNull("provider"),
                model = j.optStringOrNull("model"),
                dir = j.optStringOrNull("dir"),
                cursor = j.optStringOrNull("cursor"),
                eventIds = j.optJSONArray("eventIds").strings().toSet() + turns.flatMap { turn ->
                    turn.blocks.mapNotNull { block -> when (block) {
                        is Block.Text -> block.eventId
                        is Block.Tool -> block.eventId
                        is Block.Todos -> block.eventId
                        is Block.Thinking -> block.eventId
                    } } + turn.diffs.mapNotNull(Diff::eventId)
                }.toSet(),
                status = j.optStringOrNull("status"),
                terminal = j.optBoolean("terminal"),
                conversationId = j.optStringOrNull("conversationId"),
                turns = turns,
            )
        }
    }
}

data class Snapshot(val state: State, val conversations: List<ConversationSummary>) {
    companion object {
        fun parse(body: String): Snapshot {
            val json = JSONObject(body)
            val state = State.parse(json.getJSONObject("state").toString())
            return Snapshot(state, ConversationSummary.parse(
                (json.optJSONArray("conversations") ?: JSONArray()).toString(), state,
            ))
        }
    }
}

data class LiveEvent(
    val id: String?, val jobId: String?, val kind: String, val text: String? = null,
    val name: String? = null, val arg: String = "", val todos: List<TodoItem> = emptyList(),
    val status: String? = null, val diff: Diff? = null,
) {
    companion object {
        fun parse(body: String): LiveEvent {
            val j = JSONObject(body)
            return LiveEvent(
                id = j.eventId("id"), jobId = j.optStringOrNull("jobId"),
                kind = j.optString("kind", j.optString("type")), text = j.optStringOrNull("text"),
                name = j.optStringOrNull("name"),
                arg = j.toolArg(),
                todos = j.todos(),
                status = j.optStringOrNull("status"),
                diff = j.optJSONObject("diff")?.canonicalDiff(j.eventId("id")),
            )
        }
    }
}

data class PairingState(val mode: String, val registered: Boolean, val protocol: Int) {
    companion object {
        fun parse(body: String): PairingState {
            val j = JSONObject(body)
            val registered = if (j.has("registered")) j.optBoolean("registered") else j.optInt("removed") == 0
            return PairingState(j.optString("mode"), registered, j.optInt("protocol"))
        }
    }
}

// org.json turns a JSON null into the STRING "null", which is how you end up rendering the
// word "null" on screen. These two make absent mean absent.
fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).ifBlank { null }

fun JSONObject.optLongOrNull(key: String): Long? =
    if (isNull(key) || !has(key)) null else optLong(key).takeIf { it != 0L }

internal fun JSONArray?.strings(): List<String> = this?.let { array ->
    (0 until array.length()).mapNotNull { index ->
        (array.opt(index) as? String)?.takeIf(String::isNotBlank)
    }
}.orEmpty()

private fun JSONObject.eventId(key: String = "eventId"): String? = optStringOrNull(key)

private fun JSONObject.toolArg(): String {
    val input = optJSONObject("input")
    return TOOL_ARG_KEYS.firstNotNullOfOrNull { key -> input?.optStringOrNull(key) }.orEmpty()
}

private fun JSONObject.todos(): List<TodoItem> {
    val values = optJSONArray("todos") ?: return emptyList()
    return (0 until values.length()).mapNotNull { index ->
        values.optJSONObject(index)?.let { todo ->
            TodoItem(
                todo.optString("content"),
                todo.optStringOrNull("activeForm"),
                todo.optString("status", "pending"),
            )
        }
    }
}

private fun JSONObject.canonicalDiff(fallbackEventId: String? = null): Diff? {
    val file = optStringOrNull("file") ?: return null
    val array = optJSONArray("lines")
    val lines = if (array != null) (0 until array.length()).mapNotNull { array.opt(it) as? String }
    else optStringOrNull("diff")?.split("\n").orEmpty()
    if (lines.isEmpty()) return null
    val id = optStringOrNull("id") ?: "legacy:${file}:${lines.joinToString("\n").hashCode()}"
    return Diff(
        id = id,
        file = file,
        added = optInt("added", lines.count { it.startsWith("+") }),
        removed = optInt("removed", lines.count { it.startsWith("-") }),
        lines = lines,
        truncated = optBoolean("truncated", false),
        truncationReason = optStringOrNull("truncationReason") ?: optStringOrNull("truncated_reason"),
        eventId = optStringOrNull("eventId") ?: fallbackEventId,
    )
}
