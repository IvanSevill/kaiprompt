package com.kaiprompt.app

import android.content.Context
import android.content.SharedPreferences

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
            return Pairing(
                url = url,
                lan = prefs.getString("lan", null),
                token = token,
                key = key,
                tunnel = prefs.getBoolean("tunnel", false),
            )
        }
        set(p) {
            prefs.edit().apply {
                if (p == null) {
                    val language = prefs.getString("language", null)
                    clear()
                    putString("language", language)
                } else {
                    putString("url", p.url)
                    putString("lan", p.lan)
                    putString("token", p.token)
                    putString("key", p.key)
                    // No `host`. It was the PC's hostname, the compact QR stopped carrying it,
                    // and what got persisted — and then painted on screen — was the literal
                    // string "?". The PC's name now comes from /api/state, which always has it.
                    remove("host")
                    putBoolean("tunnel", p.tunnel)
                }
            }.apply()
        }

    /**
     * Which finished jobs the phone has already told you about.
     *
     * Without this the catch-up poll would re-announce everything it finds every time it
     * wakes, and a notification you have already read reappearing is how people turn
     * notifications off.
     */
    var announced: Set<String>
        get() = prefs.getStringSet("announced", emptySet()) ?: emptySet()
        set(v) = prefs.edit().putStringSet("announced", v.take(200).toSet()).apply()

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

    val paired get() = pairing != null
}
