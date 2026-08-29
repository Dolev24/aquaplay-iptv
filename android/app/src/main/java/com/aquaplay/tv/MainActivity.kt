package com.aquaplay.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.WebViewAssetLoader

/**
 * The shell.
 *
 * The app itself is the same web app the Samsung build ships — index.html and
 * its css/ and js/, staged into assets by Gradle so only one copy of it exists.
 * This class gives that page the three things a browser cannot:
 *
 *  1. a decoder of its own, drawing on a surface *behind* the page (PlayerBridge),
 *  2. HTTP with no origin attached to it (shouldInterceptRequest / NetBridge),
 *  3. the remote's keys, most of which Android eats before the page sees them.
 *
 * The arrangement mirrors Tizen deliberately. There, AVPlay drives a hardware
 * plane behind the widget and the page is transparent over it; here, ExoPlayer
 * draws on a SurfaceView with a transparent WebView on top. The app already
 * knows how to work out where the picture goes and hand over a rectangle —
 * that is the part of player.js which has survived being wrong twice — so the
 * cheapest correct thing to do was give it the same shape again.
 */
/* A plain Activity, not AppCompatActivity: nothing here uses AppCompat, and
   AppCompatActivity throws at startup unless the theme descends from
   Theme.AppCompat — which this one deliberately does not, because a TV app
   wants Material's fullscreen theme and no action bar. */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var surface: SurfaceView
    private lateinit var player: PlayerBridge
    private lateinit var net: NetBridge

    /** Where the page lives: a real https origin rather than file://, so that
     *  localStorage persists and the app is not a special case of itself.
     *  Nothing is fetched over the network to serve it. */
    private lateinit var assetLoader: WebViewAssetLoader

    private val debuggable: Boolean
        get() = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()

        val root = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(MATCH, MATCH)
            setBackgroundColor(Color.BLACK)
        }

        /* Added first, so it is underneath. Its size is nobody's business but
           the player's: the page says where the picture goes, in the page's own
           coordinates, and PlayerBridge does the moving. */
        surface = SurfaceView(this).apply {
            layoutParams = FrameLayout.LayoutParams(MATCH, MATCH)
        }
        root.addView(surface)

        web = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(MATCH, MATCH)
            /* Transparent, or there is no point in the surface being there. */
            setBackgroundColor(Color.TRANSPARENT)
            isFocusable = true
            isFocusableInTouchMode = true
        }
        root.addView(web)
        setContentView(root)

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        net = NetBridge()
        player = PlayerBridge(this, surface) { kind, detail -> emit(kind, detail) }

        configure(web.settings)
        web.webViewClient = client()
        web.webChromeClient = chrome()
        web.addJavascriptInterface(player, "AquaPlayNative")

        if (debuggable) WebView.setWebContentsDebuggingEnabled(true)

        web.loadUrl("https://$APP_DOMAIN/assets/www/index.html")
    }

    private fun configure(s: WebSettings) {
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.loadWithOverviewMode = false
        s.useWideViewPort = false
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.setSupportZoom(false)
        s.mediaPlaybackRequiresUserGesture = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        /* The page is https and most providers are not. Everything external is
           answered by NetBridge anyway, but a request would otherwise be
           blocked before it ever got that far. */
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.allowFileAccess = false
        s.allowContentAccess = false
    }

    private fun client() = object : WebViewClient() {

        /* Two kinds of request arrive here.
         *
         * The app's own files come from the asset loader, which is what gives
         * them their https origin in the first place.
         *
         * Everything else is a provider: a playlist, an XMLTV guide, a channel
         * logo. Those are fetched here rather than by the WebView because a
         * page has an origin and a provider has never heard of CORS — the
         * request would go out and the answer be thrown away unread. Answering
         * it ourselves means the response can say what it needs to about
         * origins, which is the same trick config.xml's <access origin="*">
         * plays for the Tizen build.
         *
         * Called on a background thread, and on more than one at a time. */
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? {
            val url = request.url
            if (url.host == APP_DOMAIN) return assetLoader.shouldInterceptRequest(url)

            val scheme = url.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            if (!request.method.equals("GET", ignoreCase = true)) return null

            return net.fetch(url.toString(), request.requestHeaders)
        }

        override fun onPageFinished(view: WebView, url: String) = goImmersive()
    }

    private fun chrome() = object : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
            Log.d(TAG, "${m.sourceId()}:${m.lineNumber()} ${m.message()}")
            return true
        }
    }

    /* ---------------------------------------------------------------------
       Keys
       --------------------------------------------------------------------- */

    /**
     * The remote, as far as the page is concerned.
     *
     * The D-pad, Enter and the number keys reach the WebView as ordinary DOM
     * keydowns and are left alone entirely — keys.js already knows what to do
     * with an arrow, and routing them through here would mean reimplementing
     * "is a text field focused" in Kotlin.
     *
     * The rest never arrive: Android takes BACK for its own navigation and
     * hands the media and colour keys to whatever holds a media session, so
     * the page would wait for them forever. Those are translated into the same
     * action vocabulary keys.js uses and injected at the same door everything
     * else comes through.
     *
     * Key-up for anything in the table is swallowed too. Letting it through
     * after the key-down has been consumed is how a remote ends up doing a
     * thing twice, or doing Android's thing as well as the app's.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val action = ACTIONS[event.keyCode] ?: return super.dispatchKeyEvent(event)
        if (event.action != KeyEvent.ACTION_DOWN) return true
        send("window.AquaPlayShell&&AquaPlayShell.key(${quote(action)},0)")
        return true
    }

    /* ---------------------------------------------------------------------
       Talking to the page
       --------------------------------------------------------------------- */

    /** Player events, named the way AVPlay names them so both TV paths report
     *  the same things and player.js cannot tell them apart. */
    private fun emit(kind: String, detail: String) {
        send("window.AquaPlayShell&&AquaPlayShell.player(${quote(kind)},${quote(detail)})")
    }

    private fun send(js: String) {
        runOnUiThread {
            try {
                web.evaluateJavascript(js, null)
            } catch (t: Throwable) {
                Log.w(TAG, "page not listening: ${t.message}")
            }
        }
    }

    fun exitApp() = runOnUiThread { finish() }

    /* ---------------------------------------------------------------------
       Housekeeping
       --------------------------------------------------------------------- */

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    override fun onStop() {
        super.onStop()
        /* A TV app that keeps decoding after the viewer has gone back to the
           home screen is a TV app that gets killed for it. */
        player.pauseForBackground()
    }

    override fun onDestroy() {
        player.release()
        web.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun goImmersive() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    companion object {
        const val TAG = "AquaPlay"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT

        /** The reserved name androidx gives to app assets. It resolves to
         *  nothing on the network, which is the point of it. */
        const val APP_DOMAIN = "appassets.androidplatform.net"

        /** Android keycode -> the action vocabulary in keys.js.
         *
         *  Only the keys the WebView never sees. Arrows, Enter and digits are
         *  absent on purpose: they arrive in the page by themselves, and the
         *  page is the only thing that knows whether a text field wants them. */
        val ACTIONS: Map<Int, String> = mapOf(
            KeyEvent.KEYCODE_BACK to "back",

            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "playPause",
            KeyEvent.KEYCODE_MEDIA_PLAY to "play",
            KeyEvent.KEYCODE_MEDIA_PAUSE to "pause",
            KeyEvent.KEYCODE_MEDIA_STOP to "stop",
            KeyEvent.KEYCODE_MEDIA_REWIND to "rew",
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to "ff",

            /* Skip is the nearest thing many remotes have to channel +/-. */
            KeyEvent.KEYCODE_MEDIA_NEXT to "chanUp",
            KeyEvent.KEYCODE_MEDIA_PREVIOUS to "chanDown",
            KeyEvent.KEYCODE_CHANNEL_UP to "chanUp",
            KeyEvent.KEYCODE_CHANNEL_DOWN to "chanDown",
            KeyEvent.KEYCODE_PAGE_UP to "chanUp",
            KeyEvent.KEYCODE_PAGE_DOWN to "chanDown",

            KeyEvent.KEYCODE_PROG_RED to "red",
            KeyEvent.KEYCODE_PROG_GREEN to "green",
            KeyEvent.KEYCODE_PROG_YELLOW to "yellow",
            KeyEvent.KEYCODE_PROG_BLUE to "blue",

            KeyEvent.KEYCODE_INFO to "info",
            KeyEvent.KEYCODE_GUIDE to "guide",
            KeyEvent.KEYCODE_TV to "guide"
        )

        /**
         * A JavaScript string literal.
         *
         * The value is going into a line of JavaScript, and provider error
         * text ends up in here — a stream URL in a message, a server's idea of
         * an error page. U+2028 and U+2029 are escaped along with the obvious
         * ones because they end a line in JavaScript and in nothing else,
         * which is exactly the kind of bug nobody finds by reading. They are
         * compared by code point because as literals they would be invisible
         * here too.
         */
        fun quote(s: String): String {
            val out = StringBuilder("\"")
            for (c in s) {
                when {
                    c == '\\' -> out.append("\\\\")
                    c == '"' -> out.append("\\\"")
                    c == '\n' -> out.append("\\n")
                    c == '\r' -> out.append("\\r")
                    c == '\t' -> out.append("\\t")
                    c < ' ' || c.code == 0x2028 || c.code == 0x2029 ->
                        out.append(String.format("\\u%04x", c.code))
                    else -> out.append(c)
                }
            }
            return out.append('"').toString()
        }
    }
}
