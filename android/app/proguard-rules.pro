# R8 / ProGuard rules for the WebEncryptor Android port.
#
# The app has no reflection-based serialization (JSON is handled through
# kotlinx-serialization's JsonElement API with explicit field access), so only
# the WebView JavaScript bridge entry point and the crash-report-free logging
# helpers need to be pinned.

# @JavascriptInterface members are invoked by name from WebView.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.webencryptor.app.bridge.JavascriptFallback { *; }

# Keep annotations used by AndroidX.
-keepattributes *Annotation*, InnerClasses, Signature, SourceFile, LineNumberTable

# WebView JavaScript interfaces are looked up by name.
-keepclassmembers class * implements android.webkit.WebViewClient { *; }

# kotlinx-serialization runtime keeps its own rules; silence the optional
# coroutines debug probe.
-dontwarn kotlinx.coroutines.**
