import Capacitor
import CoreBluetooth
import Foundation
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
/// holds: it only subscribes to the radio's TX characteristic and never
/// writes, so the page's own traffic is untouched. Its notices are sent only
/// while the app is in the background; in front, the page does its own.
final class MeshWatch: NSObject {
    static let shared = MeshWatch()

    private static let service = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let tx = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let msgWaiting: UInt8 = 0x83
    private static let newAdvert: UInt8 = 0x8A
    private static let waitingId = "meshnet.waiting"

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var inBackground = false
    private var waiting = 0

    func start() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(wentToBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(cameToFront), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    /// Which notices the reader wants, as the page's two switches say.
    func configure(messages: Bool, nodes: Bool) {
        UserDefaults.standard.set(messages, forKey: "meshnet.watch.messages")
        UserDefaults.standard.set(nodes, forKey: "meshnet.watch.nodes")
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
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [MeshWatch.waitingId])
    }

    /// Finds the radio the plugin is connected to and subscribes alongside it.
    private func attach() {
        guard let central, central.state == .poweredOn else { return }
        if let peripheral, peripheral.state == .connected { return }
        guard let radio = central.retrieveConnectedPeripherals(withServices: [MeshWatch.service]).first else { return }
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
            let kind = [1: "contact", 2: "repeater", 3: "room", 4: "sensor"][Int(bytes[33])] ?? "node"
            let name = String(decoding: bytes[100..<132].prefix { $0 != 0 }, as: UTF8.self)
            let key = bytes[1..<9].map { String(format: "%02x", $0) }.joined()
            post(id: "meshnet.node.\(key)", title: "New \(kind): \(name.isEmpty ? key : name)", body: "Heard for the first time.")
        default:
            return
        }
    }

    private func post(id: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
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

/// The page's way to tell the watch which notices the reader wants:
/// `window.Capacitor.Plugins.MeshWatch.configure({ messages, nodes })`.
@objc(MeshWatchPlugin)
final class MeshWatchPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MeshWatchPlugin"
    let jsName = "MeshWatch"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
    ]

    @objc func configure(_ call: CAPPluginCall) {
        MeshWatch.shared.configure(messages: call.getBool("messages") ?? true, nodes: call.getBool("nodes") ?? true)
        call.resolve()
    }
}
