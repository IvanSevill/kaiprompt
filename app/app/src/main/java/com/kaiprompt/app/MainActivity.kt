package com.kaiprompt.app

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.annotation.StringRes
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import androidx.core.app.NotificationManagerCompat
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
    private var showWhatsNew by mutableStateOf(false)
    private var language by mutableStateOf(AppLanguage.SYSTEM)
    private var usage by mutableStateOf<Usage?>(null)
    private var notificationsEnabled by mutableStateOf(true)

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
            .onFailure { error = localizedString(R.string.error_invalid_qr) }
    }

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            notificationsEnabled = notificationsAreEnabled()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        pairing = store.pairing
        language = store.language
        showWhatsNew = store.seenVersion != installedVersion()
        Notifier.ensureChannels(this)
        notificationsEnabled = notificationsAreEnabled()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (pairing != null) {
            ListenerService.start(this)
            CatchUpWorker.schedule(this)
        }

        setContent {
            val localizedContext = remember(language) { language.localizedContext(this@MainActivity) }
            CompositionLocalProvider(LocalContext provides localizedContext) {
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
                        if (showWhatsNew) WhatsNewDialog()
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
        notificationsEnabled = notificationsAreEnabled()
        if (pairing != null) refresh()
    }

    private fun notificationsAreEnabled(): Boolean {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        val channel = getSystemService(NotificationManager::class.java).getNotificationChannel(Notifier.CHANNEL_DONE)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    private fun openNotificationSettings() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    // --- talking to the PC ------------------------------------------------------
    private fun refresh() {
        val p = pairing ?: return
        loading = true
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api(p, language.localizedContext(this@MainActivity)).state() } }
            loading = false
            r.onSuccess { state = it; error = null }
                .onFailure { error = it.message ?: localizedString(R.string.error_pc_unreachable) }
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
        runCatching { Api(p, language.localizedContext(this@MainActivity)).registerDevice(callback, deviceName(), store.deviceId) }
    }

    /** What this phone is called. Never blank, and never "?" — the PC cannot work this out. */
    private fun deviceName(): String {
        val model = Build.MODEL?.trim().orEmpty()
        val brand = Build.MANUFACTURER?.trim().orEmpty()
        return when {
            model.isBlank() && brand.isBlank() -> localizedString(R.string.device_default_name)
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
            val r = withContext(Dispatchers.IO) { runCatching { Api(p, language.localizedContext(this@MainActivity)).chat(job.id) } }
            chatLoading = false
            r.onSuccess { chat = it }
                .onFailure { cause ->
                    error = when {
                        cause is Api.Down && cause.statusCode == 404 ->
                            localizedString(R.string.error_chat_unavailable)
                        cause is Api.Down -> cause.message ?: localizedString(R.string.error_pc_unreachable)
                        else -> localizedString(R.string.error_open_chat, cause.message ?: localizedString(R.string.error_unknown))
                    }
                }
        }
    }

    private fun refreshUsage() {
        val p = pairing ?: return
        lifecycleScope.launch {
            val found = withContext(Dispatchers.IO) {
                runCatching { Api(p, language.localizedContext(this@MainActivity)).usage() }
            }
            usage = found.getOrNull()
        }
    }

    private fun installedVersion(): String = packageManager
        .getPackageInfo(packageName, 0).versionName.orEmpty()

    private fun localizedString(@StringRes id: Int, vararg formatArgs: Any): String =
        language.localizedContext(this).getString(id, *formatArgs)

    private fun unpair() {
        val p = pairing ?: return
        lifecycleScope.launch {
            // The server is told while credentials still exist, but an unreachable PC must
            // never trap somebody in a pairing they chose to remove.
            withContext(Dispatchers.IO) {
                runCatching { Api(p, language.localizedContext(this@MainActivity)).deleteDevice(store.deviceId) }
            }
            clearPairing()
        }
    }

    private fun clearPairing() {
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
                stringResource(R.string.pair_tagline),
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
                Step(1, stringResource(R.string.pair_step_start), "kaip serve")
                Spacer(Modifier.height(16.dp))
                Step(2, stringResource(R.string.pair_step_scan), null)
            }

            Spacer(Modifier.height(30.dp))
            Button(
                onClick = {
                    scanner.launch(
                        ScanOptions()
                            .setBeepEnabled(false)
                            .setOrientationLocked(false)
                            .setPrompt(localizedString(R.string.pair_scan_prompt))
                    )
                },
                colors = ButtonDefaults.buttonColors(containerColor = K.Accent, contentColor = K.Bg),
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(12.dp),
            ) {
                Text(stringResource(R.string.pair_scan_button), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }

            AnimatedVisibility(error != null) {
                Column {
                    Spacer(Modifier.height(18.dp))
                    Text(error ?: "", color = K.Err, fontSize = 13.sp)
                }
            }

            Spacer(Modifier.height(36.dp))
            Text(
                stringResource(R.string.pair_security),
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

            update?.let { UpdateNotice(it) }

            // The "nothing will fire" and "a run is draining it" banners used to live here.
            // They are worth knowing and they are NOT what you open this app to look at —
            // they are diagnosis, so they moved into Settings. What survives at the top is the
            // one line that answers "what is happening", which now includes `Parado`: the
            // same alarm, said in one word, and visible from across the room.
            AnimatedVisibility(error != null) {
                Alarm(stringResource(R.string.connection_alarm_title), error ?: "", stringResource(R.string.connection_alarm_hint))
            }

            s?.quota?.let { QuotaStrip(it) }

            when {
                s == null && loading -> Center { Pulse(stringResource(R.string.connecting)) }
                s == null -> Center { Text(stringResource(R.string.no_data), color = K.Muted) }
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
            Activity.RUNNING -> Triple(K.Accent, "●", stringResource(R.string.activity_running))
            Activity.QUOTA -> Triple(K.Warn, "⏸", stringResource(R.string.activity_quota))
            Activity.STALLED -> Triple(K.Err, "■", stringResource(R.string.activity_stalled))
            Activity.QUEUED -> Triple(K.Info, "◷", stringResource(R.string.activity_queued))
            Activity.IDLE -> Triple(K.Ok, "✓", stringResource(R.string.activity_idle))
            Activity.UNKNOWN -> Triple(K.Muted, "·", if (error != null) stringResource(R.string.activity_offline) else "…")
        }

        // What each state owes you underneath — the thing you would otherwise have to walk to
        // the PC to find out.
        val detail = when (now.activity) {
            Activity.RUNNING -> listOfNotNull(
                now.preview?.take(60),
                now.since?.let { stringResource(R.string.since_duration, elapsed(it)) },
            ).joinToString("  ·  ")

            // The time it comes back is the entire message. "Waiting" without a time is
            // indistinguishable from "hung".
            Activity.QUOTA -> listOfNotNull(
                now.until?.let { stringResource(R.string.returns_relative, relative(LocalContext.current, it)) },
                if (now.pending > 0) stringResource(R.string.items_in_queue, now.pending) else null,
            ).joinToString("  ·  ")

            Activity.STALLED ->
                stringResource(R.string.stalled_detail, now.pending)

            Activity.QUEUED -> listOfNotNull(
                stringResource(R.string.items_in_queue, now.pending),
                now.next?.let { stringResource(R.string.next_relative, relative(LocalContext.current, it)) },
            ).joinToString("  ·  ")

            Activity.IDLE -> stringResource(R.string.nothing_pending)
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
        Column(Modifier.fillMaxWidth().padding(20.dp, 12.dp, 20.dp, 6.dp)) {
            QuotaBar(
                label = stringResource(R.string.quota_session),
                free = free,
                resetsAt = q.resetsAt,
                renewed = q.renewed,
            )
            q.freePctWeek?.let {
                Spacer(Modifier.height(10.dp))
                QuotaBar(label = stringResource(R.string.quota_weekly), free = it, resetsAt = q.resetsAtWeek)
            }
        }
    }

    @Composable
    private fun UpdateNotice(u: Update.Available) {
        Column(
            Modifier.fillMaxWidth()
                .padding(14.dp, 10.dp, 14.dp, 0.dp)
                .clip(RoundedCornerShape(11.dp))
                .background(K.Accent.copy(alpha = 0.12f))
                .clickable { Update.download(this@MainActivity, u.downloadUrl) }
                .padding(15.dp),
        ) {
            Text(
                stringResource(R.string.update_available, u.version),
                color = K.Accent, fontSize = 13.sp, fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(4.dp))
            Text(stringResource(R.string.update_download), color = K.Muted, fontSize = 12.sp)
        }
    }

    @Composable
    private fun WhatsNewDialog() {
        val version = installedVersion()
        AlertDialog(
            onDismissRequest = { },
            containerColor = K.Card,
            title = { Text(stringResource(R.string.whats_new_title), color = K.Text, fontSize = 18.sp) },
            text = {
                Column {
                    Text(stringResource(R.string.version, version), color = K.Accent, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(12.dp))
                    Text(
                        stringResource(R.string.whats_new_body),
                        color = K.Muted, fontSize = 13.sp, lineHeight = 19.sp,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    store.seenVersion = version
                    showWhatsNew = false
                }) {
                    Text(stringResource(R.string.understood), color = K.Accent, fontWeight = FontWeight.Bold)
                }
            },
        )
    }

    @Composable
    private fun QuotaBar(label: String, free: Int, resetsAt: Long?, renewed: Boolean = false) {
        val colour = when {
            free > 40 -> K.Ok
            free > 15 -> K.Warn
            else -> K.Err
        }
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                Text(label, color = K.Muted, fontSize = 11.sp)
                Text(
                    if (renewed) stringResource(R.string.quota_renewed) else stringResource(R.string.quota_free, free) +
                        (resetsAt?.let { "  ·  ${stringResource(R.string.returns_relative, relative(LocalContext.current, it))}" } ?: ""),
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
        val prompt = job.prompt ?: job.preview.ifBlank { job.id }
        // Newlines alone miss a long paragraph that wraps to several phone lines.
        val promptLines = maxOf(prompt.lines().size, (prompt.length + 55) / 56)
        val canExpand = promptLines > 3
        var expanded by remember(job.id) { mutableStateOf(false) }

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
                    Chip(K.statusLabel(LocalContext.current, job.status), colour)
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
                    prompt,
                    color = K.Text, fontSize = 14.sp, maxLines = 3, lineHeight = 19.sp,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )

                if (canExpand) {
                    TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
                        Text(
                            if (expanded) stringResource(R.string.collapse_prompt)
                            else if (job.running) stringResource(R.string.show_prompt_lines_running, promptLines - 3)
                            else stringResource(R.string.show_prompt_lines, promptLines - 3),
                            color = K.Accent, fontSize = 12.sp,
                        )
                    }
                    if (expanded) {
                        Text(
                            prompt,
                            color = K.Text, fontSize = 13.sp, lineHeight = 18.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.fillMaxWidth().padding(top = 2.dp)
                                .clip(RoundedCornerShape(8.dp)).background(K.CardHi).padding(10.dp),
                        )
                    }
                }

                if (job.running && job.prompt != null && !canExpand) {
                    TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
                        Text(stringResource(R.string.show_prompt), color = K.Accent, fontSize = 12.sp)
                    }
                    if (expanded) Text(job.prompt, color = K.Text, fontSize = 13.sp, lineHeight = 18.sp)
                }

                val foot = listOfNotNull(
                    job.whenAt?.let { if (job.pending) stringResource(R.string.job_scheduled, relative(LocalContext.current, it)) else clock(LocalContext.current, it) },
                    job.finishedAt?.let { stringResource(R.string.job_finished, relative(LocalContext.current, it)) },
                    if (job.whenAt == null && job.pending) stringResource(R.string.job_waits_for_run) else null,
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
            Text(stringResource(R.string.empty_queue), color = K.Text, fontSize = 16.sp)
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.empty_queue_hint),
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
        LaunchedEffect(Unit) { refreshUsage() }

        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(8.dp, 14.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text(stringResource(R.string.back), color = K.Muted, fontSize = 15.sp) }
                Spacer(Modifier.weight(1f))
                Text(stringResource(R.string.settings), color = K.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(16.dp))
            }
            HorizontalDivider(color = K.Line)

            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {

                Group(stringResource(R.string.language))
                LanguageSelector()
                Spacer(Modifier.height(26.dp))

                Group(stringResource(R.string.notifications))
                Fact(
                    stringResource(R.string.notification_status),
                    stringResource(if (notificationsEnabled) R.string.notification_enabled else R.string.notification_disabled),
                    if (notificationsEnabled) K.Ok else K.Err,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedButton(
                    onClick = {
                        if (notificationsEnabled) {
                            Notifier(this@MainActivity).jobFinished(
                                "manual-${System.currentTimeMillis()}", true,
                                localizedString(R.string.notification_test_body), null,
                            )
                        } else openNotificationSettings()
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(11.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = if (notificationsEnabled) K.Text else K.Err),
                ) {
                    Text(stringResource(if (notificationsEnabled) R.string.notification_test else R.string.notification_open_settings))
                }
                Spacer(Modifier.height(26.dp))

                UsagePanel(usage)
                Spacer(Modifier.height(26.dp))

                // --- who is draining the queue -------------------------------------------
                // The one silent way this tool can lie to you: work scheduled for 3am, and
                // nobody to fire it. Worth knowing; not worth shouting on every screen.
                Group(stringResource(R.string.queue_drainer))
                val d = s?.daemon
                val who = when {
                    d == null -> "—"
                    !d.running -> stringResource(R.string.nobody)
                    d.kind == "daemon" -> stringResource(R.string.the_daemon)
                    else -> stringResource(R.string.a_run)
                }
                val whoColour = when {
                    d == null -> K.Muted
                    !d.running -> K.Err
                    d.durable -> K.Ok
                    else -> K.Warn          // it fires today, and dies with its window
                }
                Fact(stringResource(R.string.now), who, whoColour)
                d?.pid?.let { if (d.running) Fact(stringResource(R.string.pid), "$it") }
                // Uptime: how long whoever holds the queue has been holding it.
                d?.since?.let { if (d.running) Fact(stringResource(R.string.running_for), elapsed(it)) }

                if (d != null && !d.running && s.hasScheduled) {
                    Spacer(Modifier.height(10.dp))
                    Note(
                        stringResource(R.string.scheduled_not_running),
                        "kaip daemon start",
                        K.Err,
                    )
                } else if (d != null && d.running && !d.durable && s.hasScheduled) {
                    Spacer(Modifier.height(10.dp))
                    Note(
                        stringResource(R.string.fragile_run),
                        "kaip daemon start",
                        K.Warn,
                    )
                }

                Spacer(Modifier.height(26.dp))

                // --- the connection ------------------------------------------------------
                Group(stringResource(R.string.connection))
                Fact(stringResource(R.string.pc), s?.host ?: "—")
                Fact(stringResource(R.string.tunnel), s?.server?.tunnel ?: (if (pairing?.tunnel == true) "—" else stringResource(R.string.no_tunnel)))
                Fact(stringResource(R.string.app_uses), pairing?.url ?: "—")

                // Who has actually talked to the PC. The answer to "is my phone even getting
                // through?" — which you cannot otherwise ask from the phone.
                Spacer(Modifier.height(10.dp))
                Text(stringResource(R.string.connected_ips), color = K.Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                Spacer(Modifier.height(6.dp))
                val ips = s?.server?.clients.orEmpty()
                if (ips.isEmpty()) {
                    Text(stringResource(R.string.no_connected_ips), color = K.Muted, fontSize = 12.sp)
                } else {
                    ips.forEach {
                        Text("· $it", color = K.Text, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                    }
                }

                Spacer(Modifier.height(26.dp))

                // --- versions ------------------------------------------------------------
                Group(stringResource(R.string.versions))
                Fact(stringResource(R.string.app), appVersion())
                Fact(stringResource(R.string.pc_kaip), s?.server?.version ?: "—")
                s?.server?.startedAt?.let { Fact(stringResource(R.string.serve_running_for), elapsed(it)) }

                Spacer(Modifier.height(30.dp))

                // --- the destructive half ------------------------------------------------
                Group(stringResource(R.string.cleanup))
                Text(
                    stringResource(R.string.cleanup_description),
                    color = K.Muted, fontSize = 12.sp, lineHeight = 17.sp,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedButton(
                    onClick = { confirmClear = true },
                    modifier = Modifier.fillMaxWidth().height(46.dp),
                    shape = RoundedCornerShape(11.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = K.Err),
                ) {
                    Text(stringResource(R.string.clear_finished), fontSize = 14.sp)
                }

                Spacer(Modifier.height(14.dp))
                TextButton(
                    onClick = { unpair() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.unpair), color = K.Muted, fontSize = 13.sp)
                }

                Spacer(Modifier.height(50.dp))
            }
        }

        // Confirmation, because it is not undoable and there is no bin to fish it out of.
        if (confirmClear) {
            AlertDialog(
                onDismissRequest = { confirmClear = false },
                containerColor = K.Card,
                title = { Text(stringResource(R.string.clear_confirm_title), color = K.Text, fontSize = 17.sp) },
                text = {
                    Text(
                        stringResource(R.string.clear_confirm_body),
                        color = K.Muted, fontSize = 13.sp, lineHeight = 18.sp,
                    )
                },
                confirmButton = {
                    TextButton(onClick = { confirmClear = false; clearFinished() }) {
                        Text(stringResource(R.string.clear), color = K.Err, fontWeight = FontWeight.Bold)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { confirmClear = false }) {
                        Text(stringResource(R.string.cancel), color = K.Muted)
                    }
                },
            )
        }
    }

    private fun clearFinished() {
        val p = pairing ?: return
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api(p, language.localizedContext(this@MainActivity)).clearFinished() } }
            r.onSuccess { refresh() }
                .onFailure { error = it.message ?: localizedString(R.string.error_clear) }
        }
    }

    @Composable
    private fun UsagePanel(data: Usage?) {
        Group(stringResource(R.string.usage))
        if (data == null) {
            Text(stringResource(R.string.usage_unavailable), color = K.Muted, fontSize = 12.sp)
            return
        }
        if (data.scopes.isEmpty()) {
            Text(stringResource(R.string.usage_empty), color = K.Muted, fontSize = 12.sp)
            return
        }
        var selected by remember { mutableIntStateOf(0) }
        val selectedIndex = selected.coerceIn(0, data.scopes.lastIndex)
        val scope = data.scopes[selectedIndex]
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            data.scopes.forEachIndexed { index, item ->
                FilterChip(
                    selected = index == selectedIndex,
                    onClick = { selected = index },
                    label = { Text(item.provider ?: item.engine, fontSize = 11.sp) },
                )
            }
        }
        Spacer(Modifier.height(10.dp))
        UsageTotals(scope.totals)
        scope.sessions.forEach { session ->
            Spacer(Modifier.height(8.dp))
            Text(session.target ?: session.session ?: session.jobId ?: "—", color = K.Text, fontSize = 12.sp)
            UsageTotals(session.totals, compact = true)
        }
    }

    @Composable
    private fun UsageTotals(totals: UsageTotals, compact: Boolean = false) {
        val input = totals.input?.let { stringResource(R.string.usage_input, it.value) }
        val output = totals.output?.let { stringResource(R.string.usage_output, it.value) }
        val total = totals.total?.let { stringResource(R.string.usage_total, it.value) }
        val cost = totals.cost?.let { stringResource(R.string.usage_cost, it.value) }
        val values = listOfNotNull(input, output, total, cost)
        Text(
            if (values.isEmpty()) stringResource(R.string.usage_unavailable) else values.joinToString("  ·  "),
            color = if (compact) K.Muted else K.Accent, fontSize = if (compact) 11.sp else 12.sp,
        )
    }

    @Composable
    private fun LanguageSelector() {
        var expanded by remember { mutableStateOf(false) }
        val label = when (language) {
            AppLanguage.SYSTEM -> stringResource(R.string.language_system)
            AppLanguage.SPANISH -> stringResource(R.string.language_spanish)
            AppLanguage.ENGLISH -> stringResource(R.string.language_english)
        }
        Box {
            OutlinedButton(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(11.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = K.Text),
            ) { Text(label, modifier = Modifier.weight(1f)) }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                AppLanguage.entries.forEach { option ->
                    val optionLabel = when (option) {
                        AppLanguage.SYSTEM -> stringResource(R.string.language_system)
                        AppLanguage.SPANISH -> stringResource(R.string.language_spanish)
                        AppLanguage.ENGLISH -> stringResource(R.string.language_english)
                    }
                    DropdownMenuItem(
                        text = { Text(optionLabel) },
                        onClick = {
                            store.language = option
                            language = option
                            Notifier.ensureChannels(this@MainActivity)
                            expanded = false
                        },
                    )
                }
            }
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
                TextButton(onClick = onBack) { Text(stringResource(R.string.back), color = K.Muted, fontSize = 15.sp) }
            }
            HorizontalDivider(color = K.Line)

            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(K.statusIcon(job.status), color = colour, fontSize = 20.sp)
                    Spacer(Modifier.width(9.dp))
                    Chip(K.statusLabel(LocalContext.current, job.status), colour, solid = true)
                    job.target?.let { Spacer(Modifier.width(7.dp)); Chip(it, K.Info) }
                }

                Spacer(Modifier.height(14.dp))
                Text(job.id, color = K.Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)

                // Why it failed comes FIRST. It is the only thing you opened this screen for.
                job.error?.let {
                    Spacer(Modifier.height(20.dp))
                    Section(stringResource(R.string.why_failed), it, K.Err)
                }
                job.promptError?.let {
                    Spacer(Modifier.height(20.dp))
                    Section(stringResource(R.string.prompt_file), it, K.Warn)
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
                            if (chatLoading) stringResource(R.string.chat_loading) else stringResource(R.string.view_full_chat),
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }

                Spacer(Modifier.height(22.dp))
                Section(stringResource(R.string.prompt), job.prompt ?: stringResource(R.string.prompt_unreadable), K.Text)
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
            job.dir?.let { stringResource(R.string.job_folder) to it },
            job.whenAt?.let { stringResource(R.string.job_scheduled_label) to clock(LocalContext.current, it) },
            job.startedAt?.let { stringResource(R.string.job_started) to clock(LocalContext.current, it) },
            job.finishedAt?.let { stringResource(R.string.job_finished_label) to clock(LocalContext.current, it) },
            job.sessionId?.let { stringResource(R.string.session) to it.take(8) + "…" },
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
        val assistantLabel = c.assistantLabel ?: stringResource(R.string.role_assistant)
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(8.dp, 12.dp, 20.dp, 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onBack) { Text(stringResource(R.string.back), color = K.Muted, fontSize = 15.sp) }
                Spacer(Modifier.weight(1f))
                Text(stringResource(R.string.turn_count, c.turns.size), color = K.Muted, fontSize = 12.sp)
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
                Center { Text(stringResource(R.string.empty_chat), color = K.Muted, fontSize = 14.sp) }
                return@Column
            }

            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(0.dp, 14.dp, 16.dp, 44.dp),
            ) {
                items(c.turns) { turn -> Turn(turn, assistantLabel) }
            }
        }
    }

    @Composable
    private fun Turn(turn: Turn, assistantLabel: String) {
        val you = turn.role == "user"
        val edge = if (you) K.Accent else K.Ok

        Row(Modifier.fillMaxWidth().padding(bottom = 18.dp)) {
            // The coloured rail down the left: whose turn this is, readable without a label.
            Box(Modifier.width(2.dp).fillMaxHeight().background(edge.copy(alpha = 0.45f)))
            Spacer(Modifier.width(12.dp))

            Column(Modifier.weight(1f)) {
                Text(
                    if (you) stringResource(R.string.role_you) else assistantLabel,
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
                if (turn.diffs.isNotEmpty()) DiffToggle(turn.diffs)
            }
        }
    }

    @Composable
    private fun DiffToggle(diffs: List<Diff>) {
        var expanded by remember(diffs) { mutableStateOf(false) }
        val added = diffs.sumOf { it.added }
        val removed = diffs.sumOf { it.removed }
        TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
            Text(
                if (expanded) "▼  +$added -$removed" else stringResource(R.string.diff_files, added, removed, diffs.size),
                color = K.Info, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            )
        }
        if (expanded) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState())
                    .clip(RoundedCornerShape(8.dp)).background(K.Card).padding(10.dp),
            ) {
                diffs.forEach { diff ->
                    Text(diff.file, color = K.Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                    diff.diff.lines().forEach { line ->
                        Text(
                            line,
                            color = when {
                                line.startsWith("+") -> K.Ok
                                line.startsWith("-") -> K.Err
                                else -> K.Text
                            },
                            fontSize = 11.sp, lineHeight = 15.sp, fontFamily = FontFamily.Monospace,
                        )
                    }
                    Spacer(Modifier.height(8.dp))
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
