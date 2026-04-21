package com.tggf.app.localapi

object DiaryTagSpec {
    @JvmField
    val PREFIXES: List<String> =
        listOf(
            "date",
            "topic",
            "event",
            "person",
            "place",
            "emotion",
            "decision",
            "followup",
        )

    @JvmField
    val PREFIXES_SET: Set<String> = PREFIXES.toSet()

    @JvmField
    val PREFIXES_TEXT: String = PREFIXES.joinToString(", ")
}

