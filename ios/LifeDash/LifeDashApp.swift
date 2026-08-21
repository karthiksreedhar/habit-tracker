import SwiftUI

// Life Dashboard — a thin native shell around the deployed web app.
//
// Privacy posture, deliberately minimal:
// - No analytics or tracking SDKs; the app makes requests ONLY to the
//   dashboard's own domain (plus Google's sign-in page, in the system
//   browser, never inside the app's webview).
// - Nothing is stored on-device beyond the webview's own session cookie
//   and cache. No permissions are requested (no location, camera, etc.).
// - Google sign-in happens in ASWebAuthenticationSession — the app never
//   sees the Google password or tokens; the server hands back a short-lived
//   signed token that becomes the same session cookie the website uses.

@main
struct LifeDashApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea(.keyboard) // webview manages its own insets
        }
    }
}
