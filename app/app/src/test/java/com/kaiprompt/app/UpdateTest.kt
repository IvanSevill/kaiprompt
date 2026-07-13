package com.kaiprompt.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Comparar versiones. Parece trivial y no lo es: "1.10" es MAS nueva que "1.9", y una
 * comparacion de cadenas lo dice al reves — asi que la app te avisaria de una actualizacion
 * que no existe, o peor, se callaria la que si.
 *
 * Y una falsa alarma de actualizacion es peor que ninguna: la primera vez la miras, la
 * segunda la ignoras, y a partir de la tercera ya no te enteras de las de verdad.
 */
class UpdateTest {

    @Test
    fun `una version mayor es mas nueva`() {
        assertTrue(Update.isNewer("1.1.0", "1.0.0"))
        assertTrue(Update.isNewer("2.0.0", "1.9.9"))
        assertTrue(Update.isNewer("1.0.1", "1.0.0"))
    }

    @Test
    fun `1_10 es mas nueva que 1_9 (lo que una comparacion de texto se traga al reves)`() {
        assertTrue(Update.isNewer("1.10.0", "1.9.0"))
        assertFalse(Update.isNewer("1.9.0", "1.10.0"))
    }

    @Test
    fun `la misma version NO es mas nueva`() {
        assertFalse(Update.isNewer("1.0.0", "1.0.0"))
        assertFalse(Update.isNewer("1.0", "1.0.0"), )
    }

    @Test
    fun `una version mas VIEJA no dispara aviso`() {
        assertFalse(Update.isNewer("0.9.0", "1.0.0"))
    }

    @Test
    fun `numero de segmentos distinto se compara bien`() {
        assertTrue(Update.isNewer("1.0.1", "1.0"))
        assertFalse(Update.isNewer("1.0", "1.0.1"))
    }

    @Test
    fun `si no sabemos que version somos, NO se avisa de nada`() {
        // Antes que dar un aviso falso, callarse.
        assertFalse(Update.isNewer("9.9.9", ""))
    }

    @Test
    fun `basura en la version no revienta`() {
        assertFalse(Update.isNewer("abc", "1.0.0"))
        assertFalse(Update.isNewer("1.0.0", "1.0.0-beta"))
    }
}
