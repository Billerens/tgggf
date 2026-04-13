package com.tggf.app.localapi

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "LocalApi")
class LocalApiBridgePlugin : Plugin() {
    private val repository = LocalRepository()

    @PluginMethod
    fun health(call: PluginCall) {
        val health = repository.health()
        val payload = JSObject()
        payload.put("ok", health["ok"])
        payload.put("service", health["service"])
        payload.put("storage", health["storage"])
        call.resolve(payload)
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val method = call.getString("method", "GET") ?: "GET"
        val path = call.getString("path", "/") ?: "/"

        val payload = JSObject()
        payload.put("status", 501)
        payload.put("body", "Not implemented: $method $path")
        call.resolve(payload)
    }
}

