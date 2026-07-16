package com.kaiprompt.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray

/**
 * Where the pairing lives on the phone.
 *
 * The token and the key are kept; the URL is expected to change. A Cloudflare quick tunnel
 * gets a new address every time `kaip serve` restarts, so re-pairing is a routine event —
 * and it must not feel like starting over. Scanning again only refreshes the address.
 */
class Store(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("kaiprompt", Context.MODE_PRIVATE)

    var pairing: Pairing?
        get() {
            val token = prefs.getString("token", null) ?: return null
            val key = prefs.getString("key", null) ?: return null
            val url = prefs.getString("url", null) ?: return null
            return runCatching { Pairing(
                url = url,
                lan = prefs.getString("lan", null),
                token = token,
                key = key,
                tunnel = prefs.getBoolean("tunnel", false),
            ).copy(url = normalizeHttpBase(url), lan = prefs.getString("lan", null)?.let(::normalizeHttpBase)) }.getOrNull()
        }

        set(p) {
            val normalized = p?.copy(
                url = normalizeHttpBase(p.url),
                lan = p.lan?.let(::normalizeHttpBase),
            )
            prefs.edit().apply {
                if (normalized == null) {
                    remove("url")
                    remove("lan")
                    remove("token")
                    remove("key")
                    remove("tunnel")
                    remove("host")
                } else {
                    putString("url", normalized.url)
                    putString("lan", normalized.lan)
                    putString("token", normalized.token)
                    putString("key", normalized.key)
                    // No `host`. It was the PC's hostname, the compact QR stopped carrying it,
                    // and what got persisted — and then painted on screen — was the literal
                    // string "?". The PC's name now comes from /api/state, which always has it.
                    remove("host")
                    putBoolean("tunnel", normalized.tunnel)
                }
            }.apply()
        }

    /** Kept separately from pairing credentials so explicit unpairing does not change identity. */
    val deviceId: String
        get() = prefs.getString("device_id", null) ?: DeviceId.new().also {
            prefs.edit().putString("device_id", it).apply()
        }

    /**
     * Which finished jobs the phone has already told you about.
     *
     * Without this the catch-up poll would re-announce everything it finds every time it
     * wakes, and a notification you have already read reappearing is how people turn
     * notifications off.
     */
    var announced: List<String>
        get() {
            val saved = prefs.getString("announced_ordered", null)
            if (saved != null) return runCatching {
                val array = JSONArray(saved)
                (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotBlank) }
            }.getOrDefault(emptyList())
            return prefs.getStringSet("announced", emptySet()).orEmpty().sorted()
        }
        set(v) {
            val ordered = newestNotificationIds(emptyList(), v)
            prefs.edit().putString("announced_ordered", JSONArray(ordered).toString()).remove("announced").apply()
        }

    /** The first poll establishes a baseline; old jobs are history, not new notifications. */
    var notificationBaselineReady: Boolean
        get() = prefs.getBoolean("notification_baseline_ready", false)
        set(v) = prefs.edit().putBoolean("notification_baseline_ready", v).apply()

    /** Version whose welcome screen has already been read. */
    var seenVersion: String?
        get() = prefs.getString("seen_version", null)
        set(v) = prefs.edit().putString("seen_version", v).apply()

    var language: AppLanguage
        get() = AppLanguage.fromPreference(prefs.getString("language", null))
        set(v) = prefs.edit().putString("language", v.preference).apply()

    var showHiddenConversations: Boolean
        get() = prefs.getBoolean("show_hidden_conversations", false)
        set(v) = prefs.edit().putBoolean("show_hidden_conversations", v).apply()

    val paired get() = pairing != null
}
