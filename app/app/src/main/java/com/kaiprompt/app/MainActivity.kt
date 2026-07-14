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
    private var update by mutableStateOf<Update.Available?>(null)
    private var settings by mutableStateOf(false)
    private var confirmClear by mutableStateOf(false)

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
            .onFailure { error = "Ese QR no es de Kaiprompt. Usa el que sale con «kaip serve»." }
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
                            settings -> SettingsScreen { settings = false }
                            chat != null -> ChatScreen(chat!!) { chat = null }
                            openJob != null -> JobScreen(openJob!!) { openJob = null }
                            else -> QueueScreen()
                        }
                    }
                }
            }
        }
        if (pairing != null) refresh()

        // One request to GitHub, off the main thread, and never fatal: failing to reach it
        // must NOT be shown as "you are out of date". A false alarm is worse than no alarm.
        lifecycleScope.launch(Dispatchers.IO) {
            val found = Update.check(this@MainActivity)
            withContext(Dispatchers.Main) { update = found }
        }
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

    /**
     * Introduce this phone to the PC: what it is called, and where to knock when a launch ends.
     *
     * The name goes up even when there is no address to knock on. It used to bail out here if
     * `localAddress()` came back null — which it does on mobile data with no wifi — and the
     * consequence was not just "no push notifications": the PC never heard from the phone at
     * all, so it never learnt its name and never counted it as paired. The pairing QR stayed
     * on screen and the device list showed nothing.
     */
    private fun announceSelf(p: Pairing) = lifecycleScope.launch(Dispatchers.IO) {
        val callback = localAddress()?.let { ListenerService.callbackUrl(it) }
        runCatching { Api(p).registerDevice(callback, deviceName()) }
    }

    /** What this phone is called. Never blank, and never "?" — the PC cannot work this out. */
    private fun deviceName(): String {
        val model = Build.MODEL?.trim().orEmpty()
        val brand = Build.MANUFACTURER?.trim().orEmpty()
        return when {
            model.isBlank() && brand.isBlank() -> "móvil"
            model.isBlank() -> brand.replaceFirstChar(Char::uppercase)
            // "Pixel 7" already says Google; "SM-A536B" does not say Samsung.
            model.startsWith(brand, ignoreCase = true) || brand.isBlank() -> model
            else -> "${brand.replaceFirstChar(Char::uppercase)} $model"
        }
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
                .onFailure { cause ->
                    error = when {
                        cause is Api.Down && cause.message?.startsWith("el PC respondió 404") == true ->
                            "El PC está conectado, pero esta conversación no está disponible todavía."
                        cause is Api.Down -> cause.message ?: "No llego al PC."
                        else -> "No pude abrir la conversación: ${cause.message ?: "error desconocido"}"
                    }
                }
        }
    }

    private fun unpair() {
        store.pairing = null
        pairing = null
        state = null
        settings = false               // it is invoked from inside Settings; do not strand us there
        ListenerService.stop(this)
        CatchUpWorker.cancel(this)
    }

    /** Same source Update.check compares against, so the two can never disagree. */
    private fun appVersion(): String =
        runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName?.trim().orEmpty()
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: "—"

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
                // Two steps, not three: `kaip serve` prints the pairing QR itself. There used
                // to be a separate command for it, and this screen went on telling people to
                // type it long after it stopped existing.
                Step(1, "En el PC, arranca el servidor", "kaip serve")
                Spacer(Modifier.height(16.dp))
                Step(2, "Escanea aquí el QR que sale ahí mismo", null)
            }

            Spacer(Modifier.height(30.dp))
            Button(
                onClick = {
                    scanner.launch(
                        ScanOptions()
                            .setBeepEnabled(false)
                            .setOrientationLocked(false)
                            .setPrompt("Apunta al QR de «kaip serve»")
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

            // The "nothing will fire" and "a run is draining it" banners used to live here.
            // They are worth knowing and they are NOT what you open this app to look at —
            // they are diagnosis, so they moved into Settings. What survives at the top is the
            // one line that answers "what is happening", which now includes `Parado`: the
            // same alarm, said in one word, and visible from across the room.
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
                    // The PC's name, from the PC. This used to read `pairing.host` — a field
                    // the compact QR stopped carrying — so it painted a literal "?".
                    Text(s?.host ?: "…", color = K.Muted, fontSize = 12.sp)
                }
            }

            // One button. The reload was doing what onResume already does, and the unpair —
            // the single most destructive thing here — sat one mis-tap from everything else.
            // Both are now inside Settings, where you go on purpose.
            IconButton(onClick = { settings = true }) {
                Text("⚙", color = K.Muted, fontSize = 19.sp)
            }
        }

        NowStrip(s?.now ?: Now(Activity.UNKNOWN), s)
        HorizontalDivider(color = K.Line)
    }

    /**
     * What is happening, right now. Always on screen, above everything.
     *
     * The whole reason this exists is the difference between `Esperando cupo` and `Parado`.
     * From a phone both look like "nothing is moving", and they are opposites: one comes back
     * by itself at a time we can print, the other is never going to happen. Without the
     * distinction you learn to read a still queue as "broken" — and then you shrug at it on
     * the day it actually is.
     */
    @Composable
    private fun NowStrip(now: Now, s: State?) {
        val (colour, icon, label) = when (now.activity) {
            Activity.RUNNING -> Triple(K.Accent, "●", "Ejecutando")
            Activity.QUOTA -> Triple(K.Warn, "⏸", "Esperando cupo")
            Activity.STALLED -> Triple(K.Err, "■", "Parado")
            Activity.QUEUED -> Triple(K.Info, "◷", "En espera")
            Activity.IDLE -> Triple(K.Ok, "✓", "Al día")
            Activity.UNKNOWN -> Triple(K.Muted, "·", if (error != null) "Sin conexión" else "…")
        }

        // What each state owes you underneath — the thing you would otherwise have to walk to
        // the PC to find out.
        val detail = when (now.activity) {
            Activity.RUNNING -> listOfNotNull(
                now.preview?.take(60),
                now.since?.let { "desde hace ${elapsed(it)}" },
            ).joinToString("  ·  ")

            // The time it comes back is the entire message. "Waiting" without a time is
            // indistinguishable from "hung".
            Activity.QUOTA -> listOfNotNull(
                now.until?.let { "vuelve ${relative(it)}" },
                if (now.pending > 0) "${now.pending} en cola" else null,
            ).joinToString("  ·  ")

            Activity.STALLED ->
                "${now.pending} en cola y nadie que los lance. Arranca «kaip daemon start» en el PC."

            Activity.QUEUED -> listOfNotNull(
                "${now.pending} en cola",
                now.next?.let { "el próximo, ${relative(it)}" },
            ).joinToString("  ·  ")

            Activity.IDLE -> "No hay nada pendiente."
            Activity.UNKNOWN -> error?.takeIf { it.isNotBlank() }?.lines()?.firstOrNull() ?: ""
        }

        Column(
            Modifier.fillMaxWidth()
                .background(colour.copy(alpha = 0.10f))
                .padding(20.dp, 11.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(icon, color = colour, fontSize = 13.sp)
                Spacer(Modifier.width(8.dp))
                Text(label, color = colour, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                if (now.activity == Activity.RUNNING) {
                    Spacer(Modifier.width(8.dp))
                    Blink()
                }
            }
            if (detail.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    detail,
                    color = K.Text.copy(alpha = 0.75f), fontSize = 12.sp, lineHeight = 16.sp,
                    maxLines = 2,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
            }
        }
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
                "Encola algo desde el PC:",
                color = K.Muted, fontSize = 13.sp,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                "kaip add \"corre los tests\" --at +2h",
                color = K.Accent, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(K.Card).padding(10.dp, 6.dp),
            )
        }
    }

    // ============================== SETTINGS ======================================
    /**
     * Everything you want when something is not working, and nothing you want when it is.
     *
     * These facts used to be scattered: who was draining the queue shouted from a banner on
     * the main screen every single launch; the tunnel URL and the connected IPs existed only
     * on the PC, so answering "is my phone even reaching it?" meant walking to the PC — which
     * is the exact thing this app is for not having to do.
     *
     * They are diagnosis. Diagnosis belongs somewhere you go on purpose.
     */
    @Composable
    private fun SettingsScreen(onBack: () -> Unit) {
        val s = state

        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(8.dp, 14.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text("‹  volver", color = K.Muted, fontSize = 15.sp) }
                Spacer(Modifier.weight(1f))
                Text("Ajustes", color = K.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(16.dp))
            }
            HorizontalDivider(color = K.Line)

            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {

                // Nothing updates a sideloaded APK, so an old one can sit here for weeks
                // quietly missing whatever got fixed. A notice, not an auto-update: replacing
                // the app someone is looking at, over their data, is not ours to decide.
                update?.let { u ->
                    Column(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(11.dp))
                            .background(K.Accent.copy(alpha = 0.12f))
                            .clickable { Update.download(this@MainActivity) }
                            .padding(15.dp),
                    ) {
                        Text(
                            "✦  Hay una versión nueva: ${u.version}",
                            color = K.Accent, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text("Toca para descargarla.", color = K.Muted, fontSize = 12.sp)
                    }
                    Spacer(Modifier.height(22.dp))
                }

                // --- who is draining the queue -------------------------------------------
                // The one silent way this tool can lie to you: work scheduled for 3am, and
                // nobody to fire it. Worth knowing; not worth shouting on every screen.
                Group("Quién está drenando la cola")
                val d = s?.daemon
                val who = when {
                    d == null -> "—"
                    !d.running -> "Nadie"
                    d.kind == "daemon" -> "El daemon"
                    else -> "Un «kaip run»"
                }
                val whoColour = when {
                    d == null -> K.Muted
                    !d.running -> K.Err
                    d.durable -> K.Ok
                    else -> K.Warn          // it fires today, and dies with its window
                }
                Fact("ahora mismo", who, whoColour)
                d?.pid?.let { if (d.running) Fact("pid", "$it") }
                // Uptime: how long whoever holds the queue has been holding it.
                d?.since?.let { if (d.running) Fact("lleva corriendo", elapsed(it)) }

                if (d != null && !d.running && s.hasScheduled) {
                    Spacer(Modifier.height(10.dp))
                    Note(
                        "Tienes trabajo agendado que NO se va a lanzar. En el PC:",
                        "kaip daemon start",
                        K.Err,
                    )
                } else if (d != null && d.running && !d.durable && s.hasScheduled) {
                    Spacer(Modifier.height(10.dp))
                    Note(
                        "Se lanzará — pero ese run muere si cierras su ventana. Para que sobreviva:",
                        "kaip daemon start",
                        K.Warn,
                    )
                }

                Spacer(Modifier.height(26.dp))

                // --- the connection ------------------------------------------------------
                Group("La conexión")
                Fact("PC", s?.host ?: "—")
                Fact("túnel", s?.server?.tunnel ?: (if (pairing?.tunnel == true) "—" else "sin túnel (wifi)"))
                Fact("esta app usa", pairing?.url ?: "—")

                // Who has actually talked to the PC. The answer to "is my phone even getting
                // through?" — which you cannot otherwise ask from the phone.
                Spacer(Modifier.height(10.dp))
                Text("IPS CONECTADAS", color = K.Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                Spacer(Modifier.height(6.dp))
                val ips = s?.server?.clients.orEmpty()
                if (ips.isEmpty()) {
                    Text("Nadie ha hablado con el PC en esta sesión.", color = K.Muted, fontSize = 12.sp)
                } else {
                    ips.forEach {
                        Text("· $it", color = K.Text, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                    }
                }

                Spacer(Modifier.height(26.dp))

                // --- versions ------------------------------------------------------------
                Group("Versiones")
                Fact("app", appVersion())
                Fact("PC (kaip)", s?.server?.version ?: "—")
                s?.server?.startedAt?.let { Fact("serve lleva", elapsed(it)) }

                Spacer(Modifier.height(30.dp))

                // --- the destructive half ------------------------------------------------
                Group("Limpieza")
                Text(
                    "Borra los lanzamientos que ya han terminado (hechos, fallidos y perdidos). " +
                        "Lo pendiente no se toca.",
                    color = K.Muted, fontSize = 12.sp, lineHeight = 17.sp,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedButton(
                    onClick = { confirmClear = true },
                    modifier = Modifier.fillMaxWidth().height(46.dp),
                    shape = RoundedCornerShape(11.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = K.Err),
                ) {
                    Text("Borrar todos los terminados", fontSize = 14.sp)
                }

                Spacer(Modifier.height(14.dp))
                TextButton(
                    onClick = { unpair() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Desemparejar este móvil", color = K.Muted, fontSize = 13.sp)
                }

                Spacer(Modifier.height(50.dp))
            }
        }

        // Confirmation, because it is not undoable and there is no bin to fish it out of.
        if (confirmClear) {
            AlertDialog(
                onDismissRequest = { confirmClear = false },
                containerColor = K.Card,
                title = { Text("¿Borrar los terminados?", color = K.Text, fontSize = 17.sp) },
                text = {
                    Text(
                        "Desaparecen del historial, con su conversación. Esto no se puede deshacer. " +
                            "Lo que está pendiente o corriendo se queda como está.",
                        color = K.Muted, fontSize = 13.sp, lineHeight = 18.sp,
                    )
                },
                confirmButton = {
                    TextButton(onClick = { confirmClear = false; clearFinished() }) {
                        Text("Borrar", color = K.Err, fontWeight = FontWeight.Bold)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { confirmClear = false }) {
                        Text("Cancelar", color = K.Muted)
                    }
                },
            )
        }
    }

    private fun clearFinished() {
        val p = pairing ?: return
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api(p).clearFinished() } }
            r.onSuccess { refresh() }
                .onFailure { error = it.message ?: "No pude borrarlos." }
        }
    }

    @Composable
    private fun Group(title: String) {
        Text(
            title.uppercase(),
            color = K.Accent, fontSize = 10.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 1.sp,
        )
        Spacer(Modifier.height(10.dp))
    }

    @Composable
    private fun Fact(k: String, v: String, colour: Color = K.Text) {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Text(k, color = K.Muted, fontSize = 12.sp, modifier = Modifier.width(104.dp))
            Text(
                v,
                color = colour, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.weight(1f),
            )
        }
    }

    @Composable
    private fun Note(body: String, cmd: String, colour: Color) {
        Column(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(colour.copy(alpha = 0.12f))
                .padding(13.dp),
        ) {
            Text(body, color = K.Text.copy(alpha = 0.85f), fontSize = 12.sp, lineHeight = 17.sp)
            Spacer(Modifier.height(7.dp))
            Text(
                cmd,
                color = K.Accent, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.clip(RoundedCornerShape(6.dp))
                    .background(K.Bg.copy(alpha = 0.5f)).padding(8.dp, 5.dp),
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
    private fun Alarm(title: String, body: String, cmd: String?, colour: Color = K.Err) {
        Column(
            Modifier.fillMaxWidth().padding(14.dp, 10.dp)
                .clip(RoundedCornerShape(11.dp))
                .background(colour.copy(alpha = 0.12f))
                .padding(15.dp),
        ) {
            Text("${if (colour == K.Err) "⚠" else "◆"}  $title", color = colour, fontSize = 13.sp, fontWeight = FontWeight.Bold)
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
