import Capacitor
import CoreBluetooth
import Foundation

/// Shares the radio with a computer nearby, through the phone.
///
/// The phone serves the same UART service the radio does (Nordic UART,
/// `6E400001…`), so a computer connects to the phone as if it were the radio,
/// with the client it already has. The page talks to the radio through here
/// too, and `RelayMux` decides whose command goes to the radio when and whose
/// an answer is, so both use the radio at once. The framing is BLE's own, one
/// frame per write or notification.
///
/// It is native because the page sleeps in the background while this has to
/// keep moving bytes: the app has the `bluetooth-central` and
/// `bluetooth-peripheral` background modes, which keep both links up with the
/// phone locked.
///
/// The radio is held by this object's own central manager, on the link the
/// BLE plugin already made. The page's plugin stays connected (it is how the
/// page learns of a drop) but the page's frames come and go through here.
///
/// Both characteristics demand an encrypted link, so a computer has to be
/// paired with the phone first: iOS asks on its own screen.
final class MeshRelay: NSObject {
    static let shared = MeshRelay()

    private static let service = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let rx = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let tx = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let inboxesKey = "meshnet.relay.inboxes"

    /// Told of every change: `{ on, computer }`.
    var onChange: (([String: Any]) -> Void)?
    /// Frames for the page.
    var onPageFrame: ((Data) -> Void)?

    private let mux: RelayMux

    private var server: CBPeripheralManager?
    private var central: CBCentralManager?
    private var served: CBMutableCharacteristic?
    private var published = false
    private var advertName = "Ommesh"

    private var radioId: UUID?
    private var radio: CBPeripheral?
    private var radioRx: CBCharacteristic?

    private var computer: CBCentral?
    /// Notifications iOS had no room for; sent when it says it is ready again.
    private var backlog: [Data] = []

    var isOn: Bool { radioId != nil }

    override init() {
        // The inboxes outlive the app: the radio's copy of a message is gone once the relay has read it.
        let saved = UserDefaults.standard.dictionary(forKey: MeshRelay.inboxesKey) as? [String: [Data]] ?? [:]
        var inboxes: [RelayClient: [Data]] = [:]
        for (name, frames) in saved {
            if let client = RelayClient(rawValue: name) { inboxes[client] = frames }
        }
        mux = RelayMux(inboxes: inboxes)
        super.init()
        mux.toRadio = { [weak self] frame in self?.writeRadio(frame) }
        mux.toClient = { [weak self] client, frame in
            switch client {
            case .computer: self?.toComputer(frame)
            case .page: self?.onPageFrame?(frame)
            }
        }
        mux.after = { delay, block in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: block) }
        mux.inboxesChanged = { [weak self] in self?.saveInboxes() }
    }

    private func saveInboxes() {
        var saved: [String: [Data]] = [:]
        for (client, frames) in mux.inboxes { saved[client.rawValue] = frames }
        UserDefaults.standard.set(saved, forKey: MeshRelay.inboxesKey)
    }

    /// Starts serving, for the radio the page is connected to (the BLE plugin's id).
    func start(radio id: UUID, name: String) {
        advertName = String("Ommesh \(name)".prefix(20))
        if radioId != id {
            releaseRadio()
            radioId = id
        }
        if central == nil {
            central = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        } else {
            attachRadio()
        }
        if server == nil {
            server = CBPeripheralManager(delegate: self, queue: nil, options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
        } else {
            publish()
        }
        changed()
    }

    func stop() {
        radioId = nil
        server?.stopAdvertising()
        server?.removeAllServices()
        published = false
        served = nil
        computer = nil
        backlog = []
        mux.detach(.computer)
        mux.detach(.page)
        releaseRadio()
        changed()
    }

    var state: [String: Any] {
        ["on": isOn, "computer": computer != nil]
    }

    private func changed() {
        onChange?(state)
    }

    // MARK: the page

    func attachPage() {
        mux.attach(.page)
    }

    func detachPage() {
        mux.detach(.page)
    }

    /// `dispatched` is called once the frame has gone to the radio, or been answered here.
    func fromPage(_ frame: Data, dispatched: @escaping () -> Void) {
        guard isOn else {
            dispatched()
            return
        }
        mux.fromClient(.page, frame, dispatched: dispatched)
    }

    // MARK: the computer's side

    private func publish() {
        guard let server, server.state == .poweredOn, isOn else { return }
        if published {
            advertise()
            return
        }
        let rx = CBMutableCharacteristic(type: MeshRelay.rx, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeEncryptionRequired])
        let tx = CBMutableCharacteristic(type: MeshRelay.tx, properties: [.notifyEncryptionRequired], value: nil, permissions: [.readEncryptionRequired])
        let service = CBMutableService(type: MeshRelay.service, primary: true)
        service.characteristics = [rx, tx]
        served = tx
        published = true
        server.add(service)
    }

    /// Only while no computer is connected: this serves one, as the firmware does.
    private func advertise() {
        guard let server, server.state == .poweredOn, isOn, computer == nil, !server.isAdvertising else { return }
        server.startAdvertising([
            CBAdvertisementDataLocalNameKey: advertName,
            CBAdvertisementDataServiceUUIDsKey: [MeshRelay.service],
        ])
    }

    private func toComputer(_ frame: Data) {
        guard computer != nil else { return }
        if !backlog.isEmpty {
            backlog.append(frame)
            return
        }
        send(frame)
    }

    /// False when iOS's queue is full; the frame then waits in the backlog.
    @discardableResult
    private func send(_ frame: Data) -> Bool {
        guard let server, let served, let computer else { return true }
        if frame.count > computer.maximumUpdateValueLength {
            NSLog("MeshRelay: a %d-byte frame does not fit the computer's %d", frame.count, computer.maximumUpdateValueLength)
        }
        if server.updateValue(frame, for: served, onSubscribedCentrals: [computer]) { return true }
        backlog.insert(frame, at: 0)
        return false
    }

    // MARK: the radio's side

    private func attachRadio() {
        guard let central, central.state == .poweredOn, let radioId else { return }
        if let radio, radio.state == .connected || radio.state == .connecting { return }
        let peripheral = central.retrieveConnectedPeripherals(withServices: [MeshRelay.service]).first { $0.identifier == radioId }
            ?? central.retrievePeripherals(withIdentifiers: [radioId]).first
        guard let peripheral else { return }
        radio = peripheral
        radioRx = nil
        peripheral.delegate = self
        // To a radio the system is already connected to this answers at once;
        // to one out of range it waits, which is what a relay that is on wants.
        central.connect(peripheral, options: nil)
    }

    private func releaseRadio() {
        mux.radioDown()
        guard let radio else { return }
        self.radio = nil
        radioRx = nil
        central?.cancelPeripheralConnection(radio)
    }

    /// Only called while the radio is up: the mux holds commands until then.
    private func writeRadio(_ frame: Data) {
        guard let radio, let radioRx, radio.state == .connected else {
            NSLog("MeshRelay: a frame for the radio with no radio")
            return
        }
        // With response, as the page writes: the characteristic demands encryption.
        radio.writeValue(frame, for: radioRx, type: .withResponse)
    }
}

extension MeshRelay: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state == .poweredOn {
            publish()
        } else {
            // A Bluetooth restart takes the published service with it.
            published = false
            served = nil
            if computer != nil {
                computer = nil
                backlog = []
                mux.detach(.computer)
                changed()
            }
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            NSLog("MeshRelay: the service was not published: %@", error.localizedDescription)
            published = false
            return
        }
        advertise()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == MeshRelay.tx else { return }
        computer = central
        backlog = []
        peripheral.stopAdvertising()
        peripheral.setDesiredConnectionLatency(.low, for: central)
        mux.attach(.computer)
        attachRadio()
        changed()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == MeshRelay.tx, central.identifier == computer?.identifier else { return }
        computer = nil
        backlog = []
        mux.detach(.computer)
        advertise()
        changed()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        // A frame longer than the link's MTU comes as a long write, in pieces with offsets.
        var frame = Data()
        for request in requests where request.characteristic.uuid == MeshRelay.rx {
            if let value = request.value { frame.append(value) }
        }
        if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
        if !frame.isEmpty, computer != nil { mux.fromClient(.computer, frame) }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        while !backlog.isEmpty {
            let frame = backlog.removeFirst()
            if !send(frame) { return }
        }
    }
}

extension MeshRelay: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn { attachRadio() }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral == radio else { return }
        peripheral.discoverServices([MeshRelay.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral == radio else { return }
        radio = nil
        radioRx = nil
        mux.radioDown()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral == radio else { return }
        radioRx = nil
        mux.radioDown()
        // Asked again: iOS keeps the request and connects when the radio is back.
        if isOn { central.connect(peripheral, options: nil) }
    }
}

extension MeshRelay: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] where service.uuid == MeshRelay.service {
            peripheral.discoverCharacteristics([MeshRelay.rx, MeshRelay.tx], for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == MeshRelay.rx {
                radioRx = characteristic
            } else if characteristic.uuid == MeshRelay.tx {
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
    }

    /// The radio is up once its TX notifies here: then the waiting commands go.
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral == radio, characteristic.uuid == MeshRelay.tx else { return }
        if let error {
            NSLog("MeshRelay: the radio's TX did not subscribe: %@", error.localizedDescription)
            return
        }
        if characteristic.isNotifying, radioRx != nil { mux.radioUp() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.uuid == MeshRelay.tx, let value = characteristic.value, !value.isEmpty else { return }
        mux.fromRadio(value)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { NSLog("MeshRelay: a write to the radio failed: %@", error.localizedDescription) }
    }
}

/// The page's side of the relay: `start({ deviceId, name })` with the radio
/// the page is connected to, `stop()`, `state()`, and a `state` event
/// `{ on, computer }` whenever a computer comes or goes. While `attach()`ed,
/// the page talks to the radio through here: `send({ data })` (base64),
/// answered once the frame has gone to the radio, and `frame` events `{ data }`.
@objc(MeshRelayPlugin)
final class MeshRelayPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MeshRelayPlugin"
    let jsName = "MeshRelay"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
    ]

    override func load() {
        MeshRelay.shared.onChange = { [weak self] state in
            self?.notifyListeners("state", data: state)
        }
        MeshRelay.shared.onPageFrame = { [weak self] frame in
            self?.notifyListeners("frame", data: ["data": frame.base64EncodedString()])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let id = call.getString("deviceId").flatMap({ UUID(uuidString: $0) }) else {
            call.reject("start needs the radio's deviceId")
            return
        }
        let name = call.getString("name") ?? ""
        DispatchQueue.main.async {
            MeshRelay.shared.start(radio: id, name: name)
            call.resolve(MeshRelay.shared.state)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MeshRelay.shared.stop()
            call.resolve(MeshRelay.shared.state)
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(MeshRelay.shared.state)
        }
    }

    @objc func attach(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MeshRelay.shared.attachPage()
            call.resolve()
        }
    }

    @objc func detach(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MeshRelay.shared.detachPage()
            call.resolve()
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let data = call.getString("data").flatMap({ Data(base64Encoded: $0) }) else {
            call.reject("send needs base64 data")
            return
        }
        DispatchQueue.main.async {
            MeshRelay.shared.fromPage(data) { call.resolve() }
        }
    }
}
