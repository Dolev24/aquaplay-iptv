package com.aquaplay.tv

import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Provider HTTP, answered by the app rather than by the WebView.
 *
 * A page has an origin; a provider has never heard of CORS. Left to itself the
 * WebView would send the request, get a perfectly good playlist back, and throw
 * it away unread because the response did not say who was allowed to look at
 * it. Fetching it here means the response we hand back can say so — the same
 * thing config.xml's `<access origin="*">` does for the Tizen build, and the
 * reason net.js switches its dev proxy off on both.
 *
 * Everything external comes through here, logos included. That is a little
 * more than strictly needs to, and it buys one place to put the timeouts, the
 * user agent and the redirect policy — all three of which providers have
 * opinions about.
 *
 * Called on a background thread, several at a time, so there is no shared
 * mutable state in here at all.
 */
class NetBridge {

    fun fetch(url: String, headers: Map<String, String>?): WebResourceResponse? {
        return try {
            get(url, headers, 0)
        } catch (t: Throwable) {
            Log.w(MainActivity.TAG, "fetch failed: $url — ${t.message}")
            error(t.message ?: "request failed")
        }
    }

    private fun get(url: String, headers: Map<String, String>?, depth: Int): WebResourceResponse? {
        if (depth > MAX_REDIRECTS) return error("too many redirects")

        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 20_000
            readTimeout = 45_000
            /* Handled below instead. HttpURLConnection will not follow a
               redirect that changes protocol, and http -> https is exactly
               what a provider's catch-up URL tends to do. */
            instanceFollowRedirects = false
            setRequestProperty("User-Agent", PlayerBridge.USER_AGENT)

            /* Identity on purpose. A WebResourceResponse body is handed to the
               WebView as-is: it does not apply Content-Encoding, so a gzipped
               stream forwarded with the header intact would arrive as noise.
               Guides that are actually .gz files are a different thing and the
               app inflates those itself. */
            setRequestProperty("Accept-Encoding", "identity")

            headers?.forEach { (k, v) ->
                if (k.lowercase() in PASS_THROUGH) setRequestProperty(k, v)
            }
        }

        val code = conn.responseCode

        if (code in 300..399) {
            val to = conn.getHeaderField("Location")
            conn.disconnect()
            if (to.isNullOrBlank()) return error("redirect with nowhere to go")
            return get(URL(URL(url), to).toString(), headers, depth + 1)
        }

        val body = if (code >= 400) conn.errorStream else conn.inputStream

        val contentType = conn.contentType ?: "application/octet-stream"
        val mime = contentType.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
        val charset = contentType.substringAfter("charset=", "").substringBefore(';')
            .trim().ifEmpty { null }

        val out = HashMap<String, String>()
        /* The whole point of the exercise. */
        out["Access-Control-Allow-Origin"] = "*"
        out["Access-Control-Allow-Headers"] = "*"
        out["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
        /* Kept so XHR progress has a total to count towards — the setup screen
           shows a real percentage while a playlist downloads, and without this
           it counts up from nothing towards nothing. */
        conn.getHeaderField("Content-Length")?.let { out["Content-Length"] = it }
        conn.getHeaderField("Accept-Ranges")?.let { out["Accept-Ranges"] = it }
        conn.getHeaderField("Content-Range")?.let { out["Content-Range"] = it }

        return WebResourceResponse(
            mime,
            charset,
            code,
            reason(code),
            out,
            body ?: ByteArrayInputStream(ByteArray(0))
        )
    }

    /** A failure the page can see. Returning null instead would let the
     *  WebView try the request itself, which is the CORS wall this class
     *  exists to get around — the XHR would fail with a status of 0 and the
     *  app would report "network error" for a server that answered. */
    private fun error(why: String): WebResourceResponse {
        val out = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Headers" to "*"
        )
        return WebResourceResponse(
            "text/plain", "utf-8", 502, "Bad Gateway", out,
            ByteArrayInputStream(why.toByteArray())
        )
    }

    /** WebResourceResponse rejects a blank reason phrase, and some servers
     *  send one. */
    private fun reason(code: Int): String = when (code) {
        200 -> "OK"
        204 -> "No Content"
        206 -> "Partial Content"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        500 -> "Internal Server Error"
        502 -> "Bad Gateway"
        503 -> "Service Unavailable"
        else -> "Status $code"
    }

    companion object {
        private const val MAX_REDIRECTS = 5

        /** What is worth carrying from the page's request. Origin and Referer
         *  deliberately are not: they are the thing being got around, and some
         *  providers reject a Referer they do not recognise. */
        private val PASS_THROUGH = setOf("range", "if-none-match", "if-modified-since")
    }
}
