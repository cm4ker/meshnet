import Capacitor
import Foundation
import Network

/// A TCP link to a radio on the network: `window.Capacitor.Plugins.MeshTcp`, used
/// by the web client's `transports/capacitorTcp.ts`. Companion firmware built with
/// Wi-Fi listens on a port (5000 unless built otherwise) and speaks the same framed
/// stream as its USB serial; the framing is the client's, this only moves bytes.
///
/// - `open({ host, port, timeout })`: answers `{ id }` once the connection is up.
/// - `write({ id, data })`: `data` is base64.
/// - `close({ id })`.
/// - Events: `data` `{ id, data }` (base64) as bytes arrive, and `closed`
///   `{ id, error? }` when the radio or the network ends a connection that was
///   not closed from here.
///
/// Every connection lives on one serial queue, which is also where the table of
/// them is read and written.
@objc(MeshTcpPlugin)
final class MeshTcpPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MeshTcpPlugin"
    let jsName = "MeshTcp"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "dev.cm4ker.meshnet.tcp")
    private var connections: [String: NWConnection] = [:]

    @objc func open(_ call: CAPPluginCall) {
        guard let host = call.getString("host")?.trimmingCharacters(in: .whitespaces), !host.isEmpty else {
            call.reject("an address is needed")
            return
        }
        let number = call.getInt("port") ?? 5000
        guard number > 0, number < 65536, let port = NWEndpoint.Port(rawValue: UInt16(number)) else {
            call.reject("\(number) is not a port")
            return
        }
        let timeout = call.getDouble("timeout") ?? 10

        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 15
        let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: NWParameters(tls: nil, tcp: tcp))
        let id = UUID().uuidString
        let address = "\(host):\(number)"

        // A connection that cannot be made yet waits rather than fails: the
        // network may come back, or the phone may be showing its Local Network
        // prompt. So it is given until the timeout, and a wait's reason is kept
        // to say why it gave up.
        var settled = false
        var waitingFor: String?
        let settle: (String?) -> Void = { [weak self] error in
            guard let self, !settled else { return }
            settled = true
            if let error {
                connection.cancel()
                call.reject(error)
                return
            }
            self.connections[id] = connection
            call.resolve(["id": id])
            self.receive(id, connection)
        }

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                settle(nil)
            case .waiting(let error):
                waitingFor = error.localizedDescription
            case .failed(let error):
                if settled {
                    self?.dropped(id, error.localizedDescription)
                    connection.cancel()
                } else {
                    settle("\(address): \(error.localizedDescription)")
                }
            default:
                break
            }
        }
        queue.asyncAfter(deadline: .now() + timeout) {
            settle("\(address) did not answer" + (waitingFor.map { ": \($0)" } ?? ""))
        }
        connection.start(queue: queue)
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let data = call.getString("data").flatMap({ Data(base64Encoded: $0) }) else {
            call.reject("write needs an id and base64 data")
            return
        }
        queue.async {
            guard let connection = self.connections[id] else {
                call.reject("not connected")
                return
            }
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve()
                }
            })
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        queue.async {
            self.connections.removeValue(forKey: id)?.cancel()
            call.resolve()
        }
    }

    private func receive(_ id: String, _ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.notifyListeners("data", data: ["id": id, "data": data.base64EncodedString()])
            }
            if let error {
                self.dropped(id, error.localizedDescription)
                connection.cancel()
            } else if isComplete {
                self.dropped(id, "the radio closed the connection")
                connection.cancel()
            } else {
                self.receive(id, connection)
            }
        }
    }

    /// Tells the page about a connection that ended without its asking. One it
    /// closed itself is already out of the table and says nothing.
    private func dropped(_ id: String, _ reason: String) {
        guard connections.removeValue(forKey: id) != nil else { return }
        notifyListeners("closed", data: ["id": id, "error": reason])
    }
}
