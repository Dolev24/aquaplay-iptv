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
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature

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

    /** Whether the on-screen keyboard is up, so its closing can be noticed. */
    private var imeUp = false
    private var imeHeight = 0
    private var imeUpSent = false
    private lateinit var root: FrameLayout

    private val debuggable: Boolean
        get() = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()

        root = FrameLayout(this).apply {
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

        /* The keyboard owns the remote while it is up, so the page cannot see
           it close and would sit in its editing state for ever — every press
           after that going to a keyboard that is no longer there. Watching the
           IME's own insets is the only way to find out. */
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val up = insets.isVisible(WindowInsetsCompat.Type.ime())
            if (imeUp && !up) {
                Log.i(TAG, "keyboard closed")
                send("window.AquaPlayShell&&AquaPlayShell.imeClosed&&AquaPlayShell.imeClosed()")
            }
            imeUp = up

            /* And how tall it is. The window is adjustNothing — deliberately,
               because a resize would change the stage scale and the whole
               point of that scale is that it does not move — so the keyboard
               is painted straight over the page and the page has no way to
               know. Told the height, it can raise itself out from under. */
            val h = if (up) insets.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
            if (h != imeHeight) {
                imeHeight = h
                /* Measured in one place, below. */
                reportIme()
            }
            insets
        }

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        net = NetBridge(cacheDir)
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
        /* The page declares <meta viewport width=1920> and every coordinate
           in it is a pixel of that 1920. These two make the WebView honour
           that: a 1920-wide layout viewport, scaled once to fit the panel.

           With them off, the WebView laid the page out 1920 CSS pixels wide
           and still reported a device pixel ratio of 2 — 3840 device pixels
           of page on a 1920 pixel screen, so a quarter of the app filled the
           television and the rest was off the edge. */
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
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

        /* No algorithmic darkening. The page is already dark when it means to
           be and light when the viewer asks for that, and a WebView that
           decides to help produces colours the Samsung build does not — which
           is exactly the sort of difference nobody can explain from a sofa.
           Measured on the emulator the colours already match; this is so they
           still match on hardware whose WebView defaults differ. */
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false)
        } else if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            @Suppress("DEPRECATION")
            WebSettingsCompat.setForceDark(s, WebSettingsCompat.FORCE_DARK_OFF)
        }
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

        override fun onPageFinished(view: WebView, url: String) {
            goImmersive()
            /* One line that settles "what does the page think the screen is",
               which is the question behind every report of the app being the
               wrong size. */
            view.evaluateJavascript(
                "JSON.stringify({vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio," +
                    "platform:(window.U&&U.platform)||'?',bridge:!!window.AquaPlayNative})"
            ) { r -> Log.i(TAG, "page viewport: $r") }
            val dm = resources.displayMetrics
            Log.i(TAG, "screen: ${dm.widthPixels}x${dm.heightPixels} density ${dm.density}")
        }
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

    /**
     * Show or hide the on-screen keyboard, because the page asked.
     *
     * The WebView will open one by itself when an input takes focus and then
     * leave it up, at which point it owns the D-pad and the page's own cursor
     * has stopped meaning anything. Saying so explicitly is the only way the
     * two agree about which of them the remote is talking to.
     */
    fun setEditing(on: Boolean) = runOnUiThread {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager ?: return@runOnUiThread
        if (on) {
            /* No requestFocus() here. The WebView already has window focus —
               the page is what put the cursor in the field — and asking for it
               again resets the DOM focus to whatever the WebView considers its
               first focusable node. Measured: activeElement went from the input
               to #video-layer, so every keystroke afterwards went nowhere and
               the field stayed empty. */
            imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT)
        } else {
            imm.hideSoftInputFromWindow(web.windowToken, 0)
        }
        Log.i(TAG, "editing " + (if (on) "on" else "off"))
        watchIme()
    }

    /* ---------------------------------------------------------------------
       The keyboard, and how much of the screen it is standing on

       The window is declared adjustNothing — deliberately, because a resize
       would change the page's stage scale and the whole point of that scale
       is that it never moves. The cost is that nothing is dispatched when
       the keyboard opens: the insets listener is never called for it, which
       is what adjustNothing means and what the logcat showed.

       The insets are still there to be read. So read them when the page says
       it has started editing, several times, because the keyboard animates
       in and the first look catches it at nothing.

       The window height goes across with the height. The page cannot convert
       these pixels into its own — devicePixelRatio does not do it, it reads
       2 on a set whose CSS viewport is 1:1 with its screen — but a fraction
       of the window is the same number in anybody's pixels.
       --------------------------------------------------------------------- */

    private fun reportIme() {
        if (!::root.isInitialized) return
        val ins = ViewCompat.getRootWindowInsets(root) ?: return
        val up = ins.isVisible(WindowInsetsCompat.Type.ime())
        /* Zero on a television, every time — see the note above. Sent
           anyway, because a platform that does report it should be
           believed over a rule of thumb. */
        val h = if (up) ins.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
        if (up == imeUpSent && h == imeHeight) return
        imeUpSent = up
        imeHeight = h
        val win = root.height
        Log.i(TAG, "keyboard up=$up ${h}px of ${win}px")
        send("window.AquaPlayShell&&AquaPlayShell.ime&&" +
             "AquaPlayShell.ime(${if (up) 1 else 0},$h,$win)")
    }

    private fun watchIme() {
        if (!::root.isInitialized) return
        for (d in longArrayOf(120L, 300L, 550L, 900L, 1400L)) {
            root.postDelayed({ reportIme() }, d)
        }
    }

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
    /* Immersive through the controller rather than through
       systemUiVisibility, and the window fitting its own insets rather than
       the decor fitting them for it.

       Same picture, but SYSTEM_UI_FLAG_FULLSCREEN is gone, and that flag was
       quietly the whole keyboard problem: a window carrying it is never
       resized for the IME — documented — and, laid out by the decor, is
       never dispatched the IME insets either. Two ways of finding out where
       the keyboard is, both switched off by one line, which is why the
       insets listener sat silent through a keyboard the screenshot showed
       covering half the page. */
    private fun goImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val bars = WindowInsetsControllerCompat(window, window.decorView)
        bars.hide(WindowInsetsCompat.Type.systemBars())
        bars.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
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
