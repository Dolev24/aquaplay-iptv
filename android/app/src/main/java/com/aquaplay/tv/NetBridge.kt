package com.aquaplay.tv

import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.SequenceInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

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
 * Called on a background thread, several at a time. The one piece of shared
 * state is the image cache below, and everything that touches it is
 * synchronized.
 *
 * @param cacheDir where cached images live between runs; null disables the
 *   disk half and keeps the memory half.
 */
class NetBridge(private val cacheDir: File? = null) {

    /* ---- the image cache ----------------------------------------------
       Every logo in a playlist comes through this class, and a body handed
       back from shouldInterceptRequest never reaches the WebView's own HTTP
       cache — so each one was fetched again from the provider every time its
       row scrolled back into view. Measured on a real playlist: 576ms each,
       thirty in a row, which is exactly why a fast scroll left a column of
       blanks that filled in seconds later.

       Images only, and small ones. A playlist or a guide has no business in
       here: those are megabytes, read once, and already cached by the app
       itself. Memory answers the scrolling; disk answers the relaunch. */
    private class Entry(val mime: String, val bytes: ByteArray)

    /** Access-ordered, so eviction takes the least recently *used*. */
    private val mem = LinkedHashMap<String, Entry>(64, 0.75f, true)
    private var memBytes = 0L

    private fun cached(url: String): Entry? {
        synchronized(mem) { mem[url]?.let { return it } }
        val f = diskFile(url) ?: return null
        return try {
            if (!f.isFile) return null
            val raw = f.readBytes()
            /* One file per image: the mime type on the first line, the bytes
               after it. A second file per logo to hold one short string
               would double the inodes for nothing. */
            val nl = raw.indexOf('\n'.code.toByte())
            if (nl <= 0) return null
            val e = Entry(String(raw, 0, nl, Charsets.US_ASCII),
                          raw.copyOfRange(nl + 1, raw.size))
            remember(url, e, toDisk = false)
            e
        } catch (t: Throwable) {
            null
        }
    }

    private fun remember(url: String, e: Entry, toDisk: Boolean) {
        synchronized(mem) {
            val old = mem.put(url, e)
            memBytes += e.bytes.size - (old?.bytes?.size ?: 0)
            val it = mem.entries.iterator()
            while (memBytes > MEM_MAX && it.hasNext()) {
                val n = it.next()
                memBytes -= n.value.bytes.size
                it.remove()
            }
        }
        if (!toDisk) return
        val f = diskFile(url) ?: return
        try {
            f.parentFile?.mkdirs()
            /* Written aside and renamed: a half-written logo that survived a
               kill would be served as a broken one for ever after. */
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.outputStream().use { o ->
                o.write((e.mime + "\n").toByteArray(Charsets.US_ASCII))
                o.write(e.bytes)
            }
            if (!tmp.renameTo(f)) tmp.delete()
        } catch (t: Throwable) {
            /* A cache that cannot write is still a cache. */
        }
    }

    private fun diskFile(url: String): File? {
        val dir = cacheDir ?: return null
        return try {
            val h = MessageDigest.getInstance("SHA-1").digest(url.toByteArray())
            File(File(dir, "img"), h.joinToString("") { "%02x".format(it) })
        } catch (t: Throwable) {
            null
        }
    }

    private fun respond(e: Entry): WebResourceResponse {
        val out = HashMap<String, String>()
        out["Access-Control-Allow-Origin"] = "*"
        out["Access-Control-Allow-Headers"] = "*"
        /* So the WebView keeps it in its own memory cache for the page's
           lifetime as well, and does not come back through here at all. */
        out["Cache-Control"] = "public, max-age=604800"
        out["Content-Length"] = e.bytes.size.toString()
        return WebResourceResponse(e.mime, null, 200, "OK", out,
                                   ByteArrayInputStream(e.bytes))
    }

    fun fetch(url: String, headers: Map<String, String>?): WebResourceResponse? {
        cached(url)?.let { return respond(it) }
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

        var body = if (code >= 400) conn.errorStream else conn.inputStream

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

        /* Small images are read whole and kept. Everything else streams
           straight through as it always did — a 200MB guide must not be
           gathered into a byte array on its way past. */
        if (code == 200 && mime.startsWith("image/") && body != null) {
            val head = ByteArray(IMG_MAX + 1)
            var n = 0
            while (n < head.size) {
                val r = try { body.read(head, n, head.size - n) } catch (t: Throwable) { -1 }
                if (r < 0) break
                n += r
            }
            if (n <= IMG_MAX) {
                val e = Entry(mime, head.copyOf(n))
                remember(url, e, toDisk = true)
                return respond(e)
            }
            /* Too big to keep: hand back what was read, then the rest. */
            body = SequenceInputStream(ByteArrayInputStream(head, 0, n), body)
        }

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
        /** Big enough for any logo; small enough that nothing else qualifies. */
        const val IMG_MAX = 512 * 1024

        /** A playlist of 127 logos is a couple of megabytes. This holds
         *  several playlists' worth and still costs less than one guide. */
        const val MEM_MAX = 24L * 1024 * 1024

        private const val MAX_REDIRECTS = 5

        /** What is worth carrying from the page's request. Origin and Referer
         *  deliberately are not: they are the thing being got around, and some
         *  providers reject a Referer they do not recognise. */
        private val PASS_THROUGH = setOf("range", "if-none-match", "if-modified-since")
    }
}
