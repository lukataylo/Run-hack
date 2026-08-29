// air-run-coach — WKWebView shell for the deployed Form Coach page.
// Adds the one thing the web cannot do: CMHeadphoneMotionManager (AirPods IMU),
// plus locked-screen speech via AVSpeechSynthesizer. It reimplements nothing.
import SwiftUI
import WebKit
import CoreMotion
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
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
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

final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    weak var web: WKWebView?
    let motion = CMHeadphoneMotionManager()
    let synth = AVSpeechSynthesizer()
    var firstT: TimeInterval?
    var loadedFallback = false

    func configureAudio() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .mixWithOthers])
        try? s.setActive(true)
    }

    // "say" bridge — survives a locked screen, unlike web speechSynthesis
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "say", let text = message.body as? String, !text.isEmpty else { return }
        let u = AVSpeechUtterance(string: text)
        u.rate = 0.52
        synth.speak(u)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        startHeadMotion()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadFallback()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadFallback()
    }

    // offline cold-start: load the bundled page once if the deploy is unreachable
    func loadFallback() {
        guard !loadedFallback, let url = Bundle.main.url(forResource: "index", withExtension: "html") else { return }
        loadedFallback = true
        web?.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
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
            let js = String(
                format: "window.__head&&window.__head({t:%.1f,ax:%.4f,ay:%.4f,az:%.4f,gx:%.4f,gy:%.4f,gz:%.4f})",
                t, a.x * G, a.y * G, a.z * G,
                (a.x + g.x) * G, (a.y + g.y) * G, (a.z + g.z) * G)
            self.web?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
