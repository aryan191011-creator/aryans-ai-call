package com.aryan.aicall;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * A WebView that is allowed to listen.
 *
 * That is the whole app. There is no Kotlin, no Compose, no JS bridge and no native call
 * screen, because the call screen already exists: 2,100 lines of JavaScript that work in every
 * browser. A rewrite would only be a second place for the same bug to live. What a browser
 * refuses a page — the microphone, on a file:// or http:// origin — is what this Activity
 * exists to hand over, and nothing more.
 *
 * It has no third-party dependencies. That is not pride: every line of this is API 23 surface,
 * and each AndroidX artifact added to it is one more thing that has to resolve from a Maven
 * mirror for the build to work on a machine that has never heard of this repo.
 */
public final class MainActivity extends Activity {

    /**
     * The origin the bundle is served from. Not a real host — nothing resolves here. A page
     * needs a scheme that the OS considers secure before navigator.mediaDevices exists at all,
     * and https on a fake origin is how a WebView gets one. file:// would have loaded the same
     * bytes and left the microphone permanently, inexplicably absent.
     */
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    // One constant, used by both the URL loaded at startup and the path test in serve(): the
    // bundle's directory name has to agree with the `into genAssets/web` in app/build.gradle,
    // and two hand-written copies of a string that must match is how a rename ships a 404.
    private static final String ASSET_ROOT = "/web";
    private static final String HOME = ORIGIN + ASSET_ROOT + "/index.html";

    /** `adb shell am start -n com.aryan.aicall/.MainActivity --es url <url>`. */
    private static final String EXTRA_URL = "url";

    private WebView web;
    private AudioManager audio;
    private boolean micAsked;
    private int audioModeBefore = AudioManager.MODE_NORMAL;
    private boolean focusHeld;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);

        web = new WebView(this);
        // Same value as the window background and the icon's black, chosen so a cold launch is
        // one surface from the first frame. It is set on the View as well as in styles.xml
        // because a WebView paints white before the page loads no matter what the window says.
        web.setBackgroundColor(Color.parseColor(SURFACE));
        configure(web);
        setContentView(web);

        String url = requestedUrl();
        // Ask before loadUrl, not when the page asks. The page opens a Live session the moment
        // you tap the green button; if the OS permission dialog lands after that, getUserMedia
        // rejects, the pill says "microphone blocked", and the user has to find the button
        // again with no idea that the answer was a dialog behind them.
        ensureMic();
        web.loadUrl(url);
    }

    /**
     * The page's near-black, and the same value res/values/colors.xml carries — which is
     * generated from brand/icon-source.png by scripts/brand.sh, so the icon, the window and
     * this View are one colour that was measured once rather than three that were typed.
     * Painted on the View as well as in the theme because a WebView shows white before the
     * first byte of the page arrives, whatever the window behind it says.
     */
    private static final String SURFACE = "#060915";

    /**
     * The dev hook. Two rules, both load-bearing.
     *
     * It is honoured only when adb sent it, because MainActivity is exported and any app on the
     * phone can start it with extras — a URL chosen by someone else is a fake login page laid
     * over the one screen that holds your API key.
     *
     * And a plain-http target gets no microphone, which is not this app refusing: getUserMedia
     * is a secure-context feature, so on http://192.168.x.x:8787 the API is simply absent from
     * the window and the page cannot even report it. That is why the shipped default serves
     * the bundle under a fake https origin instead of pointing at your LAN, and why this is for
     * looking at layout on a real screen — or for an https URL you actually control.
     */
    private String requestedUrl() {
        Intent it = getIntent();
        String raw = it == null ? null : it.getStringExtra(EXTRA_URL);
        if (raw == null || raw.isEmpty()) return HOME;
        if (!fromShell()) return HOME;
        if (!raw.startsWith("https://") && !raw.startsWith("http://")) return HOME;
        return raw;
    }

    private boolean fromShell() {
        int uid = Binder.getCallingUid();
        if (uid == 0) return true;   // rooted device, adb as root
        String pkg = getPackageManager().getNameForUid(uid);
        return "com.android.shell".equals(pkg);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView view) {
        WebSettings st = view.getSettings();
        st.setJavaScriptEnabled(true);
        // localStorage is where the API key and all ten panels' settings live. Without DOM
        // storage the app forgets everything on every launch and opens on its own setup sheet,
        // which reads as "it lost my password" rather than as a flag we forgot to set.
        st.setDomStorageEnabled(true);
        // The model starts speaking before the user has tapped anything inside the WebView —
        // tapping an app icon is not a gesture Chrome counts. Without this the first answer is
        // silent and no error anywhere explains why.
        st.setMediaPlaybackRequiresUserGesture(false);
        // One page, from assets, loaded once. File and content access are how a WebView becomes
        // a way to read someone else's database, so they stay off.
        st.setAllowFileAccess(false);
        st.setAllowContentAccess(false);
        st.setJavaScriptCanOpenWindowsAutomatically(false);
        st.setGeolocationEnabled(false);
        st.setTextZoom(100);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (!url.startsWith(ORIGIN + "/")) return null;
                return serve(url.substring(ORIGIN.length()));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (url.startsWith(ORIGIN)) return false;   // our page, and its #setup-* panels
                openExternally(url);
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                // After a renderer crash the View shows nothing at all, forever, and throws no
                // exception. Recreating the Activity is the only recovery. didCrash() == false
                // means the OS culled us for memory, where a reload just loops — so that case
                // says what happened instead of fixing it, which is the honest half.
                runOnUiThread(() -> {
                    if (detail.didCrash()) {
                        recreate();
                        return;
                    }
                    setContentView(deathNote(getString(R.string.dead_low_memory)));
                });
                return true;
            }
        });

        view.setWebChromeClient(new android.webkit.WebChromeClient() {
            /**
             * The one callback this app exists to write.
             *
             * The OS does not hand a WebView page the microphone; the host app approves each
             * request, and only if it holds RECORD_AUDIO itself. Grant unconditionally and this
             * is a spyware app with an icon. Deny, and the green button does nothing.
             *
             * So: audio in, everything else out. A page that asks for video capture or a MIDI
             * device — which is what a malicious or merely curious extension would ask for — is
             * refused in the same breath, not left to a permission the user then has to reason
             * about at 1am with a call in progress.
             */
            @Override
            public void onPermissionRequest(PermissionRequest req) {
                if (!hasMic()) {
                    req.deny();
                    ensureMic();
                    return;
                }
                int[] want = req.getResources();
                int n = 0;
                for (int r : want) if (r == PermissionRequest.RESOURCE_AUDIO_CAPTURE) n++;
                if (n == 0) {
                    req.deny();
                    return;
                }
                int[] grant = new int[n];
                int i = 0;
                for (int r : want) if (r == PermissionRequest.RESOURCE_AUDIO_CAPTURE) grant[i++] = r;
                req.grant(grant);
            }
        });

        if (BuildConfig.DEBUG) {
            // chrome://inspect from a laptop plugged into the phone. Compiled out of the release
            // APK: a WebView any debugger can attach to is a WebView anyone holding the phone
            // for ten seconds can read the API key out of.
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /**
     * The whole of the app's "server": URL path in, asset bytes out, nothing else.
     *
     * Two shapes of path are accepted, and the second is not a convenience. The page was
     * written for a web root, so index.html asks for /styles.css and /app.js with a leading
     * slash — and under this origin those land at the root, not under /web/. Serving only
     * /web/* yields a page that loads, renders as unstyled white text on the dark background
     * because the stylesheet 404'd, and never runs a line of JS because app.js 404'd too: a
     * black screen with a 200 on the document and nothing in the console to explain it.
     */
    private WebResourceResponse serve(String urlPath) {
        String prefix = ASSET_ROOT + "/";
        String name = urlPath.startsWith(prefix) ? urlPath.substring(prefix.length()) : urlPath;
        if (!name.startsWith("/")) name = "/" + name;
        if (name.equals("/")) name = "/index.html";
        // The prefix test instead of blind concatenation is what keeps a URL like
        // /web/../androidmanifest.xml from naming a file that is not part of the bundle.
        if (name.contains("..")) return notFound();
        int q = name.indexOf('?');
        if (q >= 0) name = name.substring(0, q);
        try {
            // "web" here is the directory copyWebAssets stages into; ASSET_ROOT is the same
            // string on the URL side, so the two cannot drift apart silently.
            InputStream in = getAssets().open(ASSET_ROOT.substring(1) + name);
            return new WebResourceResponse(mime(name), "utf-8", in);
        } catch (Exception e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        // A real 404, not an empty 200 — a missing app.js served as a successful empty file is
        // a blank page with a clean console, which is the worst thing to debug over adb.
        //
        // The body is JSON in the shape the client already reads from a failed relay request
        // (`j.error.message`), because this page does `fetch('/config').json()` at startup to
        // ask whether a server holds its key. Throwing away that parse with a plain-text body
        // is a SyntaxError; answering it is one line of legible "no relay here, use your own
        // key", which is the true state of an APK.
        byte[] body = ("{\"error\":{\"message\":\"no server in the APK — direct mode, "
                + "paste your own key\"},\"keysafe\":false}").getBytes(StandardCharsets.UTF_8);
        WebResourceResponse r = new WebResourceResponse("application/json", "utf-8",
                new ByteArrayInputStream(body));
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        r.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-store"));
        return r;
    }

    private static String mime(String k) {
        if (k.endsWith(".html")) return "text/html";
        if (k.endsWith(".js")) return "text/javascript";
        if (k.endsWith(".css")) return "text/css";
        if (k.endsWith(".svg")) return "image/svg+xml";
        if (k.endsWith(".png")) return "image/png";
        if (k.endsWith(".json")) return "application/json";
        if (k.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    private TextView deathNote(String why) {
        TextView t = new TextView(this);
        t.setText(why + "\n\n" + getString(R.string.dead_hint));
        t.setTextColor(Color.parseColor("#a3abc4"));
        t.setBackgroundColor(Color.parseColor(SURFACE));
        int p = (int) (28 * getResources().getDisplayMetrics().density);
        t.setPadding(p, p, p, p);
        return t;
    }

    private void openExternally(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) {
            // A link with no browser to open it. Silent is right: the alternative is a toast
            // about something the user did not tap.
        }
    }

    private boolean hasMic() {
        return checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void ensureMic() {
        if (micAsked || hasMic()) return;
        micAsked = true;
        requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, 1);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        // Deliberately does not reload the page. It has already drawn its "microphone blocked"
        // pill, and the fix the pill already says is correct: press the button again. Reloading
        // would throw away whatever was typed, to save one tap.
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        takeAudio();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        giveAudio();
        super.onPause();
    }

    /**
     * Route audio the way a phone call does, and inherit the echo canceller with it.
     *
     * MODE_IN_COMMUNICATION puts Android on the voice-call path: earpiece or paired headset,
     * hardware AEC, and mic gain tuned for a face at 30cm. On the default media path the model
     * hears its own answer out of the loudspeaker and talks over itself, which is the most
     * common cause of "it keeps interrupting me" in a speakerphone app — and the least likely
     * thing to suspect, because nothing in the page is wrong.
     */
    private void takeAudio() {
        if (audio == null) return;
        try {
            audioModeBefore = audio.getMode();
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            focusHeld = audio.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } catch (RuntimeException ignored) {
            // Some OEM stacks throw when focus is requested from an Activity rather than a
            // Service. Audio still flows; it just may not duck whatever was playing.
        }
    }

    private void giveAudio() {
        if (audio == null) return;
        try {
            if (focusHeld) {
                audio.abandonAudioFocus(null);
                focusHeld = false;
            }
            audio.setMode(audioModeBefore);
            audioModeBefore = AudioManager.MODE_NORMAL;
        } catch (RuntimeException ignored) {
            // Restoring the audio stack is not worth crashing on the way out for.
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();      // back out of a setup panel, which is what #setup-* is for
            return;
        }
        // Otherwise, end it. Not moveTaskToBack(): backgrounding this app does not keep a call
        // alive — see onPause — so pretending otherwise leaves a live-looking card in the
        // recents list with a session still running.
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
