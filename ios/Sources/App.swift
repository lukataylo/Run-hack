// air-run-coach — WKWebView shell for the deployed Form Coach page.
// Adds the one thing the web cannot do: CMHeadphoneMotionManager (AirPods IMU),
// plus locked-screen speech via AVSpeechSynthesizer. It reimplements nothing.
import SwiftUI
import WebKit
import CoreMotion
import CoreLocation
import AVFoundation

// >>> REPLACE-WITH-DEPLOY-URL — set to the Railway URL after the first deploy <<<
let deployURL = URL(string: "https://form-coach-production-76e3.up.railway.app")!

@main
struct AirRunCoachApp: App {
    var body: some Scene {
        WindowGroup {
            WebShell()
                .ignoresSafeArea()
                .background(Color.black)
        }
    }
}

struct WebShell: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(context.coordinator, name: "say")
        // offline fallback: ES modules don't execute over file://, so the
        // bundled app is served over a custom scheme instead
        cfg.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "formcoach")
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.web = web
        context.coordinator.configureAudio()
        UIApplication.shared.isIdleTimerDisabled = true
        var req = URLRequest(url: deployURL)
        req.cachePolicy = .reloadRevalidatingCacheData
        web.load(req)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    // grant DeviceMotionEvent.requestPermission — without this the Start tap
    // dies silently in a WKWebView (and js alert() is equally dead)
    func webView(_ webView: WKWebView,
                 requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
    // complete js alerts so a stray alert() can never hang the page
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        completionHandler()
    }
    weak var web: WKWebView?
    let motion = CMHeadphoneMotionManager()
    let synth = AVSpeechSynthesizer()
    // the app itself needs location permission before the page's
    // watchPosition can work inside a WKWebView
    let location = CLLocationManager()
    var firstT: TimeInterval?
    var loadedFallback = false

    func configureAudio() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .mixWithOthers])
        try? s.setActive(true)
        location.requestWhenInUseAuthorization()
        // Headphone motion across backgrounding: stop the stream when the app
        // backgrounds and restart it on foreground. UIBackgroundModes=audio
        // keeps the JS alive for voice; restarting motion on foreground is
        // enough for the demo.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.motion.stopDeviceMotionUpdates()
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.startHeadMotion()
        }
    }

    // "say" bridge — survives a locked screen, unlike web speechSynthesis
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "say", let text = message.body as? String, !text.isEmpty else { return }
        let u = AVSpeechUtterance(string: text)
        u.rate = 0.52
        synth.speak(u)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // only a SUCCESSFUL bundled load closes the fallback door — a failed
        // one may retry once
        if web?.url?.scheme == "formcoach" { loadedFallback = true }
        startHeadMotion()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadFallback()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadFallback()
    }
    // a reachable server can still serve an error page: treat a >=400 main-frame
    // response as unreachable and fall back to the bundle
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame,
           let http = navigationResponse.response as? HTTPURLResponse,
           http.statusCode >= 400 {
            loadFallback()
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // offline cold-start: load the bundled page (custom scheme — ES modules
    // don't run over file://) if the deploy is unreachable; at most 2 attempts
    private var fallbackAttempts = 0
    func loadFallback() {
        guard !loadedFallback, fallbackAttempts < 2 else { return }
        fallbackAttempts += 1
        web?.load(URLRequest(url: URL(string: "formcoach://app/index.html")!))
    }

    // AirPods motion → window.__head(sample). ONE bud at a time (~25 Hz) by
    // system design; users must disable Automatic Ear Detection or the stream
    // dies when a pod leaves an ear.
    func startHeadMotion() {
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        firstT = nil
        motion.startDeviceMotionUpdates(to: .main) { [weak self] dm, _ in
            guard let self, let dm else { return }
            if self.firstT == nil { self.firstT = dm.timestamp }
            let t = (dm.timestamp - (self.firstT ?? dm.timestamp)) * 1000
            let G = 9.81
            let a = dm.userAcceleration, g = dm.gravity
            // CoreMotion reports g-units; the sample contract is m/s²
            // loc: which bud is streaming (0 unknown, 1 left, 2 right) — the
            // system streams ONE bud at a time; calibration mode shows this live
            let loc: Int
            switch dm.sensorLocation {
            case .headphoneLeft: loc = 1
            case .headphoneRight: loc = 2
            default: loc = 0
            }
            // attitude quaternion = full 3D head orientation (pitch/roll/yaw)
            // — the calibration screen renders a live 3D head from it
            let q = dm.attitude.quaternion
            let js = String(
                format: "window.__head&&window.__head({t:%.1f,ax:%.4f,ay:%.4f,az:%.4f,gx:%.4f,gy:%.4f,gz:%.4f,loc:%d,qw:%.4f,qx:%.4f,qy:%.4f,qz:%.4f})",
                t, a.x * G, a.y * G, a.z * G,
                (a.x + g.x) * G, (a.y + g.y) * G, (a.z + g.z) * G, loc,
                q.w, q.x, q.y, q.z)
            self.web?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

// Serves the bundled web app under formcoach://app/… with correct MIME types.
// Top-level resources sit flat in the bundle; vendor/audio/assets are folder
// references, so a plain resourceURL path append resolves both.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let mime: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript",
        "css": "text/css", "json": "application/json", "png": "image/png",
        "svg": "image/svg+xml", "mp3": "audio/mpeg", "glb": "model/gltf-binary",
        "jsonl": "application/x-ndjson", "ico": "image/x-icon",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = Bundle.main.resourceURL?.appendingPathComponent(String(path.dropFirst()))
        guard let file, let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                            headerFields: ["Content-Type": "text/plain"])!)
            task.didReceive(Data("not found".utf8))
            task.didFinish()
            return
        }
        let type = Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": type,
                                                       "Content-Length": String(data.count)])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
