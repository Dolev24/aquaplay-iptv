import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* ---------------------------------------------------------------------------
   One version number for both platforms.

   The web app already carries it in config.xml, which is what the Tizen
   package is built from, and two places to bump is one place to forget. The
   version code is derived from it so that 0.7.29 always sorts after 0.7.28
   without anybody choosing an integer by hand.
   --------------------------------------------------------------------------- */
val webRoot = rootProject.file("../app")

val webVersion: String by lazy {
    /* `<widget` matters: config.xml opens with `<?xml version="1.0"`, and a
       pattern that only looked for version= would call this app 1.0 for ever.
       The closing quote is a character class because a Kotlin raw string may
       not end with one. */
    val xml = File(webRoot, "config.xml").readText()
    Regex("""<widget[^>]*\sversion="([0-9.]+)["]""").find(xml)?.groupValues?.get(1)
        ?: throw GradleException("No version found in ${File(webRoot, "config.xml")}")
}

val webVersionCode: Int by lazy {
    val p = webVersion.split(".").map { it.toIntOrNull() ?: 0 }
    val major = p.getOrElse(0) { 0 }
    val minor = p.getOrElse(1) { 0 }
    val patch = p.getOrElse(2) { 0 }
    major * 1_000_000 + minor * 10_000 + patch
}

/* Read before android{}, where `java` means Gradle's own extension rather
   than the package and java.util.Properties does not resolve. */
val keyProps = Properties()
val keyFile = rootProject.file("keystore.properties")
if (keyFile.exists()) keyFile.inputStream().use { keyProps.load(it) }

android {
    namespace = "com.aquaplay.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.aquaplay.tv"
        /* 21 is the first Android TV. Media3 will not go lower, and neither
           will a WebView worth targeting. */
        minSdk = 21
        targetSdk = 34
        versionCode = webVersionCode
        versionName = webVersion
    }

    /* A release is signed with a key this repository does not contain and
       must never contain. Put one in android/keystore.properties, which is
       gitignored:

           storeFile=C:/keys/aquaplay.jks
           storePassword=...
           keyAlias=aquaplay
           keyPassword=...

       Without that file the release build still runs and produces an unsigned
       APK — which is what you want for checking that shrinking did not break
       anything, and which no device will install until it is signed. */

    signingConfigs {
        if (keyProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(keyProps.getProperty("storeFile"))
                storePassword = keyProps.getProperty("storePassword")
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            /* R8, with the rules in proguard-rules.pro. The one that matters
               there is the JavaScript bridge: every method on it is reached by
               name from the page and by nothing at all from Kotlin, so a
               shrinker left to its own judgement removes the entire player. */
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    /* The web app is not copied into the repository twice — it is staged into
       the build directory and handed to the APK from there, so app/ stays the
       only copy of it that exists. */
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("webapp"))

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

/* ---------------------------------------------------------------------------
   Staging the web app.

   The same files tools/pack.js puts in the .wgt, minus the two that are only
   Tizen's: config.xml is its manifest and icon.png is its launcher icon, and
   Android has its own of each. If that list and pack.js ever disagree, the two
   platforms are shipping different apps — test-units.js asserts they do not.
   --------------------------------------------------------------------------- */
val stageWebApp by tasks.registering(Sync::class) {
    description = "Copy the web app into the APK's assets"
    from(webRoot) {
        include("index.html")
        include("css/**")
        include("img/**")
        include("js/**")
    }
    into(layout.buildDirectory.dir("webapp/www"))
}

tasks.named("preBuild") { dependsOn(stageWebApp) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")

    /* ExoPlayer, which is where Media3 lives now. HLS is a separate artifact;
       progressive, MP4 and MPEG-TS come with the core. */
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.3.1")
}
