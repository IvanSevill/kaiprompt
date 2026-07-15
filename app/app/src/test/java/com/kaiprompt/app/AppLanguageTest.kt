package com.kaiprompt.app

import org.junit.Assert.assertEquals
import org.junit.Test

class AppLanguageTest {
    @Test
    fun `stored language values map to their supported language`() {
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromPreference("system"))
        assertEquals(AppLanguage.SPANISH, AppLanguage.fromPreference("es"))
        assertEquals(AppLanguage.ENGLISH, AppLanguage.fromPreference("en"))
    }

    @Test
    fun `unknown stored language falls back to system`() {
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromPreference("fr"))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromPreference(null))
    }
}
