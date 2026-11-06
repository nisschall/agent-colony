// Colony Wallpaper — shows Agent Colony as a live wallpaper on every screen.
// Watch mode: sits behind all windows and desktop icons; clicks go to the desktop.
// Work mode (⌃⌥⌘C or the menu-bar icon): the town comes to the front so you can click it.
import AppKit
import Carbon.HIToolbox
import WebKit

let serverURL = URL(string: "http://localhost:4747")!
let statusURL = serverURL.appendingPathComponent("status")
let retryDelaySeconds = 3.0
let statusPollSeconds = 5.0
// Just below the desktop icons: above every layer macOS draws for the desktop picture, below icons and windows.
let desktopLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) - 1)

struct WaitingAgent: Decodable {
    let id: String
    let project: String
    let ask: String
}

struct ColonyStatus: Decodable {
    let waiting: Int
    let working: Int
    let overworked: Int
    let stuck: Int
    let idle: Int
    let sleeping: Int
    let costToday: Double
    let waitingAgents: [WaitingAgent]
}

struct TimeOfDay {
    let title: String
    let hour: Double?
}

let timesOfDay = [
    TimeOfDay(title: "Live (follow the clock)", hour: nil),
    TimeOfDay(title: "Dawn", hour: 5.8),
    TimeOfDay(title: "Noon", hour: 12),
    TimeOfDay(title: "Golden hour", hour: 17.6),
    TimeOfDay(title: "Dusk", hour: 19.6),
    TimeOfDay(title: "Night", hour: 23),
]

final class InstallEventHandlerStatus {
    static let shared = InstallEventHandlerStatus()
    var value: OSStatus = noErr
}

final class WallpaperWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class ScreenWallpaper {
    let window: WallpaperWindow
    let webView: WKWebView
    var url: URL

    init(window: WallpaperWindow, webView: WKWebView, url: URL) {
        self.window = window
        self.webView = webView
        self.url = url
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, WKNavigationDelegate, WKUIDelegate {
    private var wallpapers: [CGDirectDisplayID: ScreenWallpaper] = [:]
    private var statusItem: NSStatusItem!
    private var workMode = false
    private var timeOverride: Double?
    private var lastStatus: ColonyStatus?
    private var hotKeyRef: EventHotKeyRef?
    private var workModeStartedAt = Date.distantPast

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setUpStatusItem()
        rebuildWallpapers()
        registerHotKey()
        observeSystem()
        pollStatus()
        Timer.scheduledTimer(withTimeInterval: statusPollSeconds, repeats: true) { [weak self] _ in self?.pollStatus() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            let frame = self?.statusItem.button?.window?.frame ?? .zero
            NSLog("Colony Wallpaper: menu-bar icon visible=%d at x=%.0f width=%.0f", self?.statusItem.isVisible == true ? 1 : 0, frame.minX, frame.width)
        }
    }

    // MARK: - One wallpaper window per screen

    private func displayID(of screen: NSScreen) -> CGDirectDisplayID {
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        return number?.uint32Value ?? 0
    }

    // Tells the page how much of this screen the menu bar and Dock cover, so its panels stay clear.
    private func pageURL(for screen: NSScreen) -> URL {
        let frame = screen.frame
        let visible = screen.visibleFrame
        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "wallpaper", value: "1"),
            URLQueryItem(name: "top", value: String(Int(frame.maxY - visible.maxY))),
            URLQueryItem(name: "bottom", value: String(Int(visible.minY - frame.minY))),
            URLQueryItem(name: "left", value: String(Int(visible.minX - frame.minX))),
            URLQueryItem(name: "right", value: String(Int(frame.maxX - visible.maxX))),
        ]
        return components.url!
    }

    @objc private func rebuildWallpapers() {
        var current = Set<CGDirectDisplayID>()
        for screen in NSScreen.screens {
            let id = displayID(of: screen)
            current.insert(id)
            let url = pageURL(for: screen)
            if let existing = wallpapers[id] {
                existing.window.setFrame(screen.frame, display: true)
                if existing.url != url {
                    existing.url = url
                    existing.webView.load(URLRequest(url: url))
                }
                continue
            }
            wallpapers[id] = makeWallpaper(for: screen, url: url)
        }
        for (id, wallpaper) in wallpapers where !current.contains(id) {
            wallpaper.window.orderOut(nil)
            wallpapers.removeValue(forKey: id)
        }
        NSLog("Colony Wallpaper: showing on %d screen(s)", wallpapers.count)
    }

    private func makeWallpaper(for screen: NSScreen, url: URL) -> ScreenWallpaper {
        let window = WallpaperWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.setFrame(screen.frame, display: false)
        window.level = desktopLevel
        // fullScreenAuxiliary lets work mode appear over full-screen apps too.
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(red: 0.31, green: 0.54, blue: 0.24, alpha: 1)

        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView
        webView.load(URLRequest(url: url))
        window.orderFrontRegardless()
        return ScreenWallpaper(window: window, webView: webView, url: url)
    }

    // MARK: - Watch mode and work mode

    @objc private func toggleWorkMode() {
        setWorkMode(!workMode)
    }

    private func setWorkMode(_ working: Bool) {
        NSLog("Colony Wallpaper: %@ mode", working ? "work" : "watch")
        workMode = working
        workModeStartedAt = working ? Date() : .distantPast
        for wallpaper in wallpapers.values {
            wallpaper.window.level = working ? .floating : desktopLevel
            wallpaper.window.ignoresMouseEvents = !working
            applyWorkMode(to: wallpaper.webView)
            if working {
                wallpaper.window.makeKeyAndOrderFront(nil)
            } else {
                wallpaper.window.orderFrontRegardless()
            }
        }
        if working {
            NSApp.activate()
        }
        updateStatusTitle()
    }

    private func applyWorkMode(to webView: WKWebView) {
        webView.evaluateJavaScript("window.colonySetWorkMode && window.colonySetWorkMode(\(workMode))")
    }

    // Clicking into another app sends the town back behind your windows.
    @objc private func appResignedActive() {
        // Ignore the brief focus flicker while macOS hands focus to us.
        if workMode && Date().timeIntervalSince(workModeStartedAt) > 1 {
            setWorkMode(false)
        }
    }

    // MARK: - Menu bar icon and live menu

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        updateStatusTitle()
    }

    // A monochrome system symbol that adapts to light and dark menu bars; a count shows when agents wait on you.
    private func updateStatusTitle() {
        guard let button = statusItem.button else { return }
        let symbol = lastStatus == nil ? "building.2" : workMode ? "hammer.fill" : "building.2.fill"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Agent Colony")
        image?.isTemplate = true
        button.image = image

        let title = NSMutableAttributedString()
        if let status = lastStatus, status.waiting > 0 {
            title.append(NSAttributedString(string: " \(status.waiting)", attributes: [.font: NSFont.menuBarFont(ofSize: 0)]))
        }
        if let status = lastStatus, status.overworked + status.stuck > 0 {
            title.append(NSAttributedString(string: " ●", attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuBarFont(ofSize: 0)]))
        }
        button.attributedTitle = title
        button.toolTip = lastStatus.map { "\($0.waiting) waiting on you · \($0.working) working" } ?? "Agent Colony server is not running"
    }

    // Rebuilt every time it opens, so it always shows the latest state.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let status = lastStatus else {
            menu.addItem(disabledItem("Agent Colony server is not running"))
            addCommonItems(to: menu)
            return
        }
        menu.addItem(disabledItem("⚒ \(status.working) working   🙋 \(status.waiting) waiting   🔥 \(status.overworked)   ❗ \(status.stuck)"))
        menu.addItem(disabledItem("☕ \(status.idle) on break   💤 \(status.sleeping) asleep   💰 \(String(format: "$%.2f", status.costToday)) today"))
        if !status.waitingAgents.isEmpty {
            menu.addItem(.separator())
            menu.addItem(disabledItem("Waiting on you"))
            for agent in status.waitingAgents {
                let item = NSMenuItem(title: "\(agent.project): \(agent.ask.prefix(70))", action: #selector(focusAgent(_:)), keyEquivalent: "")
                item.representedObject = agent.id
                item.target = self
                menu.addItem(item)
            }
        }
        addCommonItems(to: menu)
    }

    private func addCommonItems(to menu: NSMenu) {
        menu.addItem(.separator())
        let work = actionItem(workMode ? "Back to wallpaper (⌃⌥⌘C)" : "Work in the colony (⌃⌥⌘C)", #selector(toggleWorkMode))
        menu.addItem(work)
        menu.addItem(actionItem("Start a new app or chat…", #selector(startNewProject)))

        let timeMenu = NSMenu()
        for (index, time) in timesOfDay.enumerated() {
            let item = actionItem(time.title, #selector(chooseTimeOfDay(_:)))
            item.tag = index
            item.state = time.hour == timeOverride ? .on : .off
            timeMenu.addItem(item)
        }
        let timeItem = NSMenuItem(title: "Time of day", action: nil, keyEquivalent: "")
        timeItem.submenu = timeMenu
        menu.addItem(timeItem)
        menu.addItem(actionItem("Rebuild town…", #selector(rebuildTown)))

        menu.addItem(actionItem("Open in browser", #selector(openInBrowser)))
        menu.addItem(actionItem("Reload", #selector(reloadAll)))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Colony Wallpaper", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""))
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func actionItem(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func focusAgent(_ sender: NSMenuItem) {
        guard let agentId = sender.representedObject as? String else { return }
        setWorkMode(true)
        runInPages("window.colonyFocusAgent && window.colonyFocusAgent(\(jsonString(agentId)))")
    }

    @objc private func startNewProject() {
        setWorkMode(true)
        // Open the form on the main screen only.
        if let main = NSScreen.main, let wallpaper = wallpapers[displayID(of: main)] {
            wallpaper.webView.evaluateJavaScript("window.colonyOpenNewProject && window.colonyOpenNewProject()")
        }
    }

    @objc private func rebuildTown() {
        // Ask on the main screen only; the other screens reload once the server has the new layout.
        NSApp.activate()
        if let main = NSScreen.main, let wallpaper = wallpapers[displayID(of: main)] {
            wallpaper.webView.evaluateJavaScript("window.colonyRebuildTown && window.colonyRebuildTown()")
        }
    }

    @objc private func chooseTimeOfDay(_ sender: NSMenuItem) {
        timeOverride = timesOfDay[sender.tag].hour
        for wallpaper in wallpapers.values {
            applyTimeOfDay(to: wallpaper.webView)
        }
    }

    private func applyTimeOfDay(to webView: WKWebView) {
        let hour = timeOverride.map { String($0) } ?? "null"
        webView.evaluateJavaScript("window.colonySetTime && window.colonySetTime(\(hour))")
    }

    private func runInPages(_ script: String) {
        for wallpaper in wallpapers.values {
            wallpaper.webView.evaluateJavaScript(script)
        }
    }

    private func jsonString(_ value: String) -> String {
        let data = try? JSONEncoder().encode(value)
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    private func pollStatus() {
        URLSession.shared.dataTask(with: statusURL) { [weak self] data, _, _ in
            let status = data.flatMap { try? JSONDecoder().decode(ColonyStatus.self, from: $0) }
            DispatchQueue.main.async {
                self?.lastStatus = status
                self?.updateStatusTitle()
            }
        }.resume()
    }

    @objc private func openInBrowser() {
        NSWorkspace.shared.open(serverURL)
    }

    @objc private func reloadAll() {
        for wallpaper in wallpapers.values {
            wallpaper.webView.load(URLRequest(url: wallpaper.url))
        }
    }

    // MARK: - Global shortcut ⌃⌥⌘C (Carbon hot keys need no Accessibility permission)

    private func registerHotKey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPointer = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandlerStatus.shared.value = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { delegate.toggleWorkMode() }
            return noErr
        }, 1, &eventType, selfPointer, nil)
        let hotKeyID = EventHotKeyID(signature: OSType(0x434F_4C59), id: 1)
        let modifiers = UInt32(controlKey | optionKey | cmdKey)
        let handlerStatus = InstallEventHandlerStatus.shared
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_C), modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        NSLog("Colony Wallpaper: shortcut ⌃⌥⌘C %@ (handler %d, hot key %d)", status == noErr ? "registered" : "FAILED", handlerStatus.value, status)
    }

    // MARK: - Screens, sleep and focus

    private func observeSystem() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(rebuildWallpapers), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        center.addObserver(self, selector: #selector(appResignedActive), name: NSApplication.didResignActiveNotification, object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(toggleWorkMode),
                                                            name: Notification.Name("com.agentcolony.toggleWorkMode"), object: nil)
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(screensSlept), name: NSWorkspace.screensDidSleepNotification, object: nil)
        workspace.addObserver(self, selector: #selector(screensWoke), name: NSWorkspace.screensDidWakeNotification, object: nil)
    }

    // Hiding the windows while displays sleep stops the page from drawing and saves battery.
    @objc private func screensSlept() {
        for wallpaper in wallpapers.values {
            wallpaper.window.orderOut(nil)
        }
    }

    @objc private func screensWoke() {
        rebuildWallpapers()
        for wallpaper in wallpapers.values {
            wallpaper.window.orderFrontRegardless()
        }
    }

    // MARK: - Page loading (retry until the server is up) and JavaScript dialogs

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        applyWorkMode(to: webView)
        applyTimeOfDay(to: webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryLoad(webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retryLoad(webView)
    }

    private func retryLoad(_ webView: WKWebView) {
        DispatchQueue.main.asyncAfter(deadline: .now() + retryDelaySeconds) { [weak self] in
            guard let wallpaper = self?.wallpapers.values.first(where: { $0.webView === webView }) else { return }
            webView.load(URLRequest(url: wallpaper.url))
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
