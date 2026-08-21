import SwiftUI
import WebKit
import AuthenticationServices

/// The dashboard's production origin. Everything the app does happens here.
let dashboardURL = URL(string: "https://habit-tracker-tau-puce.vercel.app")!

struct ContentView: View {
    @StateObject private var model = WebViewModel()

    var body: some View {
        ZStack {
            Color(red: 0.184, green: 0.490, blue: 0.310) // green bar color behind safe areas
                .ignoresSafeArea()
            DashboardWebView(model: model)
                .ignoresSafeArea(edges: .bottom)
            if model.isLoading {
                ProgressView()
                    .controlSize(.large)
                    .tint(.white)
            }
            if let message = model.errorMessage {
                VStack(spacing: 14) {
                    Text("📡").font(.system(size: 40))
                    Text(message)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white)
                        .font(.callout)
                    Button("Try again") { model.reload() }
                        .buttonStyle(.borderedProminent)
                        .tint(.white.opacity(0.9))
                        .foregroundStyle(Color(red: 0.05, green: 0.4, blue: 0.17))
                }
                .padding(28)
            }
        }
        .preferredColorScheme(.light)
    }
}

final class WebViewModel: ObservableObject {
    @Published var isLoading = true
    @Published var errorMessage: String?
    weak var webView: WKWebView?

    func reload() {
        errorMessage = nil
        isLoading = true
        if webView?.url == nil {
            webView?.load(URLRequest(url: dashboardURL))
        } else {
            webView?.reload()
        }
    }
}

struct DashboardWebView: UIViewRepresentable {
    @ObservedObject var model: WebViewModel

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persistent — keeps the session cookie
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.isOpaque = false
        webView.backgroundColor = .clear

        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pulledToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        model.webView = webView
        webView.load(URLRequest(url: dashboardURL))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    final class Coordinator: NSObject, WKNavigationDelegate, ASWebAuthenticationPresentationContextProviding {
        let model: WebViewModel
        private var authSession: ASWebAuthenticationSession?

        init(model: WebViewModel) { self.model = model }

        @objc func pulledToRefresh(_ sender: UIRefreshControl) {
            model.webView?.reload()
            sender.endRefreshing()
        }

        // MARK: navigation policy

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { return decisionHandler(.allow) }

            let ownHost = url.host == dashboardURL.host

            // Google forbids OAuth in embedded webviews — hand sign-in to the
            // system's auth session instead, then return via lifedash://auth.
            if ownHost && url.path == "/auth/google" {
                decisionHandler(.cancel)
                startSignIn()
                return
            }

            // Links that leave the dashboard (the user's Sheet/Doc, etc.)
            // open in Safari, never inside the shell.
            if !ownHost && navigationAction.navigationType == .linkActivated {
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
                return
            }

            decisionHandler(.allow)
        }

        private func startSignIn() {
            var comps = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false)!
            comps.path = "/auth/google"
            comps.queryItems = [URLQueryItem(name: "app", value: "1")]

            let session = ASWebAuthenticationSession(url: comps.url!, callbackURLScheme: "lifedash") { [weak self] callback, _ in
                guard let self, let callback,
                      let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
                      let token = items.first(where: { $0.name == "token" })?.value else { return }
                var done = URLComponents(url: dashboardURL, resolvingAgainstBaseURL: false)!
                done.path = "/auth/app-complete"
                done.queryItems = [URLQueryItem(name: "token", value: token)]
                DispatchQueue.main.async {
                    self.model.webView?.load(URLRequest(url: done.url!))
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            authSession = session
            session.start()
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }

        // MARK: load state

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.isLoading = false
            model.errorMessage = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            model.isLoading = false
            model.errorMessage = "Couldn't reach your dashboard.\nCheck your connection and try again."
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            model.isLoading = false
        }
    }
}
