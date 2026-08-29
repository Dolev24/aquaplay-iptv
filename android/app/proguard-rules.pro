# The JS bridge is reached by name from JavaScript, so nothing on it can be
# renamed or stripped however unused it looks from Kotlin.
-keepclassmembers class com.aquaplay.tv.** {
    @android.webkit.JavascriptInterface <methods>;
}
