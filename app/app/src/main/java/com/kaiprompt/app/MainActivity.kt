package com.kaiprompt.app

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// The same palette as the terminal, so the two halves of the tool look like one thing.
private val Accent = Color(0xFFD97757)
private val Ok = Color(0xFF4CC38A)
private val Warn = Color(0xFFE2B254)
private val Err = Color(0xFFE5534B)
private val Muted = Color(0xFF7C8A9A)
private val Bg = Color(0xFF14161A)
private val Card = Color(0xFF1D2026)

class MainActivity : ComponentActivity() {

    private lateinit var store: Store
    private var pairing by mutableStateOf<Pairing?>(null)
    private var state by mutableStateOf<State?>(null)
    private var error by mutableStateOf<String?>(null)
    private var loading by mutableStateOf(false)
    private var openJob by mutableStateOf<Job?>(null)
    private var chat by mutableStateOf<Chat?>(null)

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        runCatching { Pairing.parse(text) }
            .onSuccess { p ->
                store.pairing = p
                pairing = p
                announceSelf(p)
                ListenerService.start(this)
                CatchUpWorker.schedule(this)
                refresh()
            }
            .onFailure { error = "ese QR no es de Kaiprompt" }
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
            MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = Card)) {
                Surface(Modifier.fillMaxSize(), color = Bg) {
                    when {
                        pairing == null -> PairScreen()
                        chat != null -> ChatScreen(chat!!) { chat = null }
                        openJob != null -> JobScreen(openJob!!) { openJob = null }
                        else -> QueueScreen()
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

    // --- talking to the PC ---------------------------------------------------
    private fun refresh() {
        val p = pairing ?: return
        loading = true
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Api(p).state() } }
            loading = false
            result
                .onSuccess { state = it; error = null }
                .onFailure { error = it.message ?: "no llego al PC" }
        }
    }

    /**
     * Tell the PC where to knock.
     *
     * The address is this phone's, as seen from the tunnel — so the webhook can reach it and
     * a finished launch shows up instantly instead of waiting for the next catch-up poll.
     */
    private fun announceSelf(p: Pairing) = lifecycleScope.launch(Dispatchers.IO) {
        val ip = localAddress() ?: return@launch
        runCatching { Api(p).registerDevice(ListenerService.callbackUrl(ip), Build.MODEL ?: "phone") }
    }

    private fun localAddress(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { !it.isLoopbackAddress && it.address.size == 4 }
            ?.hostAddress
    }.getOrNull()

    private fun openChat(job: Job) {
        val p = pairing ?: return
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Api(p).chat(job.id) } }
            result
                .onSuccess { chat = it }
                .onFailure { error = "esa conversación aún no existe (el lanzamiento no ha corrido)" }
        }
    }

    // --- screens ---------------------------------------------------------------
    @Composable
    private fun PairScreen() {
        Column(
            Modifier.fillMaxSize().padding(28.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Kaiprompt", color = Accent, fontSize = 34.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(10.dp))
            Text(
                "Escanea el QR que sale en tu PC con:",
                color = Muted, fontSize = 15.sp,
            )
            Spacer(Modifier.height(6.dp))
            Text("kaip pair", color = Accent, fontFamily = FontFamily.Monospace, fontSize = 17.sp)

            Spacer(Modifier.height(36.dp))
            Button(
                onClick = { scanner.launch(ScanOptions().setBeepEnabled(false).setPrompt("Apunta al QR de kaip pair")) },
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
            ) {
                Text("Escanear", fontSize = 17.sp)
            }

            error?.let {
                Spacer(Modifier.height(20.dp))
                Text(it, color = Err, fontSize = 14.sp)
            }

            Spacer(Modifier.height(40.dp))
            Text(
                "La clave de cifrado viaja dentro de ese QR y nunca por internet: " +
                    "por eso lo que pasa por el túnel no lo puede leer nadie.",
                color = Muted, fontSize = 12.sp,
            )
        }
    }

    @Composable
    private fun QueueScreen() {
        val s = state
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(20.dp, 22.dp, 20.dp, 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Kaiprompt", color = Accent, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text(pairing?.host ?: "", color = Muted, fontSize = 12.sp)
                }
                TextButton(onClick = { refresh() }) {
                    Text(if (loading) "…" else "actualizar", color = Muted)
                }
            }

            // The single most useful thing this screen can tell you, so it goes first: is
            // anything actually going to fire? Scheduled work with the daemon off never runs.
            if (s?.scheduledButDead == true) Banner(
                "El daemon está apagado: lo agendado NO se va a lanzar.",
                "Arráncalo en el PC:  kaip daemon start",
                Err,
            )

            error?.let { Banner(it, null, Warn) }
            s?.quota?.freePct?.let { QuotaBar(it) }

            if (s == null) {
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(if (loading) "conectando…" else "sin datos", color = Muted)
                }
                return@Column
            }

            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 14.dp)) {
                items(s.jobs.reversed()) { job -> JobRow(job) { openJob = job } }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }

    @Composable
    private fun JobRow(job: Job, onClick: () -> Unit) {
        val (icon, colour) = when (job.status) {
            "done" -> "✓" to Ok
            "running" -> "▶" to Accent
            "pending" -> "·" to Muted
            "missed" -> "⊘" to Warn
            else -> "✗" to Err
        }

        Row(
            Modifier.fillMaxWidth().padding(vertical = 5.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(Card)
                .clickable(onClick = onClick)
                .padding(14.dp),
        ) {
            Text(icon, color = colour, fontSize = 17.sp, modifier = Modifier.padding(end = 12.dp))
            Column(Modifier.weight(1f)) {
                Text(job.preview.ifBlank { job.id }, color = Color.White, fontSize = 15.sp, maxLines = 2)
                Spacer(Modifier.height(4.dp))
                Text(
                    listOfNotNull(
                        job.target?.let { "[$it]" },
                        job.whenAt?.let { at(it) },
                        job.status,
                    ).joinToString("  ·  "),
                    color = Muted, fontSize = 12.sp,
                )
            }
        }
    }

    @Composable
    private fun JobScreen(job: Job, onBack: () -> Unit) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            TextButton(onClick = onBack) { Text("← volver", color = Muted) }

            Text(job.id, color = Accent, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Text(job.status, color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(16.dp))

            if (job.sessionId != null) {
                Button(
                    onClick = { openChat(job) },
                    colors = ButtonDefaults.buttonColors(containerColor = Accent),
                ) { Text("ver la conversación entera") }
                Spacer(Modifier.height(16.dp))
            }

            job.error?.let {
                Section("Por qué falló", it, Err)
                Spacer(Modifier.height(16.dp))
            }
            // A linked job whose file vanished has no prompt at all — say that, rather than
            // showing an empty box that looks like a bug.
            job.promptError?.let {
                Section("El archivo del prompt", it, Warn)
                Spacer(Modifier.height(16.dp))
            }

            Section("Prompt", job.prompt ?: "(sin prompt)", Color.White)
            job.promptFile?.let {
                Spacer(Modifier.height(8.dp))
                Text("← $it", color = Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }

            Spacer(Modifier.height(16.dp))
            job.dir?.let { Section("Carpeta", it, Muted) }
            Spacer(Modifier.height(40.dp))
        }
    }

    @Composable
    private fun ChatScreen(c: Chat, onBack: () -> Unit) {
        Column(Modifier.fillMaxSize().padding(horizontal = 14.dp)) {
            TextButton(onClick = onBack) { Text("← volver", color = Muted) }
            Text(c.target ?: c.sessionId.take(8), color = Accent, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Text("${c.turns.size} turnos", color = Muted, fontSize = 12.sp)
            Spacer(Modifier.height(10.dp))

            LazyColumn(Modifier.fillMaxSize()) {
                items(c.turns) { turn ->
                    val you = turn.role == "user"
                    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                        Text(
                            if (you) "❯ tú" else "⏺ claude",
                            color = if (you) Accent else Ok,
                            fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.height(4.dp))
                        for (b in turn.blocks) when (b) {
                            is Block.Text -> Text(b.text, color = Color.White, fontSize = 14.sp)
                            is Block.Thinking -> Text(b.text, color = Muted, fontSize = 12.sp)
                            is Block.Tool -> Text(
                                "⎿ ${b.name}${if (b.arg.isNotBlank()) "(${b.arg})" else ""}",
                                color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
                item { Spacer(Modifier.height(30.dp)) }
            }
        }
    }

    // --- bits ------------------------------------------------------------------
    @Composable
    private fun Banner(text: String, hint: String?, colour: Color) {
        Column(
            Modifier.fillMaxWidth().padding(14.dp, 6.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(colour.copy(alpha = 0.14f))
                .padding(14.dp),
        ) {
            Text(text, color = colour, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            hint?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
            }
        }
    }

    @Composable
    private fun QuotaBar(freePct: Int) {
        val colour = when {
            freePct > 40 -> Ok
            freePct > 15 -> Warn
            else -> Err
        }
        Column(Modifier.fillMaxWidth().padding(20.dp, 8.dp)) {
            Text("cupo de sesión: $freePct% libre", color = Muted, fontSize = 12.sp)
            Spacer(Modifier.height(5.dp))
            LinearProgressIndicator(
                progress = { freePct / 100f },
                modifier = Modifier.fillMaxWidth().height(5.dp).clip(RoundedCornerShape(3.dp)),
                color = colour,
                trackColor = Card,
            )
        }
    }

    @Composable
    private fun Section(title: String, body: String, colour: Color) {
        Column(Modifier.fillMaxWidth()) {
            Text(title.uppercase(), color = Muted, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text(
                body,
                color = colour,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Card)
                    .padding(12.dp),
            )
        }
    }

    private fun at(ms: Long): String =
        SimpleDateFormat("d MMM HH:mm", Locale.getDefault()).format(Date(ms))
}
