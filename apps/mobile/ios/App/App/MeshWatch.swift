import AudioToolbox
import Capacitor
import CoreBluetooth
import Foundation
import Intents
import UIKit
import UserNotifications

/// What the radio says while the phone is locked.
///
/// The client lives in a web view, and iOS suspends a web view's scripts soon
/// after the app leaves the screen. The Bluetooth link stays up (the app has
/// the `bluetooth-central` background mode) and the radio keeps pushing
/// frames, but no script is awake to read them, so the page announced nothing
/// while the phone was in a pocket. This watches the same link from native
/// code instead and announces what it can read without the page:
///
/// - `MSG_WAITING` (0x83), which the radio pushes for each message it queues:
///   "New message", counted, as one notice that replaces itself. What the
///   message says stays in the radio's queue until the page reads it, which
///   is when the app is opened.
/// - `NEW_ADVERT` (0x8A), a node heard for the first time, with its kind and
///   name taken from the contact record the push carries.
///
/// It is a second central manager on the connection the BLE plugin already
/// holds, to the radio the page names (`follow`): it only subscribes to the
/// radio's TX characteristic and never writes, so the page's own traffic is
/// untouched. Its notices are sent only
/// while the app is in the background; in front, the page does its own.
///
/// The page is often still awake for a while in the background, and then it
/// announces the same message itself, with its text. So the watch is the
/// stand-in: its notices wait a few seconds before they show, and the page
/// withdraws the watch's notice for anything it has announced (`announced`).
/// A page that is asleep withdraws nothing, and the watch's notice shows.
final class MeshWatch: NSObject {
    static let shared = MeshWatch()

    private static let service = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let tx = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let msgWaiting: UInt8 = 0x83
    private static let newAdvert: UInt8 = 0x8A
    private static let waitingId = "meshnet.waiting"
    /// How long a notice waits for the page to announce the same thing itself.
    private static let grace: TimeInterval = 5

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    /// The radio the page is connected to, by the id the BLE plugin knows it
    /// by. Only that one is watched: the phone may hold links to other radios
    /// with the same service (another app's, one the page gave up on), and
    /// subscribing to one it is not paired with makes iOS ask for its PIN.
    private var followed: UUID?
    private var inBackground = false
    private var waiting = 0
    /// Nodes the page has announced, by notice id: the page can be quicker
    /// than the watch here, since the push itself carries the node.
    private var pageAnnounced: [String: Date] = [:]

    func start() {
        guard central == nil else { return }
        MeshWatch.installSounds()
        central = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(wentToBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(cameToFront), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    /// Which notices the reader wants, as the page's two switches say.
    /// `people`: of the new nodes, only a person's radio (a companion) is announced.
    /// `sound`: the signal they ring with (`signal_<id>.wav`), none for quiet ones.
    func configure(messages: Bool, nodes: Bool, people: Bool, sound: String?) {
        UserDefaults.standard.set(messages, forKey: "meshnet.watch.messages")
        UserDefaults.standard.set(nodes, forKey: "meshnet.watch.nodes")
        UserDefaults.standard.set(people, forKey: "meshnet.watch.people")
        UserDefaults.standard.set(sound ?? "", forKey: "meshnet.watch.sound")
    }

    /// The watch's own notices ring with the page's signal; the system's sound until the page has said.
    private func sound() -> UNNotificationSound? {
        guard let name = UserDefaults.standard.string(forKey: "meshnet.watch.sound") else { return .default }
        return name.isEmpty ? nil : UNNotificationSound(named: UNNotificationSoundName(name))
    }

    private func wants(_ key: String) -> Bool {
        UserDefaults.standard.object(forKey: "meshnet.watch.\(key)") as? Bool ?? true
    }

    @objc private func wentToBackground() {
        inBackground = true
        waiting = 0
        attach()
    }

    @objc private func cameToFront() {
        inBackground = false
        waiting = 0
        // The page reads the queue now and shows the messages themselves.
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [MeshWatch.waitingId])
        center.getPendingNotificationRequests { requests in
            center.removePendingNotificationRequests(withIdentifiers: requests.map(\.identifier).filter { $0.hasPrefix("meshnet.") })
        }
    }

    /// The page connected to this radio, or let go of its radio (`nil`).
    func follow(_ id: UUID?) {
        guard id != followed else { return }
        followed = id
        release()
        if inBackground { attach() }
    }

    /// Drops the watch's own hold on the link. A hold the page no longer has
    /// would keep that radio connected, and a connect request is never given
    /// up: iOS would connect again whenever the radio came back.
    private func release() {
        guard let peripheral else { return }
        self.peripheral = nil
        central?.cancelPeripheralConnection(peripheral)
    }

    /// The page announced something itself (its tag: `c:<conversation>` or
    /// `n:<key hex>`), so the watch's notice for it is withdrawn, shown or not.
    func announced(tag: String) {
        let id: String
        if tag.hasPrefix("c:") {
            id = MeshWatch.waitingId
            waiting = 0
        } else if tag.hasPrefix("n:") {
            id = MeshWatch.nodeId(String(tag.dropFirst(2).prefix(16)))
            pageAnnounced = pageAnnounced.filter { Date().timeIntervalSince($0.value) < 60 }
            pageAnnounced[id] = Date()
        } else {
            return
        }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }

    private static func nodeId(_ keyHex: String) -> String {
        "meshnet.node.\(keyHex)"
    }

    /// Finds the radio the plugin is connected to and subscribes alongside it.
    private func attach() {
        guard let central, central.state == .poweredOn, let followed else { return }
        if let peripheral, peripheral.state == .connected { return }
        // Only while the plugin holds the link: a connect to a radio that is
        // not connected would wait for it for as long as the app runs.
        let connected = central.retrieveConnectedPeripherals(withServices: [MeshWatch.service])
        guard let radio = connected.first(where: { $0.identifier == followed }) else { return }
        peripheral = radio
        radio.delegate = self
        // Each central manager connects on its own terms; to one the system
        // is already connected to, this answers at once and changes nothing.
        central.connect(radio, options: nil)
    }

    private func handle(_ frame: Data) {
        guard inBackground, let code = frame.first else { return }
        switch code {
        case MeshWatch.msgWaiting:
            guard wants("messages") else { return }
            waiting += 1
            post(id: MeshWatch.waitingId, title: waiting == 1 ? "New message" : "\(waiting) new messages", body: "Open Ommesh to read.")
        case MeshWatch.newAdvert:
            // code, public key (32), type, flags, path length, path (64), name (32), ...
            guard wants("nodes"), frame.count >= 132 else { return }
            let bytes = [UInt8](frame)
            if UserDefaults.standard.bool(forKey: "meshnet.watch.people"), bytes[33] != 1 { return }
            let kind = [1: "contact", 2: "repeater", 3: "room", 4: "sensor"][Int(bytes[33])] ?? "node"
            let name = String(decoding: bytes[100..<132].prefix { $0 != 0 }, as: UTF8.self)
            let key = bytes[1..<9].map { String(format: "%02x", $0) }.joined()
            let id = MeshWatch.nodeId(key)
            if let at = pageAnnounced[id], Date().timeIntervalSince(at) < 60 { return }
            post(id: id, title: "New \(kind): \(name.isEmpty ? key : name)", body: "Heard for the first time.")
        default:
            return
        }
    }

    private func post(id: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = sound()
        // Another request with the same id replaces this one and starts the wait again.
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: MeshWatch.grace, repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }
}

extension MeshWatch: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn, inBackground { attach() }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([MeshWatch.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        if peripheral == self.peripheral { self.peripheral = nil }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if peripheral == self.peripheral { self.peripheral = nil }
    }
}

extension MeshWatch: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] where service.uuid == MeshWatch.service {
            peripheral.discoverCharacteristics([MeshWatch.tx], for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for characteristic in service.characteristics ?? [] where characteristic.uuid == MeshWatch.tx {
            peripheral.setNotifyValue(true, for: characteristic)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let value = characteristic.value else { return }
        handle(value)
    }
}

/// One of the page's own notices (`post`), as `lib/notify.ts` sends it.
struct PageNotice {
    let id: Int
    let tag: String
    let title: String
    let body: String
    /// `signal_<id>.wav` in Library/Sounds, or none for a quiet notice.
    let sound: String?
    /// Whose circle it shows, PNG.
    let avatar: Data?
    /// The conversation: title, group, avatar (base64), lines [{ sender, text, at }], people { name: base64 }.
    let thread: JSObject?
}

/// The page's notices, drawn here so they can show who wrote (gh #25), and the app's signal.
extension MeshWatch {
    /// The signals ship in the web build (`public/sounds`); a notice's sound must be in the app's
    /// bundle root or in Library/Sounds, so they are copied there, once per build.
    static func installSounds() {
        let files = FileManager.default
        guard let from = Bundle.main.resourceURL?.appendingPathComponent("public/sounds"),
              let library = files.urls(for: .libraryDirectory, in: .userDomainMask).first,
              let names = try? files.contentsOfDirectory(atPath: from.path) else { return }
        let to = library.appendingPathComponent("Sounds")
        try? files.createDirectory(at: to, withIntermediateDirectories: true)
        for name in names where name.hasSuffix(".wav") {
            let source = from.appendingPathComponent(name)
            let target = to.appendingPathComponent(name)
            let size = { (url: URL) in (try? files.attributesOfItem(atPath: url.path)[.size] as? Int) ?? -1 }
            if size(source) == size(target) { continue }
            try? files.removeItem(at: target)
            try? files.copyItem(at: source, to: target)
        }
    }

    /// Posts the page's notice now, in place of the one out with its id. A conversation's is a
    /// communication notice: the writer's circle stands where the app's icon would, the app's icon
    /// a badge on it, as Messages and Telegram draw theirs. Where iOS refuses that (without the
    /// Communication Notifications entitlement), it is a plain notice with the circle as its picture.
    static func show(_ notice: PageNotice, done: @escaping (Error?) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = notice.sound.map { UNNotificationSound(named: UNNotificationSoundName($0)) }
        content.threadIdentifier = notice.tag
        // Where LocalNotifications keeps a notice's extra: its tap listener hands the tag to the page.
        content.userInfo = ["cap_extra": ["tag": notice.tag]]

        var shown: UNNotificationContent = content
        if let thread = notice.thread, let styled = communication(content, tag: notice.tag, thread: thread) {
            shown = styled
        } else if let avatar = notice.avatar, let picture = picture(avatar, id: notice.id) {
            content.attachments = [picture]
        }
        let request = UNNotificationRequest(identifier: String(notice.id), content: shown, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: done)
    }

    private static func communication(_ content: UNMutableNotificationContent, tag: String, thread: JSObject) -> UNNotificationContent? {
        let title = thread["title"] as? String ?? ""
        let group = thread["group"] as? Bool ?? false
        let lines = (thread["lines"] as? [Any] ?? []).compactMap { $0 as? JSObject }
        let people = thread["people"] as? JSObject ?? [:]
        let image = { (base64: Any?) in (base64 as? String).flatMap { Data(base64Encoded: $0) }.map { INImage(imageData: $0) } }
        let person = { (name: String) in
            INPerson(personHandle: INPersonHandle(value: name, type: .unknown), nameComponents: nil, displayName: name, image: image(people[name]), contactIdentifier: nil, customIdentifier: name)
        }
        let sender = person(lines.last?["sender"] as? String ?? title)
        let me = INPerson(personHandle: INPersonHandle(value: "me", type: .unknown), nameComponents: nil, displayName: nil, image: nil, contactIdentifier: nil, customIdentifier: "me", isMe: true)
        let intent = INSendMessageIntent(
            recipients: group ? [me, sender] : [me],
            outgoingMessageType: .outgoingMessageText,
            content: content.body,
            speakableGroupName: group ? INSpeakableString(spokenPhrase: title) : nil,
            conversationIdentifier: tag,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )
        if group, let chat = image(thread["avatar"]) {
            intent.setImage(chat, forParameterNamed: \INSendMessageIntent.speakableGroupName)
        }
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate(completion: nil)
        return try? content.updating(from: intent)
    }

    /// The circle as the notice's picture, from a file the notification centre takes over.
    private static func picture(_ png: Data, id: Int) -> UNNotificationAttachment? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("notice-\(id)-\(UUID().uuidString).png")
        guard (try? png.write(to: url)) != nil else { return nil }
        return try? UNNotificationAttachment(identifier: "avatar", url: url, options: nil)
    }

    private static var sounds: [String: SystemSoundID] = [:]

    /// The signal for the page's banner, as an alert sound: the silent switch turns it into a buzz.
    static func chime(_ signal: String) {
        let name = "signal_\(signal)"
        if sounds[name] == nil {
            guard let url = Bundle.main.resourceURL?.appendingPathComponent("public/sounds/\(name).wav") else { return }
            var id: SystemSoundID = 0
            guard AudioServicesCreateSystemSoundID(url as CFURL, &id) == kAudioServicesNoError else { return }
            sounds[name] = id
        }
        if let id = sounds[name] { AudioServicesPlayAlertSound(id) }
    }
}

/// The page's way to tell the watch which notices the reader wants,
/// `configure({ messages, nodes, people })`, which it has just announced itself,
/// `announced({ tag })`, and which radio it is connected to,
/// `follow({ deviceId })` (none without one). `openSettings()` opens the
/// system's notification settings for the app, where sound and quiet hours are.
/// `post(notice)` draws one of the page's own notices, with who wrote it, and
/// `chime({ signal })` plays the signal for the page's banner.
@objc(MeshWatchPlugin)
final class MeshWatchPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MeshWatchPlugin"
    let jsName = "MeshWatch"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "announced", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "follow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chime", returnType: CAPPluginReturnPromise),
    ]

    @objc func configure(_ call: CAPPluginCall) {
        MeshWatch.shared.configure(messages: call.getBool("messages") ?? true, nodes: call.getBool("nodes") ?? true, people: call.getBool("people") ?? false, sound: call.getString("sound"))
        call.resolve()
    }

    @objc func announced(_ call: CAPPluginCall) {
        let tag = call.getString("tag") ?? ""
        // The watch's state belongs to the main queue, where its central manager delivers.
        DispatchQueue.main.async {
            MeshWatch.shared.announced(tag: tag)
            call.resolve()
        }
    }

    @objc func follow(_ call: CAPPluginCall) {
        let id = call.getString("deviceId").flatMap { UUID(uuidString: $0) }
        DispatchQueue.main.async {
            MeshWatch.shared.follow(id)
            call.resolve()
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // The app's notification page from iOS 16; before it, the app's settings, one tap away from it.
            let page: String
            if #available(iOS 16.0, *) {
                page = UIApplication.openNotificationSettingsURLString
            } else {
                page = UIApplication.openSettingsURLString
            }
            if let url = URL(string: page) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    @objc func post(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.reject("A notice needs an id")
            return
        }
        let notice = PageNotice(
            id: id,
            tag: call.getString("tag") ?? "",
            title: call.getString("title") ?? "",
            body: call.getString("body") ?? "",
            sound: call.getString("sound"),
            avatar: call.getString("avatar").flatMap { Data(base64Encoded: $0) },
            thread: call.getObject("thread")
        )
        MeshWatch.show(notice) { error in
            if let error {
                call.reject("Could not show the notice", nil, error)
            } else {
                call.resolve()
            }
        }
    }

    @objc func chime(_ call: CAPPluginCall) {
        let signal = call.getString("signal") ?? "chirp"
        DispatchQueue.main.async {
            MeshWatch.chime(signal)
            call.resolve()
        }
    }
}
