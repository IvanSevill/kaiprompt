package com.kaiprompt.app

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import java.util.Locale

enum class AppLanguage(val preference: String, private val tag: String?) {
    SYSTEM("system", null),
    SPANISH("es", "es"),
    ENGLISH("en", "en"),
    ;

    companion object {
        fun fromPreference(value: String?) = entries.firstOrNull { it.preference == value } ?: SYSTEM
    }

    fun localizedContext(context: Context): Context {
        val languageTag = tag ?: return context
        val locale = Locale.forLanguageTag(languageTag)
        val configuration = Configuration(context.resources.configuration).apply {
            setLocale(locale)
            setLocales(LocaleList(locale))
        }
        return context.createConfigurationContext(configuration)
    }
}
