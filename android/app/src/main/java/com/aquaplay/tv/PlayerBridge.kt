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
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.DefaultHlsExtractorFactory
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
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
    @Volatile private var snapTracks = ""

    /** Built with the player, because it shares its data source factory. */
    private var hlsSource: HlsMediaSource.Factory? = null
    @Volatile private var snapError = ""
    /** Whether a frame has reached the screen since the last play(). A stream
     *  that decodes nothing looks exactly like one that is still buffering. */
    @Volatile private var sawFrame = false
    @Volatile private var snapRect = "-"
    @Volatile private var snapScreen = "-"

    /** Position and the time event, on the main thread, while something is on.
     *  Half a second: the info bar counts in seconds and the drift watch wants
     *  to notice a stall before a viewer does. */
    private val ticker = object : Runnable {
        override fun run() {
            val p = player ?: return
            snapPositionMs = p.currentPosition.coerceAtLeast(0L)
            /* A live stream HAS a duration as far as ExoPlayer is concerned —
               the sliding window, about a minute of it — and reporting that
               made every live channel look like a short recording to
               player.js, which turns "has a duration" into "can be sought".
               The arrows then shuffled about inside that minute instead of
               opening the catch-up scrubber. TIME_UNSET means "not known
               yet", which is a different question from "is this live". */
            snapDurationMs =
                if (p.isCurrentMediaItemLive || p.duration == C.TIME_UNSET) 0L
                else p.duration.coerceAtLeast(0L)
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
            snapTracks = ""
            setState("buffering")
            try {
                /* HLS has to be built by hand to carry the extractor flags
                   above; nothing else does. */
                val item = MediaItem.fromUri(url)
                val hls = hlsSource
                if (hls != null && url.contains(".m3u8", ignoreCase = true)) {
                    p.setMediaSource(hls.createMediaSource(item))
                } else {
                    p.setMediaItem(item)
                }
                p.prepare()
                p.playWhenReady = true
                sawFrame = false
                main.removeCallbacks(ticker)
                main.post(ticker)
                main.removeCallbacks(noPicture)
                main.postDelayed(noPicture, NO_PICTURE_MS)
            } catch (t: Throwable) {
                fail("Could not open this stream", t)
            }
        }
    }

    @JavascriptInterface
    fun stop() {
        main.post {
            main.removeCallbacks(ticker)
            main.removeCallbacks(noPicture)
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
    fun setRect(x: Int, y: Int, w: Int, h: Int, vw: Int, vh: Int) {
        if (w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return
        main.post {
            /* The page's pixels are not this view's pixels and no constant says
               what the difference is — devicePixelRatio reports the density
               while the WebView quietly folds a page scale in on top of it. So
               the page says how big it thinks it is and the view knows how big
               it really is, and the ratio between those two is the answer
               whatever either of them is called. */
            val parent = surface.parent as? android.view.View
            val realW = parent?.width ?: 0
            val realH = parent?.height ?: 0
            val sx = if (realW > 0) realW.toDouble() / vw else 1.0
            val sy = if (realH > 0) realH.toDouble() / vh else 1.0

            val lp = FrameLayout.LayoutParams(
                Math.round(w * sx).toInt(), Math.round(h * sy).toInt()
            )
            lp.leftMargin = Math.round(x * sx).toInt()
            lp.topMargin = Math.round(y * sy).toInt()
            surface.layoutParams = lp
            surface.requestLayout()
            /* What was asked for, and what the screen is. A picture in the
               top-left quarter is what these two disagreeing looks like, and
               it took somebody with a television to notice — so it is written
               down now rather than inferred. */
            val dm = activity.resources.displayMetrics
            snapRect = "${lp.leftMargin},${lp.topMargin} ${lp.width}x${lp.height}"
            snapScreen = "page ${vw}x${vh} view ${realW}x${realH} " +
                "screen ${dm.widthPixels}x${dm.heightPixels} @${dm.density}"
            Log.i(MainActivity.TAG, "setRect $snapRect  ($snapScreen)")
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

    /** What the stream turned out to contain, and what this device makes of
     *  it: one line per track, marked UNSUPPORTED where nothing will decode
     *  it. Empty until a stream has been opened. */
    @JavascriptInterface
    fun trackInfo(): String = snapTracks

    @JavascriptInterface
    fun state(): String = snapState

    @JavascriptInterface
    fun lastError(): String = snapError

    @JavascriptInterface
    fun exitApp() {
        (activity as? MainActivity)?.exitApp()
    }

    /**
     * The page has put the cursor in a text field, or taken it out again.
     *
     * Left to itself the WebView opens the keyboard when an input takes focus
     * and leaves it up afterwards, so the next OK — on the Connect button, say
     * — goes to the keyboard rather than to the page. The page knows which of
     * those two states it is in and nothing else does, so it says.
     */
    @JavascriptInterface
    fun setEditing(on: Boolean) {
        (activity as? MainActivity)?.setEditing(on)
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
        main.removeCallbacks(noPicture)
        player?.release()
        player = null
    }

    /**
     * Nothing has reached the screen. Give up and say why.
     *
     * Twenty seconds is far longer than any buffer this app asks for, so
     * reaching it means the picture is not coming. What it deliberately does
     * not do is say why. The first time this fired, the cause looked exactly
     * like a software decoder refusing interlaced video — and was nothing of
     * the kind: the reader was waiting for an IDR frame that the broadcaster
     * never sends, which is what FLAG_ALLOW_NON_IDR_KEYFRAMES now settles. A
     * message that names a cause it has not established sends the next person
     * looking in the wrong place, and cost this one a version.
     */
    private val noPicture = Runnable {
        if (sawFrame) return@Runnable
        val p = player ?: return@Runnable
        if (p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED) {
            return@Runnable
        }
        Log.w(MainActivity.TAG, "no picture after ${NO_PICTURE_MS}ms — giving up")
        fail("This channel is sending sound but no picture", null)
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

        /* Broadcast H.264 very often carries no IDR frames at all: the
           encoder refreshes the picture gradually instead, which is legal and
           which the reader will otherwise wait for for ever. The symptom is
           not an error — the video track is found, selected and reported
           supported, the audio plays, and no decoder is ever created. This
           says to begin at the first recovery point instead. */
        val hlsExtractors = DefaultHlsExtractorFactory(
            DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES,
            /* exposeCea608WhenMissingDeclarations = */ true
        )
        hlsSource = HlsMediaSource.Factory(http).setExtractorFactory(hlsExtractors)

        /* The same stream also arrives as a bare .ts from some providers. */
        val tsExtractors = DefaultExtractorsFactory()
            .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)

        val tracks = DefaultTrackSelector(activity).apply {
            /* Start on the lowest rendition and let it climb: a channel that
               is soft for two seconds beats a channel that takes five to
               appear. The same choice as ADAPTIVE_INFO=STARTBITRATE=LOWEST. */
            parameters = buildUponParameters().setForceLowestBitrate(true).build()
        }

        /* If the decoder the platform picks first cannot start, try the next
           one rather than giving up. It rescues the decoders that fail
           honestly; it does nothing for a stream that never reaches a decoder
           at all, which is what the missing-IDR channels were doing. */
        val renderers = androidx.media3.exoplayer.DefaultRenderersFactory(activity)
            .setEnableDecoderFallback(true)

        val built = ExoPlayer.Builder(activity, renderers)
            .setLoadControl(load)
            .setTrackSelector(tracks)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http, tsExtractors))
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

        /* Read this before blaming the decoder. "No video track at all"
           and "a video track nothing here can decode" look identical from
           upstairs — silence and a black rectangle — and they have different
           answers. */
        override fun onTracksChanged(tracks: Tracks) {
            val sb = StringBuilder()
            for (g in tracks.groups) {
                for (i in 0 until g.length) {
                    val f = g.getTrackFormat(i)
                    sb.append(if (sb.isEmpty()) "" else "; ")
                        .append(f.sampleMimeType ?: "?")
                        .append(' ').append(f.codecs ?: "-")
                    if (f.width > 0) sb.append(' ').append(f.width).append('x').append(f.height)
                    sb.append(if (g.isTrackSupported(i)) "" else " UNSUPPORTED")
                    sb.append(if (g.isTrackSelected(i)) " [on]" else "")
                }
            }
            if (sb.isEmpty()) sb.append("no tracks")
            snapTracks = sb.toString()
            Log.i(MainActivity.TAG, "tracks: $snapTracks")
        }

        override fun onVideoSizeChanged(videoSize: VideoSize) {
            if (videoSize.width > 0 && videoSize.height > 0) {
                snapVideoSize = "${videoSize.width}x${videoSize.height}"
            }
        }

        /* The picture is actually on the screen — which is a different claim
           from "the player says it is ready", and the only one worth waiting
           for. */
        override fun onRenderedFirstFrame() {
            sawFrame = true
            main.removeCallbacks(noPicture)
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
        /* Two audiences. snapError carries the code for the diagnostics rows
           and for logcat, where "format not supported" is a symptom and the
           code is the thing worth reading. What goes up to the page is the
           sentence alone, because that sentence is a key in ten dictionaries
           and "Playback error (ERROR_CODE_IO_BAD_HTTP_STATUS)" is a key in
           none of them. */
        snapError = if (code != null) "$text ($code)" else text
        setState("error")
        Log.w(MainActivity.TAG, "player failed: $snapError", t)
        emit("error", text)
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

        /* A decoder that actually failed, rather than one that was never
           asked — those two are told apart by trackInfo(). Broadcast IPTV is
           overwhelmingly 1080i and a software decoder can refuse field-coded
           H.264 outright, but the parenthetical that used to name that as the
           cause here was guessing, so it is gone. */
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ->
            "This device cannot decode this channel's video"

        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND ->
            "Stream not found (channel may be offline)"

        /* The code is in snapError and in logcat; this is the half a
           viewer reads, and it has to survive being looked up. */
        else -> "Playback error"
    }

    companion object {
        /** Some providers refuse anything that looks like a browser. */
        const val USER_AGENT = "AquaPlay/1.0 (Android TV) ExoPlayer"

        /** How long to wait for a first frame before calling it. Well past the
         *  largest buffer the app ever asks for, so this only fires when the
         *  picture genuinely is not coming. */
        const val NO_PICTURE_MS = 20_000L
    }
}
