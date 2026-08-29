# AquaPlay for Android TV

The shell. Everything a viewer sees lives in `../app` — this is a WebView, a
decoder and a key map, about 700 lines of Kotlin, whose job is to give that web
app the three things a browser will not.

```
android/
  settings.gradle.kts
  build.gradle.kts
  app/
    build.gradle.kts            reads the version out of ../app/config.xml
    src/main/
      AndroidManifest.xml       leanback, no touchscreen, a banner
      java/com/aquaplay/tv/
        MainActivity.kt         the WebView, the surface, the remote
        PlayerBridge.kt         ExoPlayer, and the object player.js calls
        NetBridge.kt            provider HTTP, answered without an origin
      res/
        drawable/banner.png     320x180 launcher tile   (generated)
        mipmap-*/ic_launcher.png                        (generated)
        xml/network_security_config.xml
```

The web app is **not** copied into this directory. Gradle stages `index.html`,
`css/` and `js/` from `../app` into the APK's assets on every build, so there is
one copy of the app and one set of tests over it. A unit test checks that list
against the one `tools/pack.js` uses for the Tizen package.

## Building it

```bash
cd android && ./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk` — about 4.9 MB,
with the whole web app inside it.

It needs **JDK 17** (Android Gradle Plugin 8.5 will not run on anything older)
and the **Android SDK** with `platforms;android-34` and `build-tools;34.0.0`.
Both are installed on the machine this was written on:

    JDK    C:/Users/dolev/devtools/jdk-17.0.20.1+1
    SDK    C:/Users/dolev/AppData/Local/Android/Sdk   (named in local.properties)

`local.properties` is gitignored, so a fresh clone needs its own — one line,
`sdk.dir=` and the path, with forward slashes. Set `JAVA_HOME` to the JDK
before running the wrapper.

Onto a box: `adb install -r app/build/outputs/apk/debug/app-debug.apk`, after
`adb connect <ip>:5555` for one on the network. `adb` is in the SDK's
`platform-tools`.

A release build is unsigned until it is given a keystore, the same way the
Tizen `.wgt` is unsigned until it is given a Samsung certificate.

## What the three parts do

**MainActivity** owns the layout — a `SurfaceView` at the back, a transparent
WebView over it — and the remote. The D-pad, Enter and the number keys are left
entirely alone: they reach the WebView as ordinary DOM keydowns and `keys.js`
already knows what to do with them, and the page is the only thing that knows
whether a text field wants them. BACK, the media transport, the coloured
buttons and INFO/GUIDE never arrive at all, because Android takes them first;
those are translated into the app's own action vocabulary and injected through
`Keys.inject()`.

**PlayerBridge** is `window.AquaPlayNative`. It is the same bargain the Tizen
build makes with AVPlay: the page works out where the picture goes, down to the
letterboxing, and hands over four numbers; the surface is moved there and the
video is stretched to fill it. Nothing in the Kotlin has an opinion about aspect
ratio, because every picture bug on Tizen came from two things having one.

Commands are posted to the main thread and questions are answered from a
snapshot, because ExoPlayer may only be touched on the thread that built it and
a blocking getter would deadlock the page.

**NetBridge** answers every external request in `shouldInterceptRequest`. A page
has an origin and a provider has never heard of CORS, so left to itself the
WebView fetches the playlist and throws it away unread. Answering it here means
the response can say what it needs to about origins — the same thing
`<access origin="*">` does in the Tizen manifest.

## Testing without a device

`npm run test:units` in `../app` covers the JavaScript half: platform
detection, the rectangle arithmetic, what the page asks the shell and what the
shell reports back, the key vocabulary on both sides of the bridge, and that
this project and the Tizen one agree about the version and the file list. Sixty
of them, and they run in a second with no emulator.

They cannot cover the Kotlin — for that there is the compiler, which found
three real bugs the first time it ran (see ARCHITECTURE.md). What is left for a
real device, roughly in order of how likely it is to be wrong:

- the surface's z-order against the WebView on a particular box,
- which colour-button keycodes a given remote actually sends,
- whether releasing `setForceLowestBitrate` after four seconds is soon enough,
- what happens when a stream ends while the app is in the background.

## Package name

`com.aquaplay.tv`. Change it in `app/build.gradle.kts` (`applicationId` and
`namespace`) and in the `package` line of the three Kotlin files if it needs to
be something else before it is published anywhere.
