package com.kaiprompt.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * "Am I running the latest build?"
 *
 * The APK is sideloaded, so nothing updates it: no Play Store, no nagging, no mechanism at
 * all. Which means an old app can sit on the phone for weeks, quietly missing whatever was
 * fixed — and the person holding it has no way to know. That is the same class of silent
 * lie the rest of this tool works hard to avoid.
 *
 * So it asks GitHub, which is where the release lives anyway. No server of our own, and the
 * check costs one request against a public endpoint.
 *
 * Deliberately just a NOTICE, not an auto-update: silently replacing the app someone is
 * looking at is rude, and doing it over a metered connection is worse. It offers the
 * download and gets out of the way.
 */
object Update {

    private const val LATEST =
        "https://api.github.com/repos/IvanSevill/kaiprompt/releases/latest"

    data class Available(val version: String, val notes: String?, val downloadUrl: String)

    /**
     * The newer release, if there is one. Null when up to date — and null when the check
     * fails, because "we could not reach GitHub" must never be shown as "you are out of
     * date". A false alarm about an update is worse than no alarm.
     */
    fun check(context: Context): Available? = runCatching {
        val c = (URL(LATEST).openConnection() as HttpURLConnection).apply {
            connectTimeout = 6000
            readTimeout = 6000
            setRequestProperty("accept", "application/vnd.github+json")
        }
        if (c.responseCode != 200) return null

        val body = c.inputStream.bufferedReader().use { it.readText() }
        c.disconnect()

        val json = JSONObject(body)
        val tag = json.optString("tag_name").removePrefix("v").trim()
        if (tag.isBlank()) return null

        val mine = context.packageManager
            .getPackageInfo(context.packageName, 0).versionName
            ?.trim()
            .orEmpty()

        val assets = json.optJSONArray("assets") ?: return null
        val asset = (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }
            .firstOrNull { it.optString("name") == "app-release.apk" }
            ?: (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }.firstOrNull()
            ?: return null
        val downloadUrl = asset.optStringOrNull("browser_download_url") ?: return null

        if (isNewer(tag, mine)) Available(tag, json.optStringOrNull("body"), downloadUrl) else null
    }.getOrNull()

    /**
     * Is `remote` newer than `local`? Compared segment by segment as numbers — "1.10" is
     * newer than "1.9", which a string comparison gets backwards.
     */
    fun isNewer(remote: String, local: String): Boolean {
        if (local.isBlank()) return false            // we do not know what we are: do not nag

        val a = remote.split('.').map { it.toIntOrNull() ?: 0 }
        val b = local.split('.').map { it.toIntOrNull() ?: 0 }

        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** Hand it to the browser. Android takes it from there, permissions and all. */
    fun download(context: Context, url: String) {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
