// Static checks for the Android wrapper.
//
// Why this file exists: the build sandbox has no JDK, no Gradle and no Android SDK, and cannot
// reach dl.google.com, so `assembleRelease` is not a thing that can be run here — it happens in
// GitHub Actions. A compile error would be caught there, in a log, minutes later. What a
// compiler does NOT catch, and what this does, is the class of bug where everything compiles,
// the APK builds, installs, launches, and shows nothing: a path prefix that disagrees with the
// staging task by one word, a permission granted in the manifest and never asked for at
// runtime, a colour typed twice and changed once. Those are cross-file facts, and they are the
// ones that cost an afternoon.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname;
const A = 'android';
const javaPath = `${A}/app/src/main/java/com/aryan/aicall/MainActivity.java`;
const paths = {
  manifest: `${A}/app/src/main/AndroidManifest.xml`,
  java: javaPath,
  app: `${A}/app/build.gradle`,
  root: `${A}/build.gradle`,
  settings: `${A}/settings.gradle`,
  props: `${A}/gradle.properties`,
  strings: `${A}/app/src/main/res/values/strings.xml`,
  colors: `${A}/app/src/main/res/values/colors.xml`,
  styles: `${A}/app/src/main/res/values/styles.xml`,
  styles31: `${A}/app/src/main/res/values-v31/styles.xml`,
  adaptive: `${A}/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`,
  adaptiveRound: `${A}/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml`,
  key: `${A}/debug.keystore`,
  wf: '.github/workflows/android.yml',
  index: 'web/index.html',
};

const read = (p) => (existsSync(ROOT + p) ? readFileSync(ROOT + p, 'utf8') : null);
const java = read(paths.java);
const app = read(paths.app);
const manifest = read(paths.manifest);
const html = read(paths.index);

let pass = 0;
const fails = [];
const skips = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(`${name}\n      ${String(e.message).split('\n')[0]}`);
  }
}
function skip(name, why) {
  skips.push(`${name} — ${why}`);
}

/** Every generated asset has to be here; a missing one is a build that dies in aapt. */
const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const mustExist = [
  ...Object.keys(paths).map((k) => paths[k]),
  ...densities.flatMap((d) => [
    `${A}/app/src/main/res/mipmap-${d}/ic_launcher.png`,
    `${A}/app/src/main/res/mipmap-${d}/ic_launcher_round.png`,
    `${A}/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`,
    `${A}/app/src/main/res/mipmap-${d}/ic_launcher_round_foreground.png`,
  ]),
  `${A}/app/src/main/res/drawable-nodpi/app_splash_icon.png`,
  'brand/icon-source.png',
  'scripts/brand.sh',
];

check('every file the build needs is in the tree', () => {
  const missing = mustExist.filter((p) => !existsSync(ROOT + p));
  assert.deepEqual(missing, [], `absent: ${missing.join(', ')}`);
});

check('no generated file is a stub', () => {
  // An empty PNG is valid UTF-8 nothing and compiles fine; aapt will not be the one to tell
  // you, the launcher showing a grey default robot will.
  const tiny = mustExist
    .filter((p) => p.endsWith('.png') && existsSync(ROOT + p))
    .filter((p) => statSync(ROOT + p).size < 400)
    .map((p) => `${p} (${statSync(ROOT + p).size}B)`);
  assert.deepEqual(tiny, [], `suspiciously small: ${tiny.join(', ')}`);
});

check('the staged page is what web/ actually holds', () => {
  const inWeb = readdirSync(ROOT + 'web').sort();
  const wanted = ['app.js', 'index.html', 'styles.css'];
  assert.deepEqual(wanted.filter((f) => !inWeb.includes(f)), [], 'web/ is missing ' + wanted);
  // copyWebAssets EXCLUDES sw.js, *.map and secrets*. If one of those ever appears in web/ it
  // is dropped from the APK without a word — which is right for a secret and wrong for a file
  // the page links. Failing here means the exclusion list has to be revisited when it matters,
  // rather than a blank page being the thing that revisits it.
  const shadowed = inWeb.filter((f) => f === 'sw.js' || f.endsWith('.map') || f.startsWith('secrets'));
  assert.deepEqual(shadowed, [], `present in web/ but excluded from the APK: ${shadowed.join(', ')}`);
});

// ── package, namespace, launcher ───────────────────────────────────────────
check('package, namespace and directory agree', () => {
  const pkg = /package ([\w.]+);/.exec(java)[1];
  const ns = /namespace '([\w.]+)'/.exec(app)[1];
  const id = /applicationId '([\w.]+)'/.exec(app)[1];
  assert.equal(pkg, ns, `java says ${pkg}, gradle says ${ns}`);
  assert.equal(id, ns, `applicationId ${id} != namespace ${ns}`);
  const dirs = javaPath.match(/java\/(.*)\/MainActivity\.java/)[1].replace(/\//g, '.');
  assert.equal(dirs, pkg, `file lives in ${dirs} but declares ${pkg}`);
});

check('the manifest activity resolves to the file that exists', () => {
  const act = /android:name="(\.[\w.]+)"/.exec(manifest)[1].slice(1);
  assert.equal(act, 'MainActivity');
  assert.match(manifest, /android:exported="true"/, 'exported=false means no launcher icon at all');
});

check('rotation does not hang up the call', () => {
  // Without these two, a rotation destroys the Activity, which destroys the WebView, which
  // closes the WebSocket: turning the phone sideways ends the call. It is the single most
  // obvious bug a wrapper can ship and the easiest to not notice, because phones in a pocket
  // do not rotate.
  const cfg = /android:configChanges="([^"]+)"/.exec(manifest)[1];
  for (const need of ['orientation', 'screenSize', 'keyboardHidden', 'uiMode']) {
    assert.match(cfg, new RegExp(`\\b${need}\\b`), `configChanges missing ${need}`);
  }
});

// ── the microphone, in all three places it has to be ────────────────────────
check('the mic is in the manifest, asked for at runtime, and granted to the page', () => {
  assert.match(manifest, /uses-permission android:name="android\.permission\.RECORD_AUDIO"/,
    'manifest permission');
  assert.match(java, /requestPermissions\(new String\[\] \{ android\.Manifest\.permission\.RECORD_AUDIO \}/,
    'runtime request — a manifest permission alone never shows the dialog');
  assert.match(java, /PermissionRequest\.RESOURCE_AUDIO_CAPTURE/, 'grant to the page');
  assert.match(java, /checkSelfPermission\(android\.Manifest\.permission\.RECORD_AUDIO\)/,
    'hasMic() must consult the grant, not assume it');
});

check('the page is granted audio and nothing else', () => {
  // A blanket `req.grant(req.getResources())` compiles, passes review by a tired human, and is
  // a microphone-and-camera permission handed to any page that asks. The grant must be built by
  // filtering, and the refusal path must actually call deny().
  assert.doesNotMatch(java, /grant\(req\.getResources\(\)\)/, 'blanket grant of every resource');
  const n = (java.match(/req\.deny\(\)/g) || []).length;
  assert.ok(n >= 2, `expected deny() on both the no-permission and no-audio paths, saw ${n}`);
  const body = java.slice(java.indexOf('public void onPermissionRequest'),
    java.indexOf('});', java.indexOf('public void onPermissionRequest')));
  assert.match(body, /for \(int r : want\)/, 'resources must be filtered one by one');
  assert.ok(!/setAllowUniversalAccessFromFileURLs/.test(java), 'universal file access');
});

check('the mic is optional at install time', () => {
  // required="false" is what keeps the app installable on a device with no microphone (a
  // chromebook, a tablet with no mic) so the page can say "voice unavailable" instead of the
  // store saying "your device is not compatible".
  assert.match(manifest, /name="android\.hardware\.microphone"[\s\S]{0,80}required="false"/);
});

// ── the WebView settings that decide whether anything works ─────────────────
check('the four settings that silently break this app are set', () => {
  const want = [
    ['setDomStorageEnabled\\(true\\)', 'no localStorage means no saved key, ever'],
    ['setMediaPlaybackRequiresUserGesture\\(false\\)', 'the first answer would be silent'],
    ['setAllowFileAccess\\(false\\)', 'file access is a way to read other apps'],
    ['setAllowContentAccess\\(false\\)', 'content access is the same hole on Android'],
    ['setJavaScriptEnabled\\(true\\)', 'there is no page without it'],
  ];
  for (const [re, why] of want) assert.match(java, new RegExp(re), `${re} — ${why}`);
});

check('the WebView paints the app colour, not white', () => {
  assert.match(java, /setBackgroundColor\(Color\.parseColor\(SURFACE\)\)/);
  assert.match(java, /private static final String SURFACE = "(#[0-9a-f]{6})"/);
});

// ── cross-file string agreements: the bugs a compiler cannot see ────────────
check('the asset prefix agrees between Java and Gradle', () => {
  const inGradle = /into genAssets\.map \{ it\.dir\('(\w+)'\) \}/.exec(app)[1];
  const inJava = /ASSET_ROOT = "\/(\w+)"/.exec(java)[1];
  assert.equal(inJava, inGradle, `staged into ${inGradle}/ but Java looks in ${inJava}/`);
  assert.match(java, /getAssets\(\)\.open\(ASSET_ROOT\.substring\(1\) \+ name\)/,
    'serve() must derive the asset dir from the same constant');
});

check('every absolute path the page asks for exists in the bundle', () => {
  // index.html says href="/styles.css". Under https://appassets.androidplatform.net that is a
  // request for /styles.css at the ROOT, not /web/styles.css — so a bundle that only serves
  // /web/* returns a 404 for the stylesheet and another for app.js, and you get a black screen
  // with a successful document and nothing in the console. This is the exact bug this check was
  // written for.
  // Absolute and relative both work under the bundle — a page at /web/index.html asking for
  // styles.css lands on /web/styles.css — so this does not forbid either form. It forbids the
  // one thing that is actually broken: a link to a file the bundle does not contain.
  const refs = [...html.matchAll(/(?:href|src)="\.?\/?(?!\/\/)([\w./-]+\.(?:css|js))"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, `expected the page to link at least a css and a js, found ${refs.length}`);
  const missing = refs.filter((r) => !existsSync(`${ROOT}web/${r}`));
  assert.deepEqual(missing, [], `linked but not in web/: ${missing.join(', ')}`);
  // And the wrapper has to answer them: a leading slash is stripped to a name under web/.
  assert.match(java, /if \(!name\.startsWith\("\/"\)\) name = "\/" \+ name;/,
    'root-level paths must be folded into the bundle dir');
  assert.match(java, /name\.equals\("\/"\)[\s\S]{0,60}index\.html/, 'the bare origin must land on index.html');
});

check('the 404 body is JSON the client can read', () => {
  // app.js does `fetch('/config').json()` at startup to learn whether a server holds its key.
  // There is no server in an APK, so the wrapper answers; a plain-text body would be a
  // SyntaxError where JSON is a legible "direct mode, paste your own key". The literal is
  // written across two lines of Java, so it is reassembled and PARSED rather than matched —
  // a regex would pass on JSON with a missing brace, and the client would still throw.
  assert.match(java, /setStatusCodeAndReasonPhrase\(404, "Not Found"\)/);
  const seg = /byte\[\] body = \(([\s\S]*?)\)\.getBytes/.exec(java);
  assert.ok(seg, 'the 404 body is not built where this check can read it');
  const json = [...seg[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1]).join('').replace(/\\"/g, '"');
  const parsed = JSON.parse(json);
  assert.equal(parsed.keysafe, false, 'the APK has no key store; it must say so');
  assert.ok(parsed.error && parsed.error.message, 'no error.message for the page to show');
  assert.ok(parsed.error.message.length > 12, 'error.message is too short to explain anything');
  assert.match(java, /new WebResourceResponse\("application\/json", "utf-8"/);
  assert.match(read('web/app.js'), /cfg\.keysafe = Boolean\(c\.keysafe\)/);
});

check('colours are generated, and the two copies match', () => {
  const colors = read(paths.colors);
  assert.match(colors, /Generated by scripts\/brand\.sh/, 'colors.xml must declare itself generated');
  const icon = /<color name="icon_background">(#[0-9a-f]{6})<\/color>/.exec(colors);
  const surf = /<color name="surface">(#[0-9a-f]{6})<\/color>/.exec(colors);
  const inJava = /SURFACE = "(#[0-9a-f]{6})"/.exec(java);
  assert.ok(icon && surf, 'colors.xml must define icon_background and surface');
  assert.equal(icon[1], surf[1], 'icon black and surface black disagree');
  assert.equal(inJava[1], icon[1], `Java paints ${inJava[1]}, theme says ${icon[1]}`);
  if (existsSync('/usr/bin/convert')) {
    const corner = execFileSync('convert', [`${ROOT}brand/icon-source.png`, '-crop', '1x1+8+8',
      '+repage', 'txt:-'], { encoding: 'utf8' }).match(/#([0-9A-Fa-f]{6})/)[1].toLowerCase();
    assert.equal(icon[1], '#' + corner, `theme says ${icon[1]}, the art itself is #${corner}`);
  } else {
    skip('theme colour vs the art itself', 'no ImageMagick on this machine to read the pixel');
  }
});

check('the splash theme only exists where the attributes do', () => {
  const base = read(paths.styles);
  const v31 = read(paths.styles31);
  assert.match(base, /name="AppTheme"/);
  assert.match(v31, /name="AppTheme"/, 'v31 must redefine the SAME style, not a new one');
  const parent = /parent="([^"]+)"/.exec(base)[1];
  assert.equal(/parent="([^"]+)"/.exec(v31)[1], parent, 'parent differs between -v31 and base');
  assert.match(v31, /<item name="android:windowSplashScreenAnimatedIcon">@drawable\/app_splash_icon<\/item>/,
    'API 31 draws the splash itself; this is the line that hands it our mark');
  assert.doesNotMatch(base, /windowSplashScreen/,
    'a 31-only attribute in the base style is exactly why the -v31 folder exists');
  for (const [f, what] of [[base, 'base'], [v31, 'v31']]) {
    for (const a of ['windowBackground', 'statusBarColor', 'navigationBarColor']) {
      assert.match(f, new RegExp(`<item name="android:${a}">@color/surface</item>`),
        `${what} theme: ${a} must be the app black, not a framework default`);
    }
  }
});

check('the icon is a full set, and the adaptive XML points at real things', () => {
  const xml = read(paths.adaptive);
  assert.match(xml, /<adaptive-icon xmlns:android="http:\/\/schemas.android.com\/apk\/res\/android">/);
  assert.match(xml, /<background android:drawable="@color\/icon_background" \/>/);
  assert.match(xml, /<foreground android:drawable="@mipmap\/ic_launcher_foreground" \/>/);
  const round = read(paths.adaptiveRound);
  assert.match(round, /@mipmap\/ic_launcher_round_foreground/, 'the round alias needs its own layer');
  for (const d of densities) {
    for (const f of ['ic_launcher_foreground', 'ic_launcher_round_foreground']) {
      assert.ok(existsSync(`${ROOT}${A}/app/src/main/res/mipmap-${d}/${f}.png`), `${d}/${f}`);
    }
  }
});

check('every R.string the Java reads is declared', () => {
  const used = [...java.matchAll(/R\.string\.(\w+)/g)].map((m) => m[1]);
  assert.ok(used.length >= 2, `expected R.string use, saw ${used.length}`);
  const declared = [...read(paths.strings).matchAll(/<string name="(\w+)">/g)].map((m) => m[1]);
  const missing = used.filter((u) => !declared.includes(u));
  assert.deepEqual(missing, [], `used but not in strings.xml: ${missing.join(', ')}`);
  for (const m of declared) {
    assert.ok(!/^\s*$/.test(read(paths.strings).match(new RegExp(`<string name="${m}">([^<]*)`))[1]),
      `empty string: ${m}`);
  }
});

check('no AndroidX import while useAndroidX is false', () => {
  const androidx = [...java.matchAll(/^import (androidx\.[\w.]+);/gm)].map((m) => m[1]);
  const flag = /android\.useAndroidX=(\w+)/.exec(read(paths.props))[1];
  assert.equal(flag, 'false', 'props say something unexpected');
  assert.deepEqual(androidx, [], `androidx imports without the flag: ${androidx.join(', ')}`);
  assert.doesNotMatch(app, /implementation ['"]androidx/, 'an androidx dependency in build.gradle');
  // And every import must be used: a stale one is a copy-paste marker, and in this file a
  // copy-pasted import is usually a copy-pasted method that assumes a class this app lacks.
  const unused = [...java.matchAll(/^import (?:static )?([\w.]+);/gm)]
    .map((m) => m[1].split('.').pop())
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .filter((n) => (java.split(new RegExp(`\\b${n}\\b`, 'g')).length - 1) < 2);
  assert.deepEqual(unused, [], `imported and never mentioned again: ${unused.join(', ')}`);
});

check('the java compiles-looking: balanced, no stubs, no TODO', () => {
  const stripped = java.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    const a = (stripped.match(new RegExp(`\\${o}`, 'g')) || []).length;
    const b = (stripped.match(new RegExp(`\\${c}`, 'g')) || []).length;
    assert.equal(a, b, `${o}${c} unbalanced: ${a} vs ${b}`);
  }
  assert.doesNotMatch(java, /\bTODO\b|\bFIXME\b|throw new UnsupportedOperationException/,
    'a stub in a 60-line Activity is not a stub, it is the app');
  assert.doesNotMatch(java, /^\s*public .*\{\s*\}\s*$/m, 'empty method body');
});

check('gradle wires staging so no build path can skip it', () => {
  assert.match(app, /tasks\.named\('preBuild'\) \{ dependsOn tasks\.named\('copyWebAssets'\) \}/);
  // Anchored to the start of a line: `// assets.srcDir genAssets` in a commented-out block is
  // not the directory being on the assets path, and a substring match cannot tell the two.
  assert.match(app, /^\s*assets\.srcDir genAssets\s*$/m, 'the generated dir must be on the assets path');
  // Matched as a declaration, not as a word: the comment above it says "Sync, not Copy", and a
  // bare /Sync/ would happily match that prose after the task itself was downgraded to Copy.
  assert.match(app, /tasks\.register\('copyWebAssets', Sync\)/,
    'copyWebAssets must be a Sync, so a file deleted from web/ is deleted from the APK too');
  assert.match(app, /exclude[^\n]*sw\.js/, 'no service worker in the bundle');
  // Anchored and comment-free, because the line above it in the file explains the flag in
  // prose; a loose /buildConfig true/ matched that explanation after the real one was gone.
  assert.match(app, /^ {8}buildConfig true$/m, 'BuildConfig.DEBUG needs this on AGP 8');
  // Per build type, because there are two and the debug one would cover for the release one:
  // an APK that builds unsigned installs nowhere and says nothing about why.
  for (const bt of ['release', 'debug']) {
    // 8 spaces is the closing brace of a build type inside buildTypes { }; the contents are at
    // 12. Getting that wrong makes the match run to the end of the file and pass for nothing.
    const blk = new RegExp(`\\n {8}${bt} \\{([\\s\\S]*?)\\n {8}\\}`).exec(app);
    assert.ok(blk, `buildTypes.${bt} not found as written`);
    assert.match(blk[1], /signingConfig signingConfigs\.shared/,
      `${bt} is not signed with the checked-in key — a runner-generated one breaks updates`);
  }
  assert.match(app, /storeType 'PKCS12'/, 'the checked-in keystore is PKCS12');
  assert.match(app, /minSdk 23/);
  const msdk = /minSdk (\d+)/.exec(app)[1];
  assert.ok(+msdk >= 23, 'checkSelfPermission needs 23');
  assert.match(app, /file\("\$rootDir\/\.\.\/web"\)/, 'staging must read the real web/');
});

check('a tag and a versionName agree', () => {
  const code = /versionCode (\d+)/.exec(app)[1];
  const name = /versionName '([\d.]+)'/.exec(app)[1];
  assert.match(name, /^\d+\.\d+$/, `versionName '${name}' is not x.y`);
  assert.match(code, /^\d+$/);
  const tag = process.env.GITHUB_REF_NAME || '';
  if (/^v\d/.test(tag)) {
    // The failure this catches is installing "1.4" and having Settings say 1.0, then spending
    // an hour on the wrong hypothesis about the WebView.
    assert.equal(tag.slice(1), name, `tag ${tag} but build.gradle says ${name}`);
  }
});

check('the workflow builds, checks, uploads and releases', () => {
  const wf = read(paths.wf);
  assert.match(wf, /node scripts\/check-apk\.mjs/, 'CI must run this file');
  assert.match(wf, /:app:assembleRelease/);
  assert.match(wf, /actions\/upload-artifact@v4/);
  assert.match(wf, /softprops\/action-gh-release@v2|gh release create/, 'no release step = no APK link');
  assert.match(wf, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/, 'releases only on a tag');
  assert.match(wf, /java-version: '17'/, 'AGP 8 needs JDK 17');
  assert.match(wf, /assets\/web\/\(index\\\.html\|app\\\.js\|styles\\\.css\)/,
    'the APK must be unbundled and checked, not just produced');
  // The jar is absent, so any invocation of the wrapper is a build that dies on step one. Only
  // the command lines are checked: the file's own prose says "./gradlew" out loud, and a
  // doesNotMatch on the whole file would fail on a comment about the thing it forbids.
  assert.ok(!existsSync(`${ROOT}${A}/gradle/wrapper/gradle-wrapper.jar`),
    'a wrapper jar here is a binary nobody audits');
  assert.doesNotMatch(wf, /run:[^\n]*gradlew/, 'the wrapper jar is not in this repo');
  assert.match(wf, /setup-android/, 'no SDK, no aapt2');
});

check('the name in the manifest is the name in the page', () => {
  const label = /<string name="app_name">([^<]+)<\/string>/.exec(read(paths.strings))[1];
  const title = /<title>([^<]+)<\/title>/.exec(html)[1];
  assert.ok(title.includes(label), `launcher says "${label}" but the tab says "${title}"`);
  assert.match(manifest, /android:label="@string\/app_name"/, 'label must come from strings.xml');
  assert.match(manifest, /android:allowBackup="false"/,
    'backing up a WebView profile would ship the API key to Google Drive');
});

console.log(`\napk: ${pass} passed, ${fails.length} failed, ${skips.length} skipped`);
for (const s of skips) console.log(`   skip  ${s}`);
if (fails.length) {
  for (const f of fails) console.log(`   FAIL  ${f}`);
  process.exit(1);
}
