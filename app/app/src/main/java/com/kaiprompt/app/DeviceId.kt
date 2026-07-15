package com.kaiprompt.app

import java.util.UUID

/** A stable installation identity; unlike the phone name, it never changes with device settings. */
object DeviceId {
    fun new(): String = UUID.randomUUID().toString()
}
