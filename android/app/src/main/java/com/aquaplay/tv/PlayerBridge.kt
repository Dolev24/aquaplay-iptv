package com.aquaplay.tv

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.SurfaceView
import android.webkit.JavascriptInterface
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector

/**
 * The decoder, and the JavaScript object the page drives it through.
 *
 * `window.AquaPlayNative` in player.js is this class. The method names are the
 * ones the Tizen path already had in a different spelling, because both TV
 * paths answer the same questions: what is playing, where has it got to, how
 * big is it, where should it be drawn.
 *
 * Two rules run through all of it.
 *
 * **Threads.** Every method here is called by the WebView on a binder thread,
 * and ExoPlayer may only be touched on the thread that built it. Commands are
 * posted to the main thread; questions are answered from a snapshot that the
 * main thread keeps up to date. A getter that blocked on the main thread would
 * deadlock the page the first time the main thread was busy opening a stream.
 *
 * **The rectangle.** The page decides where the picture goes, down to the
 * letterboxing, and hands over four numbers in window pixels. This class moves
 * the surface there and nothing else — no scaling mode, no gravity, no aspect
 * fitting. Everything that ever went wrong with the picture on Tizen went
 * wrong because two things were both trying to shape it.
 */
@UnstableApi
class PlayerBridge(
    private val activity: Activity,
    private val surface: SurfaceView,
    private val emit: (kind: String, detail: String) -> Unit
) {

    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null

    /** What the current player was built with. ExoPlayer takes its buffering
     *  policy at construction, so changing it means building another one. */
    private var builtForPlay = 2_000
    private var builtForResume = 4_000
    private var wantForPlay = 2_000
    private var wantForResume = 4_000

    /* ---- the snapshot the getters read -------------------------------- */

    @Volatile private var snapState = "idle"
    @Volatile private var snapPlaying = false
    @Volatile private var snapPositionMs = 0L
    @Volatile private var snapDurationMs = 0L
    @Volatile private var snapVideoSize = ""
    @Volatile private var snapError = ""
    @Volatile private var snapRect = "-"
    @Volatile private var snapScreen = "-"

    /** Position and the time event, on the main thread, while something is on.
     *  Half a second: the info bar counts in seconds and the drift watch wants
     *  to notice a stall before a viewer does. */
    private val ticker = object : Runnable {
        override fun run() {
            val p = player ?: return
            snapPositionMs = p.currentPosition.coerceAtLeast(0L)
            snapDurationMs = if (p.duration == C.TIME_UNSET) 0L else p.duration.coerceAtLeast(0L)
            if (snapPlaying) emit("time", snapPositionMs.toString())
            main.postDelayed(this, 500)
        }
    }

    /* =====================================================================
       Called from JavaScript
       ===================================================================== */

    /** Proof of life. util.js decides it is on Android by this being here, so
     *  it is the one method that must never be renamed. */
    @JavascriptInterface
    fun shellVersion(): String = "1"

    @JavascriptInterface
    fun play(url: String, mode: String) {
        main.post {
            /* The mode is the page's, not this class's — where the picture
               goes arrives separately, through setRect. It is logged because
               a line saying which channel was opened, and whether it was
               opened into the preview or into the whole screen, is the first
               thing anybody wants out of logcat on a real box. */
            Log.i(MainActivity.TAG, "play [$mode] $url")
            val p = ensurePlayer()
            snapError = ""
            snapVideoSize = ""
            setState("buffering")
            try {
                p.setMediaItem(MediaItem.fromUri(url))
                p.prepare()
                p.playWhenReady = true
                main.removeCallbacks(ticker)
                main.post(ticker)
            } catch (t: Throwable) {
                fail("Could not open this stream", t)
            }
        }
    }

    @JavascriptInterface
    fun stop() {
        main.post {
            main.removeCallbacks(ticker)
            player?.let {
                it.stop()
                it.clearMediaItems()
            }
            snapPlaying = false
            snapPositionMs = 0L
            snapDurationMs = 0L
            setState("idle")
        }
    }

    @JavascriptInterface
    fun seekTo(ms: Long) {
        main.post { player?.seekTo(ms.coerceAtLeast(0L)) }
    }

    /**
     * Where the picture goes, in the window's own pixels.
     *
     * The page has already worked out the letterboxing from the source's shape
     * and the viewer's picture-size setting, so the surface is simply moved and
     * resized to exactly this and the video is stretched to fill it. That is
     * only correct because the rectangle already has the right shape — which is
     * the whole reason the app computes it rather than asking the platform to.
     */
    @JavascriptInterface
    fun setRect(x: Int, y: Int, w: Int, h: Int) {
        if (w <= 0 || h <= 0) return
        main.post {
            val lp = FrameLayout.LayoutParams(w, h)
            lp.leftMargin = x
            lp.topMargin = y
            surface.layoutParams = lp
            surface.requestLayout()
            /* What was asked for, and what the screen is. A picture in the
               top-left quarter is what these two disagreeing looks like, and
               it took somebody with a television to notice — so it is written
               down now rather than inferred. */
            val dm = activity.resources.displayMetrics
            snapRect = "${x},${y} ${w}x${h}"
            snapScreen = "${dm.widthPixels}x${dm.heightPixels} @${dm.density}"
            Log.i(MainActivity.TAG, "setRect $snapRect  screen $snapScreen")
        }
    }

    /** Where the picture was last told to go, and how big the screen is, as
     *  one string for the diagnostics row to print. */
    @JavascriptInterface
    fun surfaceRect(): String = "$snapRect  of $snapScreen"

    /**
     * How long to hold before starting, and before resuming after a stall.
     *
     * The first number is what a channel costs to open and the second is what
     * it costs to recover, and only the second wants to be generous — the same
     * trade the Tizen path makes with setBufferingParam. ExoPlayer takes this
     * at construction, so a change that matters is applied by building another
     * player at the next play() rather than now.
     */
    @JavascriptInterface
    fun setBuffer(forPlayMs: Int, forResumeMs: Int) {
        wantForPlay = forPlayMs.coerceIn(500, 30_000)
        wantForResume = forResumeMs.coerceIn(500, 60_000)
    }

    @JavascriptInterface
    fun isPlaying(): Boolean = snapPlaying

    @JavascriptInterface
    fun positionMs(): Long = snapPositionMs

    /** Zero for anything live. player.js turns "has a duration" into "can be
     *  sought", and a live stream that claimed one would offer a scrub bar
     *  over a window that keeps moving. */
    @JavascriptInterface
    fun durationMs(): Long = snapDurationMs

    /** "1920x1080", or empty until the decoder knows. */
    @JavascriptInterface
    fun videoSize(): String = snapVideoSize

    @JavascriptInterface
    fun state(): String = snapState

    @JavascriptInterface
    fun lastError(): String = snapError

    @JavascriptInterface
    fun exitApp() {
        (activity as? MainActivity)?.exitApp()
    }

    /* =====================================================================
       Called from the shell
       ===================================================================== */

    fun pauseForBackground() = main.post {
        player?.playWhenReady = false
        main.removeCallbacks(ticker)
    }

    fun release() = main.post {
        main.removeCallbacks(ticker)
        player?.release()
        player = null
    }

    /* =====================================================================
       Internals — main thread only
       ===================================================================== */

    private fun ensurePlayer(): ExoPlayer {
        val existing = player
        if (existing != null && wantForPlay == builtForPlay && wantForResume == builtForResume) {
            return existing
        }
        existing?.release()

        builtForPlay = wantForPlay
        builtForResume = wantForResume

        val load = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs = */ (builtForResume * 2).coerceAtLeast(15_000),
                /* maxBufferMs = */ 50_000,
                /* bufferForPlaybackMs = */ builtForPlay,
                /* bufferForPlaybackAfterRebufferMs = */ builtForResume
            )
            .build()

        /* Providers are frequently particular about who is asking, and a
           default Android UA gets a 403 from some of them where a set-top box
           string does not. Redirects are followed because catch-up URLs are
           very often a redirect to a signed one. */
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(USER_AGENT)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(25_000)
            .setAllowCrossProtocolRedirects(true)

        val tracks = DefaultTrackSelector(activity).apply {
            /* Start on the lowest rendition and let it climb: a channel that
               is soft for two seconds beats a channel that takes five to
               appear. The same choice as ADAPTIVE_INFO=STARTBITRATE=LOWEST. */
            parameters = buildUponParameters().setForceLowestBitrate(true).build()
        }

        val built = ExoPlayer.Builder(activity)
            .setLoadControl(load)
            .setTrackSelector(tracks)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http))
            .build()

        built.setVideoSurfaceView(surface)
        built.addListener(listener)
        /* Let it climb once it is up: forcing the lowest rendition forever
           would mean a channel that never sharpens. */
        main.postDelayed({
            try {
                tracks.parameters = tracks.buildUponParameters().setForceLowestBitrate(false).build()
            } catch (t: Throwable) {
                Log.w(MainActivity.TAG, "track selector: ${t.message}")
            }
        }, 4_000)

        player = built
        return built
    }

    private val listener = object : Player.Listener {

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_BUFFERING -> {
                    setState("buffering")
                    emit("buffering", "0")
                }
                Player.STATE_READY -> {
                    emit("buffered", "")
                    if (player?.playWhenReady == true) {
                        snapPlaying = true
                        setState("playing")
                        emit("playing", "")
                    } else {
                        setState("ready")
                    }
                }
                Player.STATE_ENDED -> {
                    snapPlaying = false
                    setState("ended")
                    emit("ended", "")
                }
                Player.STATE_IDLE -> setState("idle")
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            snapPlaying = isPlaying
        }

        override fun onVideoSizeChanged(videoSize: VideoSize) {
            if (videoSize.width > 0 && videoSize.height > 0) {
                snapVideoSize = "${videoSize.width}x${videoSize.height}"
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            fail(message(error), error)
        }
    }

    private fun setState(s: String) {
        if (s != snapState) Log.i(MainActivity.TAG, "player: $snapState -> $s")
        snapState = s
    }

    private fun fail(text: String, t: Throwable?) {
        snapPlaying = false
        val code = (t as? PlaybackException)?.errorCodeName
        snapError = if (code != null) "$text ($code)" else text
        setState("error")
        /* The code by name, because "format not supported" is a symptom and
           the code is the thing worth reading out of logcat. */
        Log.w(MainActivity.TAG, "player failed: $snapError", t)
        emit("error", snapError)
    }

    /**
     * What went wrong, in words a viewer can act on.
     *
     * Deliberately the same vocabulary as avErrText() in player.js: "cannot
     * reach", "not found", "format". A viewer switching between a Samsung set
     * and an Android box should not have to learn two sets of complaints for
     * the same dead channel.
     */
    private fun message(e: PlaybackException): String = when (e.errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
            "Cannot reach the stream server"

        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
            "Stream not found (channel may be offline)"

        PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE,
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED ->
            "Format not supported by this device"

        /* Broadcast IPTV is overwhelmingly 1080i, and a software decoder —
           which is what an emulator has, and what a weak box falls back to —
           frequently refuses field-coded H.264 outright. Naming it saves
           somebody assuming the stream is broken. */
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ->
            "This device cannot decode this video (interlaced streams need a hardware decoder)"

        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND ->
            "Stream not found (channel may be offline)"

        else -> "Playback error (${e.errorCodeName})"
    }

    companion object {
        /** Some providers refuse anything that looks like a browser. */
        const val USER_AGENT = "AquaPlay/1.0 (Android TV) ExoPlayer"
    }
}
