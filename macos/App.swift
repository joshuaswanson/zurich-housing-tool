import AppKit
import WebKit

@main
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var serverURL: URL?
    private var serverOutput = ""
    private var quitting = false

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    private static let supportDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Zurich Housing Tool", isDirectory: true)

    private static let logFile = FileManager.default
        .urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/Zurich Housing Tool.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMainMenu()

        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isInspectable = true
        webView.loadHTMLString(Self.loadingPage, baseURL: nil)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Zurich Housing Tool"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("Main")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()

        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.terminate()
        server?.waitUntilExit()
    }

    // MARK: Background server

    private func startServer() {
        let resources = Bundle.main.resourceURL!
        let process = Process()
        process.executableURL = resources.appendingPathComponent("node/bin/node")
        process.arguments = [resources.appendingPathComponent("app/src/server.js").path, "0"]

        try? FileManager.default.createDirectory(at: Self.supportDirectory, withIntermediateDirectories: true)
        var environment = ProcessInfo.processInfo.environment
        environment["ZHT_HOME"] = Self.supportDirectory.path
        environment["ZHT_APPLE_LLM"] = resources.appendingPathComponent("bin/apple-llm").path
        process.environment = environment

        let log = openLog()
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            log?.write(data)
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.serverPrinted(text) }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.serverStopped() }
        }

        do {
            try process.run()
            server = process
        } catch {
            showFailure("The background process could not start. \(error.localizedDescription)")
        }
    }

    private func openLog() -> FileHandle? {
        let manager = FileManager.default
        try? manager.createDirectory(at: Self.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        manager.createFile(atPath: Self.logFile.path, contents: nil)
        return try? FileHandle(forWritingTo: Self.logFile)
    }

    private func serverPrinted(_ text: String) {
        serverOutput += text
        guard serverURL == nil,
              let match = serverOutput.firstMatch(of: #/http://127\.0\.0\.1:\d+/#),
              let url = URL(string: String(match.output))
        else { return }
        serverURL = url
        webView.load(URLRequest(url: url))
    }

    private func serverStopped() {
        guard !quitting else { return }
        showFailure("The background process stopped. Details are in \(Self.logFile.path).")
    }

    private func showFailure(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Zurich Housing Tool cannot continue"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: Web view

    private func isDashboard(_ url: URL?) -> Bool {
        guard let url, let serverURL else { return url?.scheme == "about" }
        return url.host == serverURL.host && url.port == serverURL.port
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        if isDashboard(url) || navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
        } else {
            if let url { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    @objc private func reload(_ sender: Any?) {
        if let serverURL { webView.load(URLRequest(url: serverURL)) }
    }

    @objc private func openDataFolder(_ sender: Any?) {
        NSWorkspace.shared.open(Self.supportDirectory)
    }

    // MARK: Menus

    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "About Zurich Housing Tool", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Show Data Folder", action: #selector(openDataFolder(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Zurich Housing Tool", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Zurich Housing Tool", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu: app, title: "Zurich Housing Tool")

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu: edit, title: "Edit")

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        view.addItem(.separator())
        let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        main.addItem(submenu: view, title: "View")

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        main.addItem(submenu: windowMenu, title: "Window")
        NSApp.windowsMenu = windowMenu

        return main
    }

    private static let loadingPage = """
        <!doctype html>
        <html><head><style>
          :root { color-scheme: light dark; }
          body { margin: 0; height: 100vh; display: grid; place-items: center;
                 font: 15px -apple-system, sans-serif; color: #6b7280; }
        </style></head><body>Loading listings…</body></html>
        """
}

private extension NSMenu {
    func addItem(submenu: NSMenu, title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        addItem(item)
    }
}
