package com.kaiprompt.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.annotation.StringRes
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.net.NetworkInterface

class MainActivity : ComponentActivity() {

    private lateinit var store: Store

    private var pairing by mutableStateOf<Pairing?>(null)
    private var queue by mutableStateOf(QueueContent())
    private var usageContent by mutableStateOf(UsageContent())
    private var quotaContent by mutableStateOf(QuotaContent())
    private var quotaProvider by mutableStateOf("claude")
    private var chatDisplay by mutableStateOf(ChatDisplay())
    private var destination by mutableStateOf<Destination>(Destination.Queue)
    private var update by mutableStateOf<Update.Available?>(null)
    private var confirmClear by mutableStateOf(false)
    private var showWhatsNew by mutableStateOf(false)
    private var language by mutableStateOf(AppLanguage.SYSTEM)
    private var notificationsEnabled by mutableStateOf(true)
    private var chatLiveState by mutableStateOf("idle")
    private var chatStream: CoroutineJob? = null
    private var chatJobId: String? = null
    private var chatGeneration = 0L
    private var unpairDialog by mutableStateOf(false)
    private var unpairing by mutableStateOf(false)
    private var unpairError by mutableStateOf<String?>(null)
    private var updateCheckRunning = false
    private lateinit var pairingScope: CoroutineScope
    private var pairingGeneration = 0L
    private var refreshGeneration = 0L
    private var showHiddenConversations by mutableStateOf(false)
    private var lastAnnouncementAt = 0L
    private var lastAnnouncedPairing: Pairing? = null
    private val announcementMutex = Mutex()

    private data class QueueContent(
        val state: State? = null,
        val conversations: List<ConversationSummary> = emptyList(),
        val error: String? = null,
        val loading: Boolean = false,
    )

    private data class UsageContent(
        val data: Usage? = null,
        val loading: Boolean = false,
        val failed: Boolean = false,
    )

    private data class QuotaContent(
        val data: ProviderQuota? = null,
        val loading: Boolean = false,
        val failed: Boolean = false,
    )

    private data class ChatDisplay(
        val chat: Chat? = null,
        val loading: Boolean = false,
        val error: String? = null,
    )

    private sealed interface Destination {
        data object Queue : Destination
        data object Settings : Destination
        data class Job(val job: com.kaiprompt.app.Job) : Destination
        data class Chat(val conversation: ConversationSummary) : Destination
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        runCatching { Pairing.parse(text) }
            .onSuccess { p ->
                beginPairingSession()
                store.pairing = p
                pairing = p
                queue = queue.copy(error = null)
                ListenerService.start(this)
                announceSelf(p, force = true)
                CatchUpWorker.schedule(this)
                refresh()
            }
            .onFailure { queue = queue.copy(error = localizedString(R.string.error_invalid_qr)) }
    }

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            notificationsEnabled = notificationsAreEnabled()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        pairingScope = newPairingScope()
        pairing = store.pairing
        language = store.language
        showHiddenConversations = store.showHiddenConversations
        showWhatsNew = store.seenVersion != installedVersion()
        Notifier.ensureChannels(this)
        notificationsEnabled = notificationsAreEnabled()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (pairing != null) {
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
                        BackHandler(enabled = destination != Destination.Queue) {
                            when (destination) {
                                is Destination.Chat -> closeChat()
                                else -> destination = Destination.Queue
                            }
                        }
                        if (pairing == null) PairScreen() else when (val screen = destination) {
                            Destination.Queue -> QueueScreen()
                            Destination.Settings -> SettingsScreen { destination = Destination.Queue }
                            is Destination.Job -> JobScreen(screen.job) { destination = Destination.Queue }
                            is Destination.Chat -> chatDisplay.chat?.let {
                                ChatScreen(it, screen.conversation) { closeChat() }
                            } ?: QueueScreen()
                        }
                        if (showWhatsNew) WhatsNewDialog()
                        if (unpairDialog) UnpairDialog()
                    }
                }
            }
        }
        }
        if (pairing != null) refresh()

    }

    override fun onResume() {
        super.onResume()
        notificationsEnabled = notificationsAreEnabled()
        checkForUpdate()
        pairing?.let {
            ListenerService.start(this)
            announceSelf(it)
            refresh()
        }
    }

    override fun onStop() {
        ListenerService.stop(this)
        super.onStop()
    }

    override fun onDestroy() {
        pairingScope.cancel()
        super.onDestroy()
    }

    private fun newPairingScope(): CoroutineScope = CoroutineScope(
        SupervisorJob(lifecycleScope.coroutineContext[CoroutineJob]) + Dispatchers.Main.immediate,
    )

    private fun beginPairingSession() {
        pairingGeneration++
        pairingScope.cancel()
        pairingScope = newPairingScope()
    }

    private fun isCurrentPairing(p: Pairing, generation: Long): Boolean =
        pairing == p && pairingGeneration == generation

    private fun api(pairing: Pairing): Api =
        Api(pairing, language.localizedContext(this@MainActivity))

    private fun <T> pairingRequest(
        request: (Api) -> T,
        apply: (Result<T>) -> Unit,
    ) {
        val capturedPairing = pairing ?: return
        val generation = pairingGeneration
        pairingScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    Result.success(request(api(capturedPairing)))
                } catch (cause: CancellationException) {
                    throw cause
                } catch (cause: Throwable) {
                    Result.failure(cause)
                }
            }
            if (isCurrentPairing(capturedPairing, generation)) apply(result)
        }
    }

    private fun checkForUpdate() {
        if (updateCheckRunning) return
        updateCheckRunning = true
        lifecycleScope.launch(Dispatchers.IO) {
            val found = Update.check(this@MainActivity)
            withContext(Dispatchers.Main) {
                update = found
                updateCheckRunning = false
            }
        }
    }

    private fun notificationsAreEnabled(): Boolean {
        return Notifier.canNotify(this)
    }

    private fun openNotificationSettings() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    // --- talking to the PC ------------------------------------------------------
    private fun refresh() {
        if (pairing == null) return
        val generation = ++refreshGeneration
        queue = queue.copy(loading = true)
        pairingRequest(
            request = Api::snapshot,
            apply = { result ->
                if (!acceptsRefresh(generation, refreshGeneration)) return@pairingRequest
                queue = result.fold(
                    onSuccess = { snapshot ->
                        QueueContent(snapshot.state, snapshot.conversations, error = null, loading = false)
                    },
                    onFailure = { cause ->
                        queue.copy(
                            error = cause.message ?: localizedString(R.string.error_pc_unreachable),
                            loading = false,
                        )
                    },
                )
            }
        )
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
    private fun announceSelf(p: Pairing, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && lastAnnouncedPairing == p && now - lastAnnouncementAt < 5_000) return
        lastAnnouncedPairing = p
        lastAnnouncementAt = now
        val generation = pairingGeneration
        pairingScope.launch(Dispatchers.IO) {
            announcementMutex.withLock {
                if (!isCurrentPairing(p, generation)) return@withLock
                val callback = localAddress()?.let { ListenerService.callbackUrl(it) }
                runCatching { api(p).registerDevice(callback, deviceName(), store.deviceId) }
            }
        }
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
            .filter { it.isUp && !it.isLoopback && !it.isVirtual }
            .filterNot { it.name.lowercase().contains(Regex("tun|tap|vpn|docker|veth|virtual|vmnet|tailscale")) }
            .flatMap { network -> network.inetAddresses.toList().map { network to it } }
            .filter { (_, address) -> !address.isLoopbackAddress && address.address.size == 4 }
            .sortedWith(compareByDescending<Pair<NetworkInterface, java.net.InetAddress>> { (network, address) ->
                (if (address.isSiteLocalAddress) 10 else 0) +
                    (if (network.name.lowercase().contains(Regex("wlan|wifi|eth"))) 2 else 0)
            }.thenBy { it.first.name }.thenBy { it.second.hostAddress })
            .firstOrNull()?.second?.hostAddress
    }.getOrNull()

    private fun openChat(summary: ConversationSummary) {
        if (pairing == null || chatDisplay.loading) return
        chatGeneration++
        val streamGeneration = chatGeneration
        val streamJobId = summary.runningJobId ?: summary.currentJobId
        chatJobId = streamJobId
        chatStream?.cancel()
        chatStream = null
        destination = Destination.Chat(summary)
        chatDisplay = ChatDisplay(
            chat = Chat(
                sessionId = summary.sessionId ?: "job:${summary.ref}", target = summary.target,
                adapter = summary.adapter, provider = summary.provider, model = summary.model,
                dir = null, turns = emptyList(), status = summary.status,
                terminal = isTerminalStatus(summary.status),
                conversationId = summary.conversationId,
            ),
            loading = summary.chatAvailable,
        )
        chatLiveState = if (summary.status in setOf("pending", "quota")) "waiting" else "idle"
        if (!summary.chatAvailable) return
        pairingRequest(
            request = { it.conversation(summary) },
            apply = applyChat@{ result ->
                val current = destination as? Destination.Chat
                if (chatGeneration != streamGeneration || current?.conversation?.conversationId != summary.conversationId) return@applyChat
                result.onSuccess { loaded ->
                    chatDisplay = ChatDisplay(chat = loaded.copy(
                        conversationId = loaded.conversationId ?: summary.conversationId,
                    ))
                    if (streamJobId != null) startLiveChat(summary, streamJobId, streamGeneration)
                    else chatLiveState = "finished"
                }.onFailure { cause ->
                    val message = when {
                        cause is Api.Down && cause.statusCode == 404 ->
                            localizedString(R.string.error_chat_unavailable)
                        cause is Api.Down -> cause.message ?: localizedString(R.string.error_pc_unreachable)
                        else -> localizedString(R.string.error_open_chat, cause.message ?: localizedString(R.string.error_unknown))
                    }
                    chatDisplay = chatDisplay.copy(loading = false, error = message)
                }
            },
        )
    }

    private fun closeChat() {
        chatGeneration++
        chatJobId = null
        chatStream?.cancel()
        chatStream = null
        chatLiveState = "idle"
        chatDisplay = ChatDisplay()
        destination = Destination.Queue
        refresh()
    }

    private fun isChatIdentity(jobId: String, generation: Long): Boolean =
        jobId == chatJobId && generation == chatGeneration

    private fun isCurrentChat(jobId: String, generation: Long): Boolean =
        isChatIdentity(jobId, generation) && chatDisplay.chat != null

    private fun startLiveChat(summary: ConversationSummary, jobId: String, streamGeneration: Long) {
        chatStream?.cancel()
        val snapshot = chatDisplay.chat ?: return
        if (!shouldStreamChat(summary.status, snapshot)) {
            chatLiveState = "finished"
            return
        }
        val p = pairing ?: return
        val generation = pairingGeneration
        chatLiveState = "connecting"
        chatStream = pairingScope.launch(Dispatchers.IO) {
            var waitMs = 500L
            while (isCurrentPairing(p, generation) && isCurrentChat(jobId, streamGeneration)) {
                try {
                    val end = api(p).events(
                        jobId,
                        chatDisplay.chat?.cursor,
                        onConnected = {
                            runOnUiThread {
                                if (isCurrentPairing(p, generation) && isCurrentChat(jobId, streamGeneration)) {
                                    chatLiveState = "live"
                                }
                            }
                        },
                    ) { event ->
                        runOnUiThread eventUpdate@{
                            if (!isCurrentPairing(p, generation) || !acceptsLiveEvent(
                                    jobId, streamGeneration, chatJobId, chatGeneration, event.jobId,
                                ) || chatDisplay.chat == null
                            ) return@eventUpdate
                            if (event.kind == "reset") reloadChat(summary, jobId, streamGeneration)
                            else chatDisplay = chatDisplay.copy(chat = chatDisplay.chat?.let { mergeLiveEvent(it, event) })
                        }
                    }
                    if (end == LiveStreamEnd.TERMINAL) {
                        runOnUiThread {
                            if (isCurrentChat(jobId, streamGeneration)) {
                                chatLiveState = "finished"
                                reloadChat(summary, jobId, streamGeneration)
                            }
                        }
                        break
                    }
                    waitMs = 500L
                    runOnUiThread {
                        if (isCurrentPairing(p, generation) && isCurrentChat(jobId, streamGeneration)) {
                            chatLiveState = "reconnecting"
                        }
                    }
                    delay(waitMs)
                    waitMs = (waitMs * 2).coerceAtMost(8_000L)
                } catch (cause: CancellationException) {
                    throw cause
                } catch (_: Exception) {
                    runOnUiThread {
                        if (isCurrentPairing(p, generation) && isCurrentChat(jobId, streamGeneration)) chatLiveState = "reconnecting"
                    }
                    delay(waitMs)
                    waitMs = (waitMs * 2).coerceAtMost(8_000L)
                }
            }
        }
    }

    private fun reloadChat(summary: ConversationSummary, jobId: String, streamGeneration: Long = chatGeneration) {
        pairingRequest(
            request = { it.conversation(summary) },
            apply = applyReload@{ result ->
                if (!isCurrentChat(jobId, streamGeneration)) return@applyReload
                result.onSuccess { fresh ->
                    val normalized = fresh.copy(
                        conversationId = fresh.conversationId ?: summary.conversationId,
                    )
                    chatDisplay = chatDisplay.copy(chat = mergeChatSnapshot(chatDisplay.chat, normalized))
                }
            },
        )
    }

    private fun refreshUsage() {
        if (pairing == null) return
        usageContent = usageContent.copy(loading = true, failed = false)
        pairingRequest(
            request = Api::usage,
            apply = { result ->
                usageContent = result.fold(
                    onSuccess = { UsageContent(data = it) },
                    onFailure = { usageContent.copy(loading = false, failed = true) },
                )
            },
        )
    }

    private fun refreshQuota() {
        if (pairing == null) return
        val requestedProvider = quotaProvider
        quotaContent = QuotaContent(loading = true)
        pairingRequest(
            request = { it.quota(requestedProvider) },
            apply = { result ->
                if (quotaProvider != requestedProvider) return@pairingRequest
                quotaContent = result.fold(
                    onSuccess = { QuotaContent(data = it) },
                    onFailure = { QuotaContent(failed = true) },
                )
            },
        )
    }

    private fun installedVersion(): String = packageManager
        .getPackageInfo(packageName, 0).versionName.orEmpty()

    private fun localizedString(@StringRes id: Int, vararg formatArgs: Any): String =
        language.localizedContext(this).getString(id, *formatArgs)

    private fun unpair() {
        val p = pairing ?: return
        val generation = pairingGeneration
        if (unpairing) return
        unpairDialog = true
        unpairing = true
        unpairError = null
        pairingScope.launch {
            val attempt = withContext(Dispatchers.IO) {
                try {
                    val client = api(p)
                    val remote = client.deleteDevice(store.deviceId)
                    if (!remote.registered) UnpairAttempt(UnpairAttemptKind.REMOTE_SUCCESS)
                    else UnpairAttempt(UnpairAttemptKind.TIMEOUT, localizedString(R.string.unpair_wait_timeout))
                } catch (cause: Api.Unauthorized) {
                    UnpairAttempt(UnpairAttemptKind.UNAUTHORIZED, cause.message)
                } catch (cause: Api.Down) {
                    UnpairAttempt(UnpairAttemptKind.API_DOWN, cause.message)
                } catch (cause: CancellationException) {
                    throw cause
                } catch (cause: Exception) {
                    UnpairAttempt(UnpairAttemptKind.API_DOWN, cause.message)
                }
            }
            if (!isCurrentPairing(p, generation)) return@launch
            unpairing = false
            when (unpairDecision(attempt.kind)) {
                UnpairDecision.CLEAR_LOCAL_PAIRING -> clearPairing()
                UnpairDecision.OFFER_LOCAL_FORGET -> {
                    unpairError = attempt.message ?: localizedString(R.string.error_pc_unreachable)
                }
            }
        }
    }

    private fun clearPairing() {
        beginPairingSession()
        store.pairing = null
        store.announced = emptyList()
        store.notificationBaselineReady = false
        pairing = null
        queue = QueueContent()
        usageContent = UsageContent()
        quotaContent = QuotaContent()
        chatDisplay = ChatDisplay()
        destination = Destination.Queue
        chatLiveState = "idle"
        chatStream = null
        chatJobId = null
        chatGeneration++
        confirmClear = false
        unpairDialog = false
        unpairing = false
        unpairError = null
        ListenerService.stop(this)
        CatchUpWorker.cancel(this)
    }

    private data class UnpairAttempt(val kind: UnpairAttemptKind, val message: String? = null)

    /** Same source Update.check compares against, so the two can never disagree. */
    private fun appVersion(): String =
        runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName?.trim().orEmpty()
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: "—"

    // ============================== PAIR ==========================================
    @Composable
    private fun PairScreen() {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 36.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.fillMaxWidth().widthIn(max = 560.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Sparkle(52.dp)
                Spacer(Modifier.height(18.dp))
                Text("Kaiprompt", color = K.Text, style = MaterialTheme.typography.headlineLarge)
                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(R.string.pair_tagline), color = K.Muted,
                    style = MaterialTheme.typography.bodyLarge,
                )

                Spacer(Modifier.height(40.dp))
                Panel {
                    Step(1, stringResource(R.string.pair_step_start), "kaip serve")
                    Spacer(Modifier.height(20.dp))
                    Step(2, stringResource(R.string.pair_step_scan), null)
                }

                update?.let {
                    Spacer(Modifier.height(18.dp))
                    UpdateNotice(it)
                }

                Spacer(Modifier.height(24.dp))
                Button(
                    onClick = {
                        scanner.launch(
                            ScanOptions().setBeepEnabled(false).setOrientationLocked(false)
                                .setPrompt(localizedString(R.string.pair_scan_prompt))
                        )
                    },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp),
                ) {
                    Icon(Icons.Default.QrCodeScanner, contentDescription = null)
                    Spacer(Modifier.width(10.dp))
                    Text(stringResource(R.string.pair_scan_button), style = MaterialTheme.typography.labelLarge)
                }

                AnimatedVisibility(queue.error != null) {
                    Alarm(stringResource(R.string.pair_error_title), queue.error ?: "", null)
                }

                Spacer(Modifier.height(28.dp))
                Row(verticalAlignment = Alignment.Top) {
                    Icon(
                        Icons.Default.Security, contentDescription = null, tint = K.Ok,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(
                        stringResource(R.string.pair_security), color = K.Muted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
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
                Text(text, color = K.Text, style = MaterialTheme.typography.bodyMedium)
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
        val s = queue.state
        val visibleConversations = if (showHiddenConversations) queue.conversations else queue.conversations.filterNot { it.hidden }

        Column(Modifier.fillMaxSize()) {
            TopBar(s)

            update?.let { UpdateNotice(it) }

            // The "nothing will fire" and "a run is draining it" banners used to live here.
            // They are worth knowing and they are NOT what you open this app to look at —
            // they are diagnosis, so they moved into Settings. What survives at the top is the
            // one line that answers "what is happening", which now includes `Parado`: the
            // same alarm, said in one word, and visible from across the room.
            AnimatedVisibility(queue.error != null && s != null) {
                Alarm(stringResource(R.string.connection_alarm_title), queue.error ?: "", stringResource(R.string.connection_alarm_hint))
            }

            when {
                s == null && queue.loading -> Center { StateMessage(stringResource(R.string.connecting), loading = true) }
                s == null -> Center {
                    StateMessage(
                        title = stringResource(R.string.no_data),
                        body = queue.error ?: stringResource(R.string.no_data_detail),
                        actionLabel = stringResource(R.string.retry),
                        onAction = { refresh() },
                    )
                }
                visibleConversations.isEmpty() -> EmptyQueue()
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(14.dp, 8.dp, 14.dp, 28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    item(key = "queue-heading") { QueueHeading(visibleConversations.size) }
                    items(visibleConversations, key = { it.conversationId }) { summary ->
                        ConversationCard(summary) { openChat(summary) }
                    }
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
                    Sparkle(18.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Kaiprompt", color = K.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(3.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val live = queue.error == null && s != null
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
            if (queue.loading && s != null) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp), color = K.Accent, strokeWidth = 2.dp,
                )
                Spacer(Modifier.width(8.dp))
            }
            IconButton(onClick = { destination = Destination.Settings }) {
                Icon(
                    Icons.Default.Settings,
                    contentDescription = stringResource(R.string.open_settings),
                    tint = K.Muted,
                )
            }
        }

        val runningSummary = s?.now?.jobId?.let { id -> queue.conversations.find { it.runningJobId == id || id in it.jobIds } }
        NowStrip(s?.now ?: Now(Activity.UNKNOWN), s) {
            runningSummary?.let(::openChat)
        }
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
    private fun NowStrip(now: Now, s: State?, onOpenRunning: () -> Unit) {
        val (colour, icon, label) = when (now.activity) {
            Activity.RUNNING -> Triple(K.Accent, "●", stringResource(R.string.activity_running))
            Activity.QUOTA -> Triple(K.Warn, "⏸", stringResource(R.string.activity_quota))
            Activity.STALLED -> Triple(K.Err, "■", stringResource(R.string.activity_stalled))
            Activity.QUEUED -> Triple(K.Info, "◷", stringResource(R.string.activity_queued))
            Activity.IDLE -> Triple(K.Ok, "✓", stringResource(R.string.activity_idle))
            Activity.UNKNOWN -> Triple(K.Muted, "·", if (queue.error != null) stringResource(R.string.activity_offline) else "…")
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
                if (now.pending > 0) pluralStringResource(R.plurals.items_in_queue_count, now.pending, now.pending) else null,
            ).joinToString("  ·  ")

            Activity.STALLED ->
                stringResource(R.string.stalled_detail, now.pending)

            Activity.QUEUED -> listOfNotNull(
                pluralStringResource(R.plurals.items_in_queue_count, now.pending, now.pending),
                now.next?.let { stringResource(R.string.next_relative, relative(LocalContext.current, it)) },
            ).joinToString("  ·  ")

            Activity.IDLE -> stringResource(R.string.nothing_pending)
            Activity.UNKNOWN -> queue.error?.takeIf { it.isNotBlank() }?.lines()?.firstOrNull() ?: ""
        }

        val canOpen = now.activity == Activity.RUNNING && now.jobId != null
        Column(
            Modifier.fillMaxWidth()
                .background(colour.copy(alpha = 0.10f))
                .then(if (canOpen) Modifier.clickable(onClick = onOpenRunning).semantics { role = Role.Button } else Modifier)
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
    private fun UpdateNotice(u: Update.Available) {
        Column(
            Modifier.fillMaxWidth()
                .padding(14.dp, 10.dp, 14.dp, 0.dp)
                .clip(RoundedCornerShape(11.dp))
                .background(K.Accent.copy(alpha = 0.12f))
                .clickable { Update.download(this@MainActivity, u.downloadUrl) }
                .semantics { role = Role.Button }
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
    private fun ConversationCard(summary: ConversationSummary, onClick: () -> Unit) {
        val colour = K.statusColour(summary.status)

        Row(
            Modifier.fillMaxWidth().widthIn(max = 760.dp).padding(vertical = 5.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(K.Card)
                .border(1.dp, K.Line.copy(alpha = 0.7f), RoundedCornerShape(16.dp))
                .clickable(onClick = onClick)
                .semantics { role = Role.Button },
        ) {
            // A stripe of the status colour down the edge: you can read the queue at a glance,
            // from across the room, without reading a word of it.
            Box(Modifier.width(3.dp).fillMaxHeight().background(colour))

            Column(Modifier.padding(14.dp).weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Chip(K.statusLabel(LocalContext.current, summary.status), colour)
                    val engine = engineLabel(summary)
                    if (engine.isNotBlank()) {
                        Spacer(Modifier.width(6.dp))
                        Chip(engine, K.Muted)
                    }
                    if (summary.status == "running") {
                        Spacer(Modifier.width(6.dp))
                        Blink()
                    }
                }

                Spacer(Modifier.height(9.dp))
                Text(
                    summary.concept ?: stringResource(R.string.untitled_conversation),
                    color = K.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 2, lineHeight = 21.sp,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                val foot = listOfNotNull(
                    summary.updatedAt?.takeIf { it > 0 }?.let { relative(LocalContext.current, it) },
                    summary.jobIds.size.takeIf { it > 1 }?.let {
                        pluralStringResource(R.plurals.launch_count, it, it)
                    },
                )
                if (foot.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(foot.joinToString("   ·   "), color = K.Muted, fontSize = 11.sp)
                }
            }
        }
    }

    @Composable
    private fun QueueHeading(count: Int) {
        Row(
            Modifier.fillMaxWidth().widthIn(max = 760.dp).padding(4.dp, 10.dp, 4.dp, 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text(stringResource(R.string.conversations), color = K.Text, style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.weight(1f))
            Text(
                pluralStringResource(R.plurals.conversation_count, count, count),
                color = K.Muted,
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }

    @Composable
    private fun EmptyQueue() = Center {
        Column(
            Modifier.padding(28.dp).widthIn(max = 420.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Sparkle(34.dp, colour = K.Muted)
            Spacer(Modifier.height(10.dp))
            Text(stringResource(R.string.empty_queue), color = K.Text, fontSize = 16.sp)
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.empty_queue_hint),
                color = K.Muted, fontSize = 13.sp,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                "kaip opencode add \"corre los tests\" --provider openai --model gpt-5.6-sol",
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
        val s = queue.state
        LaunchedEffect(Unit) { refreshUsage() }
        LaunchedEffect(quotaProvider) { refreshQuota() }

        ScrollableScreen(stringResource(R.string.settings), onBack) {

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

                QuotaPanel(quotaContent)
                Spacer(Modifier.height(26.dp))

                UsagePanel(usageContent.data, usageContent.loading, usageContent.failed)
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

                // --- conversation visibility ---------------------------------------------
                Group(stringResource(R.string.conversation_management))
                Panel {
                    Text(
                        stringResource(R.string.cleanup_description),
                        color = K.Muted, fontSize = 12.sp, lineHeight = 17.sp,
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(
                        onClick = { confirmClear = true },
                        modifier = Modifier.fillMaxWidth().height(46.dp),
                        shape = RoundedCornerShape(11.dp),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = K.Text),
                    ) {
                        Text(stringResource(R.string.clear_finished), fontSize = 14.sp)
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            showHiddenConversations = !showHiddenConversations
                            store.showHiddenConversations = showHiddenConversations
                        }.padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.show_hidden), color = K.Text, modifier = Modifier.weight(1f))
                        Switch(
                            checked = showHiddenConversations,
                            onCheckedChange = {
                                showHiddenConversations = it
                                store.showHiddenConversations = it
                            },
                        )
                    }
                }

                Spacer(Modifier.height(24.dp))
                OutlinedButton(
                    onClick = { unpair() },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
                    shape = RoundedCornerShape(11.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, K.Err),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = K.Err),
                ) {
                    Text(stringResource(R.string.unpair), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                }
        }

        // Confirmation prevents an accidental bulk visibility change.
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
                    TextButton(onClick = { confirmClear = false; hideFinished() }) {
                        Text(stringResource(R.string.hide), color = K.Accent, fontWeight = FontWeight.Bold)
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

    private fun hideFinished() {
        val generation = ++refreshGeneration
        pairingRequest(
            request = { it.hideFinished() },
            apply = { result ->
                if (!acceptsRefresh(generation, refreshGeneration)) return@pairingRequest
                result.onSuccess {
                    queue = queue.copy(conversations = queue.conversations.map { summary ->
                        if (isTerminalStatus(summary.status)) summary.copy(hidden = true) else summary
                    })
                    refresh()
                }
                    .onFailure { queue = queue.copy(error = it.message ?: localizedString(R.string.error_clear), loading = false) }
            },
        )
    }

    @Composable
    private fun UnpairDialog() {
        AlertDialog(
            onDismissRequest = { if (!unpairing) unpairDialog = false },
            containerColor = K.Card,
            title = { Text(stringResource(R.string.unpairing_title), color = K.Text) },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    if (unpairing) CircularProgressIndicator(color = K.Accent, modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.height(12.dp))
                    Text(
                        if (unpairing) stringResource(R.string.unpairing_waiting) else unpairError.orEmpty(),
                        color = if (unpairing) K.Muted else K.Err,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            },
            confirmButton = {
                Row {
                    if (!unpairing) TextButton(onClick = { unpair() }) {
                        Text(stringResource(R.string.retry), color = K.Accent)
                    }
                    TextButton(onClick = { clearPairing() }) {
                        Text(stringResource(R.string.forget_pc_locally), color = K.Err)
                    }
                }
            },
            dismissButton = {
                if (!unpairing) TextButton(onClick = { unpairDialog = false; unpairError = null }) {
                    Text(stringResource(R.string.cancel), color = K.Muted)
                }
            },
        )
    }

    @Composable
    private fun QuotaPanel(content: QuotaContent) {
        Group(stringResource(R.string.quota))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("claude" to "Claude", "codex" to "Codex").forEach { (id, label) ->
                FilterChip(
                    selected = quotaProvider == id,
                    onClick = { if (quotaProvider != id) quotaProvider = id },
                    label = { Text(label) },
                )
            }
        }
        Spacer(Modifier.height(10.dp))

        val quota = content.data
        if (quota == null) {
            StateMessage(
                title = stringResource(if (content.loading) R.string.quota_loading else R.string.quota_request_failed),
                loading = content.loading,
                actionLabel = if (content.failed) stringResource(R.string.retry) else null,
                onAction = if (content.failed) ({ refreshQuota() }) else null,
                compact = true,
            )
            return
        }

        val kind = quotaDisplayKind(quota)
        val statusColour = when (kind) {
            QuotaDisplayKind.AVAILABLE -> K.Ok
            QuotaDisplayKind.STALE -> K.Warn
            QuotaDisplayKind.UNAVAILABLE, QuotaDisplayKind.ERROR -> K.Err
        }
        val statusText = when (kind) {
            QuotaDisplayKind.AVAILABLE -> stringResource(R.string.quota_available)
            QuotaDisplayKind.STALE -> stringResource(R.string.quota_stale)
            QuotaDisplayKind.UNAVAILABLE -> stringResource(R.string.quota_unavailable)
            QuotaDisplayKind.ERROR -> stringResource(R.string.quota_error)
        }
        Text(statusText, color = statusColour, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        quota.error?.let {
            Spacer(Modifier.height(4.dp))
            Text(listOfNotNull(it.code, it.message).joinToString(": "), color = K.Muted, fontSize = 11.sp)
        }

        if (quota.limits.isEmpty() && kind in setOf(QuotaDisplayKind.AVAILABLE, QuotaDisplayKind.STALE)) {
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.quota_limits_unknown), color = K.Muted, fontSize = 12.sp)
        }
        quota.limits.forEach { limit ->
            Spacer(Modifier.height(12.dp))
            Text(limit.id, color = K.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            limit.primary?.let { QuotaWindowRow(stringResource(R.string.quota_primary), it) }
            limit.secondary?.let { QuotaWindowRow(stringResource(R.string.quota_secondary), it) }
        }

        val source = quota.source.kind?.let { kindLabel ->
            if (quota.source.official == true) stringResource(R.string.quota_source_official, kindLabel)
            else kindLabel
        }
        source?.let { Fact(stringResource(R.string.quota_source), it, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) }
        quota.freshness.observedAt?.let {
            Fact(stringResource(R.string.quota_observed), quotaResetLabel(it))
        }
        quota.plan?.let { Fact(stringResource(R.string.quota_plan), it) }
        quota.credits?.let { credits ->
            val values = listOfNotNull(
                credits.balance?.let { stringResource(R.string.quota_credit_balance, quotaNumber(it) ?: "") },
                credits.unlimited?.takeIf { it }?.let { stringResource(R.string.quota_credits_unlimited) },
                credits.hasCredits?.let { stringResource(if (it) R.string.quota_credits_available else R.string.quota_credits_empty) },
                credits.spendRemainingPercent?.let { stringResource(R.string.quota_credits_remaining, quotaNumber(it) ?: "") },
                credits.resetAt?.let { stringResource(R.string.quota_resets, quotaResetLabel(it)) },
            )
            if (values.isNotEmpty()) Fact(stringResource(R.string.quota_credits), values.joinToString("  ·  "))
        }
    }

    @Composable
    private fun QuotaWindowRow(label: String, window: QuotaWindow) {
        val percent = window.remainingPercent
        val reset = window.resetAt?.let(::quotaResetLabel)
        val details = listOfNotNull(
            percent?.let { stringResource(R.string.quota_remaining, quotaNumber(it) ?: "") },
            reset?.let { stringResource(R.string.quota_resets, it) },
            window.durationMinutes?.let { stringResource(R.string.quota_window_minutes, quotaNumber(it) ?: "") },
        )
        Column(Modifier.fillMaxWidth().padding(top = 7.dp)) {
            Text(label, color = K.Muted, fontSize = 11.sp)
            if (details.isNotEmpty()) Text(details.joinToString("  ·  "), color = K.Text, fontSize = 11.sp)
            percent?.let {
                Spacer(Modifier.height(5.dp))
                val colour = when { it > 40 -> K.Ok; it > 15 -> K.Warn; else -> K.Err }
                LinearProgressIndicator(
                    progress = { (it / 100.0).toFloat().coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
                    color = colour, trackColor = K.Line, gapSize = 0.dp, drawStopIndicator = {},
                )
            }
        }
    }

    private fun quotaResetLabel(value: String): String = runCatching {
        relative(language.localizedContext(this), java.time.Instant.parse(value).toEpochMilli())
    }.getOrDefault(value)

    @Composable
    private fun UsagePanel(data: Usage?, loading: Boolean, failed: Boolean) {
        Group(stringResource(R.string.usage))
        if (data == null) {
            StateMessage(
                title = stringResource(if (loading) R.string.usage_loading else R.string.usage_unavailable),
                loading = loading,
                actionLabel = if (failed) stringResource(R.string.retry) else null,
                onAction = if (failed) ({ refreshUsage() }) else null,
                compact = true,
            )
            return
        }
        if (failed) {
            StateMessage(
                title = stringResource(R.string.usage_unavailable),
                actionLabel = stringResource(R.string.retry),
                onAction = { refreshUsage() },
                compact = true,
            )
            Spacer(Modifier.height(10.dp))
        }
        if (loading) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(14.dp), color = K.Accent, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.refreshing), color = K.Muted, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(10.dp))
        }
        if (data.scopes.isEmpty()) {
            Text(stringResource(R.string.usage_empty), color = K.Muted, fontSize = 12.sp)
            return
        }
        var selected by remember { mutableIntStateOf(0) }
        val selectedIndex = selected.coerceIn(0, data.scopes.lastIndex)
        val scope = data.scopes[selectedIndex]
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
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
        val input = totals.input?.let {
            val text = stringResource(R.string.usage_input, it.value)
            if (it.partial) stringResource(R.string.usage_estimated, text) else text
        }
        val output = totals.output?.let {
            val text = stringResource(R.string.usage_output, it.value)
            if (it.partial) stringResource(R.string.usage_estimated, text) else text
        }
        val total = totals.total?.let {
            val text = stringResource(R.string.usage_total, it.value)
            if (it.partial) stringResource(R.string.usage_estimated, text) else text
        }
        val cost = totals.cost?.let {
            val text = stringResource(R.string.usage_cost, it.value)
            if (it.partial) stringResource(R.string.usage_estimated, text) else text
        }
        val values = listOfNotNull(input, output, total, cost)
        if (values.isEmpty()) {
            Text(stringResource(R.string.usage_unavailable), color = K.Muted, fontSize = 12.sp)
        } else if (compact) {
            Text(values.joinToString("  ·  "), color = K.Muted, fontSize = 11.sp)
        } else {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                values.forEach { value ->
                    Text(
                        value, color = K.Accent, style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp))
                            .background(K.CardHi).padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
            }
        }
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
        Rule(title)
        Spacer(Modifier.height(10.dp))
    }

    @Composable
    private fun Fact(
        k: String,
        v: String,
        colour: Color = K.Text,
        modifier: Modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
    ) {
        Column(modifier) {
            Text(k, color = K.Muted, fontSize = 11.sp)
            Spacer(Modifier.height(2.dp))
            Text(
                v,
                color = colour, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
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
            CommandText(cmd)
        }
    }

    // ============================== JOB ===========================================
    @Composable
    private fun JobScreen(job: Job, onBack: () -> Unit) {
        val colour = K.statusColour(job.status)

        ScrollableScreen(stringResource(R.string.kaip_job), onBack) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Chip(K.statusLabel(LocalContext.current, job.status), colour, solid = true)
                    val engine = engineLabel(job)
                    if (engine.isNotBlank()) { Spacer(Modifier.width(7.dp)); Chip(engine, K.Info) }
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

    @Composable
    private fun Facts(job: Job) {
        val rows = listOfNotNull(
            engineLabel(job).takeIf { it.isNotBlank() }?.let { stringResource(R.string.engine) to it + (job.model?.let { model -> "/$model" } ?: "") },
            job.dir?.let { stringResource(R.string.job_folder) to it },
            job.whenAt?.let { stringResource(R.string.job_scheduled_label) to clock(LocalContext.current, it) },
            job.startedAt?.let { stringResource(R.string.job_started) to clock(LocalContext.current, it) },
            job.finishedAt?.let { stringResource(R.string.job_finished_label) to clock(LocalContext.current, it) },
            if (job.startedAt != null) stringResource(R.string.duration) to elapsed(job.startedAt, job.finishedAt ?: System.currentTimeMillis()) else null,
            job.sessionId?.let { stringResource(R.string.session) to it.take(8) + "…" },
        )
        if (rows.isEmpty()) return
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(K.Card).padding(14.dp)) {
            rows.forEachIndexed { i, (k, v) ->
                if (i > 0) Spacer(Modifier.height(9.dp))
                Fact(k, v, modifier = Modifier.fillMaxWidth())
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
    private fun ChatScreen(c: Chat, summary: ConversationSummary?, onBack: () -> Unit) {
        val assistantLabel = c.assistantLabel ?: stringResource(R.string.role_assistant)
        val turns = pluralStringResource(R.plurals.turn_count_plural, c.turns.size, c.turns.size)
        val liveLabel = when (chatLiveState) {
            "live" -> stringResource(R.string.chat_live)
            "connecting" -> stringResource(R.string.chat_connecting)
            "reconnecting" -> stringResource(R.string.chat_reconnecting)
            "finished" -> stringResource(R.string.chat_finished)
            "waiting" -> stringResource(R.string.chat_waiting)
            else -> null
        }
        Column(Modifier.fillMaxSize()) {
            ScreenHeader(
                summary?.concept ?: c.target ?: stringResource(R.string.untitled_conversation), onBack,
                listOfNotNull(liveLabel, turns).joinToString(" · "),
            )

            Column(
                Modifier.align(Alignment.CenterHorizontally).widthIn(max = 840.dp)
                    .fillMaxWidth().padding(20.dp, 12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Chip(assistantLabel, K.Info)
                    c.model?.let { Spacer(Modifier.width(6.dp)); Chip(it, K.Muted) }
                    val technicalJob = summary?.currentJobId?.let { id -> queue.state?.jobs?.find { it.id == id } }
                    if (technicalJob != null) {
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = {
                            closeChat()
                            destination = Destination.Job(technicalJob)
                        }) {
                            Text(stringResource(R.string.job_details), color = K.Muted, fontSize = 12.sp)
                        }
                    }
                }
            }
            HorizontalDivider(color = K.Line)

            if (c.turns.isEmpty()) {
                val title = when {
                    chatDisplay.loading -> stringResource(R.string.chat_loading)
                    chatDisplay.error != null -> stringResource(R.string.error_chat_unavailable)
                    summary?.status == "quota" -> stringResource(R.string.chat_waiting_quota)
                    summary?.status == "pending" -> stringResource(R.string.chat_waiting_session)
                    summary?.status == "error" -> stringResource(R.string.chat_failed_empty)
                    else -> stringResource(R.string.empty_chat)
                }
                Center {
                    StateMessage(
                        title = title,
                        body = chatDisplay.error,
                        loading = chatDisplay.loading,
                        actionLabel = chatDisplay.error?.let { stringResource(R.string.retry) },
                        onAction = chatDisplay.error?.let { { summary?.let(::openChat) } },
                    )
                }
                return@Column
            }

            LazyColumn(
                Modifier.align(Alignment.CenterHorizontally).widthIn(max = 840.dp).fillMaxSize(),
                contentPadding = PaddingValues(16.dp, 18.dp, 20.dp, 44.dp),
            ) {
                itemsIndexed(c.turns, key = { index, turn -> turnStableKey(turn, index) }) { _, turn ->
                    Turn(turn, assistantLabel)
                }
            }
        }
    }

    @Composable
    private fun Turn(turn: Turn, assistantLabel: String) {
        val you = turn.role == "user"
        val edge = if (you) K.Accent else K.Ok
        val shape = RoundedCornerShape(16.dp)

        Row(Modifier.fillMaxWidth().padding(bottom = 14.dp)) {
            Box(
                Modifier.width(3.dp).heightIn(min = 48.dp).align(Alignment.Top)
                    .clip(RoundedCornerShape(3.dp)).background(edge),
            )
            Spacer(Modifier.width(10.dp))
            Column(
                Modifier.weight(1f).clip(shape)
                    .background(if (you) K.CardHi.copy(alpha = 0.65f) else K.Card)
                    .border(1.dp, edge.copy(alpha = 0.22f), shape)
                    .padding(horizontal = 15.dp, vertical = 13.dp),
            ) {
                Text(
                    if (you) stringResource(R.string.role_you) else assistantLabel,
                    color = edge, fontSize = 10.sp,
                    fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp,
                )
                Spacer(Modifier.height(7.dp))

                turn.blocks.forEachIndexed { index, block ->
                    key(blockStableKey(block, index)) {
                        when (block) {
                            is Block.Text -> Text(
                                block.text.trim(),
                                color = K.Text, fontSize = 15.sp, lineHeight = 22.sp,
                                modifier = Modifier.padding(bottom = 8.dp),
                            )
                            is Block.Thinking -> ThinkingBlock(block.text)
                            is Block.Tool -> ToolLine(block)
                            is Block.Todos -> TodoBlock(block)
                        }
                    }
                }
                if (turn.diffs.isNotEmpty()) DiffToggle(turn.diffs)
            }
        }
    }

    @Composable
    private fun TodoBlock(block: Block.Todos) {
        if (block.items.isEmpty()) return
        Column(
            Modifier.fillMaxWidth().padding(vertical = 7.dp)
                .clip(RoundedCornerShape(10.dp)).background(K.Bg.copy(alpha = 0.55f)).padding(11.dp),
        ) {
            Text("TODO", color = K.Muted, style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.height(6.dp))
            block.items.forEach { todo ->
                val colour = when (todo.status) { "completed" -> K.Muted; "in_progress" -> K.Accent; else -> K.Text }
                val icon = when (todo.status) { "completed" -> "✓"; "in_progress" -> "▶"; else -> "·" }
                Text("$icon ${todo.activeForm ?: todo.content}", color = colour, style = MaterialTheme.typography.bodySmall)
            }
        }
    }

    @Composable
    private fun ThinkingBlock(text: String) {
        var expanded by remember(text) { mutableStateOf(false) }
        Column(
            Modifier.fillMaxWidth().padding(bottom = 8.dp)
                .clip(RoundedCornerShape(10.dp)).background(K.Bg.copy(alpha = 0.55f))
                .clickable { expanded = !expanded }
                .semantics { role = Role.Button }
                .padding(horizontal = 11.dp, vertical = 9.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.thinking), color = K.Muted,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = stringResource(if (expanded) R.string.hide_thinking else R.string.show_thinking),
                    tint = K.Muted, modifier = Modifier.size(20.dp),
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                if (expanded) text.trim() else thinkingPreview(text),
                color = K.Muted, style = MaterialTheme.typography.bodySmall,
            )
        }
    }

    @Composable
    private fun DiffToggle(diffs: List<Diff>) {
        var expanded by remember(diffs.map(Diff::id)) { mutableStateOf(false) }
        val added = diffs.sumOf { it.added }
        val removed = diffs.sumOf { it.removed }
        TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
            Text(
                if (expanded) "▼  +$added -$removed" else "▶  +$added -$removed  ·  " +
                    pluralStringResource(R.plurals.diff_files_count, diffs.size, added, removed, diffs.size),
                color = K.Info, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            )
        }
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                .background(K.Bg.copy(alpha = 0.65f)).padding(11.dp),
        ) {
            var remaining = if (expanded) 120 else 6
            diffs.forEach { diff ->
                key(diff.id) {
                    Text(
                        "${diff.file}  +${diff.added} -${diff.removed}",
                        color = K.Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                    )
                    val lines = diffDisplayLines(diff, expanded).take(remaining.coerceAtLeast(0))
                    lines.forEachIndexed { index, line ->
                        key("${diff.id}:$index:${line.hashCode()}") {
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
                    }
                    remaining -= lines.size
                    if (diff.truncated) Text(
                        "[truncated: ${diff.truncationReason ?: "limit"}]",
                        color = K.Muted, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    )
                    Spacer(Modifier.height(8.dp))
                }
            }
            val available = diffs.sumOf { it.lines.size }
            val shown = (if (expanded) 120 else 6).coerceAtMost(available)
            if (shown < available) Text(
                "+${available - shown} lines", color = K.Muted,
                fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            )
        }
    }

    private fun turnStableKey(turn: Turn, index: Int): String {
        val identity = turn.diffs.firstOrNull()?.id ?: turn.blocks.firstNotNullOfOrNull { block ->
            when (block) {
                is Block.Text -> block.eventId ?: block.text.hashCode().toString()
                is Block.Tool -> block.eventId ?: "${block.name}:${block.arg}"
                is Block.Thinking -> block.eventId ?: block.text.hashCode().toString()
                is Block.Todos -> block.eventId ?: block.items.hashCode().toString()
            }
        } ?: index.toString()
        return "${turn.role}:${turn.at.orEmpty()}:$identity:$index"
    }

    private fun blockStableKey(block: Block, index: Int): String = when (block) {
        is Block.Text -> block.eventId ?: "text:$index:${block.text.hashCode()}"
        is Block.Tool -> block.eventId ?: "tool:$index:${block.name}:${block.arg}"
        is Block.Thinking -> block.eventId ?: "thinking:$index:${block.text.hashCode()}"
        is Block.Todos -> block.eventId ?: "todos:$index:${block.items.hashCode()}"
    }

    /** One tool call, on one line. There are dozens of these; they must not shout. */
    @Composable
    private fun ToolLine(b: Block.Tool) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = 3.dp).heightIn(min = 24.dp),
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
    private fun ScrollableScreen(
        title: String,
        onBack: () -> Unit,
        content: @Composable ColumnScope.() -> Unit,
    ) {
        Column(Modifier.fillMaxSize()) {
            ScreenHeader(title, onBack)
            Column(
                Modifier.align(Alignment.CenterHorizontally).widthIn(max = 760.dp).fillMaxSize()
                    .verticalScroll(rememberScrollState()).padding(20.dp),
                content = content,
            )
        }
    }

    @Composable
    private fun ScreenHeader(title: String, onBack: () -> Unit, detail: String? = null) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.back_accessibility),
                    tint = K.Text,
                )
            }
            Text(title, color = K.Text, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.weight(1f))
            detail?.let {
                Text(it, color = K.Muted, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.width(12.dp))
            }
        }
        HorizontalDivider(color = K.Line)
    }

    @Composable
    private fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
        Column(
            modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp))
                .background(K.Card).padding(18.dp),
            content = content,
        )
    }

    @Composable
    private fun StateMessage(
        title: String,
        body: String? = null,
        loading: Boolean = false,
        actionLabel: String? = null,
        onAction: (() -> Unit)? = null,
        compact: Boolean = false,
    ) {
        Column(
            Modifier.padding(if (compact) 10.dp else 28.dp).widthIn(max = 360.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(if (compact) 20.dp else 26.dp), color = K.Accent, strokeWidth = 2.dp,
                )
                Spacer(Modifier.height(if (compact) 9.dp else 14.dp))
            } else {
                Sparkle(if (compact) 22.dp else 30.dp, colour = K.Muted)
                Spacer(Modifier.height(if (compact) 8.dp else 12.dp))
            }
            Text(title, color = K.Text, style = MaterialTheme.typography.bodyMedium)
            body?.let {
                Spacer(Modifier.height(5.dp))
                Text(
                    it, color = K.Muted, style = MaterialTheme.typography.bodySmall,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
            if (actionLabel != null && onAction != null) {
                Spacer(Modifier.height(10.dp))
                OutlinedButton(onClick = onAction, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(actionLabel)
                }
            }
        }
    }

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
                CommandText(it)
            }
        }
    }

    @Composable
    private fun CommandText(command: String) {
        Text(
            command,
            color = K.Accent, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            modifier = Modifier.clip(RoundedCornerShape(6.dp))
                .background(K.Bg.copy(alpha = 0.5f)).padding(8.dp, 5.dp),
        )
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
