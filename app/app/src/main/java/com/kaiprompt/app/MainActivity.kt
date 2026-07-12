package com.kaiprompt.app

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.NetworkInterface

class MainActivity : ComponentActivity() {

    private lateinit var store: Store

    private var pairing by mutableStateOf<Pairing?>(null)
    private var state by mutableStateOf<State?>(null)
    private var error by mutableStateOf<String?>(null)
    private var loading by mutableStateOf(false)
    private var openJob by mutableStateOf<Job?>(null)
    private var chat by mutableStateOf<Chat?>(null)
    private var chatLoading by mutableStateOf(false)

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        runCatching { Pairing.parse(text) }
            .onSuccess { p ->
                store.pairing = p
                pairing = p
                error = null
                announceSelf(p)
                ListenerService.start(this)
                CatchUpWorker.schedule(this)
                refresh()
            }
            .onFailure { error = "Ese QR no es de Kaiprompt. Usa el que sale con «kaip pair»." }
    }

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        pairing = store.pairing
        Notifier.ensureChannels(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (pairing != null) {
            ListenerService.start(this)
            CatchUpWorker.schedule(this)
        }

        setContent {
            KaipTheme {
                Surface(Modifier.fillMaxSize(), color = K.Bg) {
                    // systemBarsPadding: without it the app draws UNDER the notch and the
                    // status bar, and the top row — the back button — ends up half-hidden
                    // behind the camera cutout. Nothing about that is obvious until you
                    // hold a phone that has one.
                    Box(Modifier.fillMaxSize().systemBarsPadding()) {
                        when {
                            pairing == null -> PairScreen()
                            chat != null -> ChatScreen(chat!!) { chat = null }
                            openJob != null -> JobScreen(openJob!!) { openJob = null }
                            else -> QueueScreen()
                        }
                    }
                }
            }
        }
        if (pairing != null) refresh()
    }

    override fun onResume() {
        super.onResume()
        if (pairing != null) refresh()
    }

    // --- talking to the PC ------------------------------------------------------
    private fun refresh() {
        val p = pairing ?: return
        loading = true
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api(p).state() } }
            loading = false
            r.onSuccess { state = it; error = null }
                .onFailure { error = it.message ?: "No llego al PC." }
        }
    }

    /** Tell the PC where to knock, so a finished launch shows up at once and not on the next poll. */
    private fun announceSelf(p: Pairing) = lifecycleScope.launch(Dispatchers.IO) {
        val ip = localAddress() ?: return@launch
        runCatching { Api(p).registerDevice(ListenerService.callbackUrl(ip), Build.MODEL ?: "móvil") }
    }

    private fun localAddress(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { !it.isLoopbackAddress && it.address.size == 4 }
            ?.hostAddress
    }.getOrNull()

    private fun openChat(job: Job) {
        val p = pairing ?: return
        chatLoading = true
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api(p).chat(job.id) } }
            chatLoading = false
            r.onSuccess { chat = it }
                .onFailure { error = "Esa conversación todavía no existe: el lanzamiento no ha corrido." }
        }
    }

    private fun unpair() {
        store.pairing = null
        pairing = null
        state = null
        ListenerService.stop(this)
        CatchUpWorker.cancel(this)
    }

    // ============================== PAIR ==========================================
    @Composable
    private fun PairScreen() {
        Column(
            Modifier.fillMaxSize().padding(30.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("✦", color = K.Accent, fontSize = 44.sp)
            Spacer(Modifier.height(14.dp))
            Text("Kaiprompt", color = K.Text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text(
                "Tus prompts, corriendo solos en tu PC.",
                color = K.Muted, fontSize = 14.sp,
            )

            Spacer(Modifier.height(44.dp))

            // The three steps, numbered, because pairing is the one moment where a person is
            // following instructions rather than using an app.
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(K.Card).padding(20.dp),
            ) {
                Step(1, "En el PC, arranca el servidor", "kaip serve")
                Spacer(Modifier.height(16.dp))
                Step(2, "Pide el código de emparejamiento", "kaip pair")
                Spacer(Modifier.height(16.dp))
                Step(3, "Escanéalo aquí abajo", null)
            }

            Spacer(Modifier.height(30.dp))
            Button(
                onClick = {
                    scanner.launch(
                        ScanOptions()
                            .setBeepEnabled(false)
                            .setOrientationLocked(false)
                            .setPrompt("Apunta al QR de «kaip pair»")
                    )
                },
                colors = ButtonDefaults.buttonColors(containerColor = K.Accent, contentColor = K.Bg),
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(12.dp),
            ) {
                Text("Escanear el QR", fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }

            AnimatedVisibility(error != null) {
                Column {
                    Spacer(Modifier.height(18.dp))
                    Text(error ?: "", color = K.Err, fontSize = 13.sp)
                }
            }

            Spacer(Modifier.height(36.dp))
            Text(
                "La clave de cifrado viaja dentro de ese QR y nunca por internet. " +
                    "Por eso lo que pasa por el túnel no lo puede leer nadie — ni siquiera quien lo transporta.",
                color = K.Muted, fontSize = 11.sp,
            )
        }
    }

    @Composable
    private fun Step(n: Int, text: String, cmd: String?) {
        Row(verticalAlignment = Alignment.Top) {
            Box(
                Modifier.size(22.dp).clip(RoundedCornerShape(11.dp)).background(K.Accent.copy(alpha = 0.16f)),
                Alignment.Center,
            ) {
                Text("$n", color = K.Accent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(12.dp))
            Column {
                Text(text, color = K.Text, fontSize = 14.sp)
                cmd?.let {
                    Spacer(Modifier.height(5.dp))
                    Text(
                        it,
                        color = K.Accent,
                        fontSize = 13.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.clip(RoundedCornerShape(6.dp))
                            .background(K.CardHi).padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
        }
    }

    // ============================== QUEUE =========================================
    @Composable
    private fun QueueScreen() {
        val s = state

        Column(Modifier.fillMaxSize()) {
            TopBar(s)

            // The alarm goes above everything, because it is the one thing that silently
            // makes the whole tool a lie: work scheduled for 3am that nothing will fire.
            AnimatedVisibility(s?.scheduledButDead == true) {
                Alarm(
                    "El daemon está apagado",
                    "Tienes trabajo agendado que NO se va a lanzar. Arráncalo en el PC:",
                    "kaip daemon start",
                )
            }

            AnimatedVisibility(error != null) {
                Alarm("No llego al PC", error ?: "", "¿Está encendido y con «kaip serve» corriendo?")
            }

            s?.quota?.let { QuotaStrip(it) }

            when {
                s == null && loading -> Center { Pulse("conectando con tu PC…") }
                s == null -> Center { Text("Sin datos.", color = K.Muted) }
                s.jobs.isEmpty() -> EmptyQueue()
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(14.dp, 4.dp, 14.dp, 28.dp)) {
                    items(s.jobs.reversed()) { JobCard(it) { openJob = it } }
                }
            }
        }
    }

    @Composable
    private fun TopBar(s: State?) {
        Row(
            Modifier.fillMaxWidth().padding(20.dp, 20.dp, 14.dp, 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("✦ ", color = K.Accent, fontSize = 17.sp)
                    Text("Kaiprompt", color = K.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(3.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val live = error == null && s != null
                    Text(
                        if (live) "◆" else "◇",
                        color = if (live) K.Ok else K.Err,
                        fontSize = 10.sp,
                    )
                    Spacer(Modifier.width(5.dp))
                    Text(pairing?.host ?: "", color = K.Muted, fontSize = 12.sp)

                    s?.let {
                        Spacer(Modifier.width(10.dp))
                        if (it.running > 0) Chip("${it.running} corriendo", K.Accent)
                        else if (it.pending > 0) Chip("${it.pending} en cola", K.Info)
                    }
                }
            }

            IconButton(onClick = { refresh() }) {
                Text(
                    "↻",
                    color = if (loading) K.Accent else K.Muted,
                    fontSize = 20.sp,
                    modifier = Modifier.alpha(if (loading) 0.5f else 1f),
                )
            }
            IconButton(onClick = { unpair() }) {
                Text("⏻", color = K.Muted, fontSize = 16.sp)
            }
        }
        HorizontalDivider(color = K.Line)
    }

    @Composable
    private fun QuotaStrip(q: Quota) {
        val free = if (q.renewed) 100 else (q.freePct ?: return)
        val colour = when {
            free > 40 -> K.Ok
            free > 15 -> K.Warn
            else -> K.Err
        }
        Column(Modifier.fillMaxWidth().padding(20.dp, 12.dp, 20.dp, 6.dp)) {
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                Text("cupo de sesión", color = K.Muted, fontSize = 11.sp)
                Text(
                    if (q.renewed) "renovado" else "$free% libre" +
                        (q.resetsAt?.let { "  ·  vuelve ${relative(it)}" } ?: ""),
                    color = colour, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                )
            }
            Spacer(Modifier.height(6.dp))
            LinearProgressIndicator(
                progress = { free / 100f },
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
                color = colour,
                trackColor = K.Line,
                gapSize = 0.dp,
                drawStopIndicator = {},
            )
        }
    }

    @Composable
    private fun JobCard(job: Job, onClick: () -> Unit) {
        val colour = K.statusColour(job.status)

        Row(
            Modifier.fillMaxWidth().padding(vertical = 5.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(K.Card)
                .clickable(onClick = onClick),
        ) {
            // A stripe of the status colour down the edge: you can read the queue at a glance,
            // from across the room, without reading a word of it.
            Box(Modifier.width(3.dp).fillMaxHeight().background(colour))

            Column(Modifier.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(K.statusIcon(job.status), color = colour, fontSize = 13.sp)
                    Spacer(Modifier.width(7.dp))
                    Chip(K.statusLabel(job.status), colour)
                    job.target?.let {
                        Spacer(Modifier.width(6.dp))
                        Chip(it, K.Info)
                    }
                    if (job.running) {
                        Spacer(Modifier.width(6.dp))
                        Blink()
                    }
                }

                Spacer(Modifier.height(9.dp))
                Text(
                    job.preview.ifBlank { job.prompt ?: job.id },
                    color = K.Text, fontSize = 14.sp, maxLines = 3, lineHeight = 19.sp,
                )

                val foot = listOfNotNull(
                    job.whenAt?.let { if (job.pending) "sale ${relative(it)}" else clock(it) },
                    job.finishedAt?.let { "terminó ${relative(it)}" },
                    if (job.whenAt == null && job.pending) "espera a un «run»" else null,
                )
                if (foot.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(foot.joinToString("   ·   "), color = K.Muted, fontSize = 11.sp)
                }
            }
        }
    }

    @Composable
    private fun EmptyQueue() = Center {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("·", color = K.Muted, fontSize = 40.sp)
            Spacer(Modifier.height(10.dp))
            Text("La cola está vacía", color = K.Text, fontSize = 16.sp)
            Spacer(Modifier.height(8.dp))
            Text(
                "Encola algo desde el PC o desde un chat de Claude:",
                color = K.Muted, fontSize = 13.sp,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                "/programar +2h | corre los tests",
                color = K.Accent, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(K.Card).padding(10.dp, 6.dp),
            )
        }
    }

    // ============================== JOB ===========================================
    @Composable
    private fun JobScreen(job: Job, onBack: () -> Unit) {
        val colour = K.statusColour(job.status)

        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(8.dp, 14.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text("‹  volver", color = K.Muted, fontSize = 15.sp) }
            }
            HorizontalDivider(color = K.Line)

            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(K.statusIcon(job.status), color = colour, fontSize = 20.sp)
                    Spacer(Modifier.width(9.dp))
                    Chip(K.statusLabel(job.status), colour, solid = true)
                    job.target?.let { Spacer(Modifier.width(7.dp)); Chip(it, K.Info) }
                }

                Spacer(Modifier.height(14.dp))
                Text(job.id, color = K.Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)

                // Why it failed comes FIRST. It is the only thing you opened this screen for.
                job.error?.let {
                    Spacer(Modifier.height(20.dp))
                    Section("Por qué falló", it, K.Err)
                }
                job.promptError?.let {
                    Spacer(Modifier.height(20.dp))
                    Section("El archivo del prompt", it, K.Warn)
                }

                if (job.sessionId != null) {
                    Spacer(Modifier.height(20.dp))
                    Button(
                        onClick = { openChat(job) },
                        colors = ButtonDefaults.buttonColors(containerColor = K.Accent, contentColor = K.Bg),
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        shape = RoundedCornerShape(11.dp),
                    ) {
                        Text(
                            if (chatLoading) "cargando…" else "Ver la conversación entera",
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }

                Spacer(Modifier.height(22.dp))
                Section("Prompt", job.prompt ?: "(no se pudo leer)", K.Text)
                job.promptFile?.let {
                    Spacer(Modifier.height(7.dp))
                    Text("↪ $it", color = K.Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                }

                Spacer(Modifier.height(20.dp))
                Facts(job)
                Spacer(Modifier.height(44.dp))
            }
        }
    }

    @Composable
    private fun Facts(job: Job) {
        val rows = listOfNotNull(
            job.dir?.let { "carpeta" to it },
            job.whenAt?.let { "agendado" to clock(it) },
            job.startedAt?.let { "empezó" to clock(it) },
            job.finishedAt?.let { "terminó" to clock(it) },
            job.sessionId?.let { "sesión" to it.take(8) + "…" },
        )
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(K.Card).padding(14.dp)) {
            rows.forEachIndexed { i, (k, v) ->
                if (i > 0) Spacer(Modifier.height(9.dp))
                Row {
                    Text(k, color = K.Muted, fontSize = 12.sp, modifier = Modifier.width(78.dp))
                    Text(v, color = K.Text, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                }
            }
        }
    }

    // ============================== CHAT ==========================================
    /**
     * The conversation.
     *
     * The shape of it matters more than it looks like it should. A launch is mostly Claude
     * working — dozens of tool calls between the few sentences that actually say something —
     * so the tool calls are pushed into the background (small, grey, monospace, one line) and
     * the prose is given the room. Read down the accent-coloured left edge and you get the
     * conversation; read the grey and you get how it got there.
     */
    @Composable
    private fun ChatScreen(c: Chat, onBack: () -> Unit) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(8.dp, 12.dp, 20.dp, 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onBack) { Text("‹  volver", color = K.Muted, fontSize = 15.sp) }
                Spacer(Modifier.weight(1f))
                Text("${c.turns.size} turnos", color = K.Muted, fontSize = 12.sp)
            }

            Column(Modifier.padding(20.dp, 0.dp, 20.dp, 12.dp)) {
                Text(
                    c.target ?: c.sessionId.take(8),
                    color = K.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold,
                )
                c.dir?.let {
                    Spacer(Modifier.height(3.dp))
                    Text(
                        it.substringAfterLast('/').substringAfterLast('\\'),
                        color = K.Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                    )
                }
            }
            HorizontalDivider(color = K.Line)

            if (c.turns.isEmpty()) {
                Center { Text("Esta conversación está vacía.", color = K.Muted, fontSize = 14.sp) }
                return@Column
            }

            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(0.dp, 14.dp, 16.dp, 44.dp),
            ) {
                items(c.turns) { turn -> Turn(turn) }
            }
        }
    }

    @Composable
    private fun Turn(turn: Turn) {
        val you = turn.role == "user"
        val edge = if (you) K.Accent else K.Ok

        Row(Modifier.fillMaxWidth().padding(bottom = 18.dp)) {
            // The coloured rail down the left: whose turn this is, readable without a label.
            Box(Modifier.width(2.dp).fillMaxHeight().background(edge.copy(alpha = 0.45f)))
            Spacer(Modifier.width(12.dp))

            Column(Modifier.weight(1f)) {
                Text(
                    if (you) "TÚ" else "CLAUDE",
                    color = edge, fontSize = 10.sp,
                    fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp,
                )
                Spacer(Modifier.height(7.dp))

                for (b in turn.blocks) when (b) {
                    is Block.Text -> Text(
                        b.text.trim(),
                        color = K.Text, fontSize = 15.sp, lineHeight = 22.sp,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )

                    // Thinking is not the answer. It is available, but it does not compete.
                    is Block.Thinking -> Text(
                        b.text.trim(),
                        color = K.Muted, fontSize = 12.sp, lineHeight = 17.sp,
                        modifier = Modifier.fillMaxWidth()
                            .padding(bottom = 8.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(K.Card)
                            .padding(10.dp),
                    )

                    is Block.Tool -> ToolLine(b)
                }
            }
        }
    }

    /** One tool call, on one line. There are dozens of these; they must not shout. */
    @Composable
    private fun ToolLine(b: Block.Tool) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("⎿", color = K.Line, fontSize = 11.sp)
            Spacer(Modifier.width(7.dp))
            Text(
                b.name,
                color = K.Info.copy(alpha = 0.85f), fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
            )
            if (b.arg.isNotBlank()) {
                Spacer(Modifier.width(6.dp))
                Text(
                    b.arg,
                    color = K.Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }
    }

    // ============================== bits ==========================================
    @Composable
    private fun Alarm(title: String, body: String, cmd: String?) {
        Column(
            Modifier.fillMaxWidth().padding(14.dp, 10.dp)
                .clip(RoundedCornerShape(11.dp))
                .background(K.Err.copy(alpha = 0.12f))
                .padding(15.dp),
        ) {
            Text("⚠  $title", color = K.Err, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(5.dp))
            Text(body, color = K.Text.copy(alpha = 0.85f), fontSize = 12.sp, lineHeight = 17.sp)
            cmd?.let {
                Spacer(Modifier.height(8.dp))
                Text(
                    it,
                    color = K.Accent, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp))
                        .background(K.Bg.copy(alpha = 0.5f)).padding(8.dp, 5.dp),
                )
            }
        }
    }

    @Composable
    private fun Section(title: String, body: String, colour: Color) {
        Column(Modifier.fillMaxWidth()) {
            Text(title.uppercase(), color = K.Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
            Spacer(Modifier.height(7.dp))
            Text(
                body,
                color = colour, fontSize = 13.sp, lineHeight = 19.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp)).background(K.Card).padding(14.dp),
            )
        }
    }

    @Composable
    private fun Center(content: @Composable () -> Unit) =
        Box(Modifier.fillMaxSize(), Alignment.Center) { content() }

    /** A slow pulse — something is happening, without a spinner shouting about it. */
    @Composable
    private fun Pulse(text: String) {
        val t = rememberInfiniteTransition(label = "pulse")
        val a by t.animateFloat(
            0.35f, 1f,
            infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "alpha",
        )
        Text(text, color = K.Muted, fontSize = 14.sp, modifier = Modifier.alpha(a))
    }

    /** The dot that says "this one is running right now". */
    @Composable
    private fun Blink() {
        val t = rememberInfiniteTransition(label = "blink")
        val a by t.animateFloat(
            0.25f, 1f,
            infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
            label = "alpha",
        )
        Box(
            Modifier.size(7.dp).alpha(a)
                .clip(RoundedCornerShape(4.dp))
                .background(K.Accent),
        )
    }
}
