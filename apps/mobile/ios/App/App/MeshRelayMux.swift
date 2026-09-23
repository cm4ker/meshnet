import Foundation

/// Who talks to the radio through the relay: the page in this app, and a
/// computer connected to the phone.
enum RelayClient: String, CaseIterable {
    case page
    case computer
}

/// One radio, two clients, and the rules that let them share it.
///
/// The firmware answers one command at a time, in order, and its answers do
/// not say which command they belong to. So commands wait in one queue and go
/// to the radio one at a time; every answer goes to whoever sent the command
/// in flight, and the next command goes when the answer is complete. Pushes
/// (codes 0x80 and up) go to both.
///
/// Messages are the one thing the two cannot share as the firmware has them:
/// the radio keeps one queue, and whoever reads a message takes it. So the
/// relay reads the queue itself, whenever the radio says a message is waiting,
/// and keeps a copy for each client in an inbox. A client's "next message"
/// is answered from its inbox without asking the radio, and a client whose
/// inbox fills is told a message is waiting, as the radio would tell it.
///
/// What one sends, the other should show too, and the radio tells nobody but
/// the sender. So a text the radio took from one is passed to the other as a
/// `mirror` push the app reads (`Push.Mirror` in the client): the command and
/// the radio's answer. One for a client that is away waits in its inbox, and
/// goes out as a push ahead of the next message it reads.
///
/// No Bluetooth here: the owner moves the bytes (`toRadio`, `toClient`) and
/// runs the timers (`after`), so this can be tested without a radio.
final class RelayMux {
    // Command, answer and push codes, as the companion firmware numbers them.
    static let cmdSendTxtMsg: UInt8 = 2
    static let cmdSendChannelTxtMsg: UInt8 = 3
    static let cmdGetContacts: UInt8 = 4
    static let cmdSyncNextMessage: UInt8 = 10
    static let cmdReboot: UInt8 = 19
    static let cmdSendTelemetryReq: UInt8 = 39
    static let cmdFactoryReset: UInt8 = 51
    static let respOk: UInt8 = 0
    static let respErr: UInt8 = 1
    static let respSent: UInt8 = 6
    static let respEndOfContacts: UInt8 = 4
    static let respNoMoreMessages: UInt8 = 10
    static let messageCodes: Set<UInt8> = [7, 8, 16, 17, 27]
    static let pushMsgWaiting: UInt8 = 0x83
    /// The app's own, not the firmware's: what the other client sent.
    static let pushMirror: UInt8 = 0xF0

    /// Messages kept per client at most; the oldest go first.
    static let inboxLimit = 500

    var toRadio: (Data) -> Void = { _ in }
    var toClient: (RelayClient, Data) -> Void = { _, _ in }
    /// Runs the block after a delay, on the queue that calls this object.
    var after: (TimeInterval, @escaping () -> Void) -> Void = { _, _ in }
    /// The inboxes changed: the owner saves them.
    var inboxesChanged: () -> Void = {}

    private enum Source: Equatable {
        case client(RelayClient)
        /// The relay's own reading of the message queue.
        case relay
    }

    private struct Command {
        let source: Source
        let frame: Data
        /// Called once the command is written to the radio.
        let dispatched: (() -> Void)?
    }

    private var attached = Set<RelayClient>()
    private var queue: [Command] = []
    private var inFlight: Command?
    /// Bumped per command sent, so a timer for an answered command does nothing.
    private var flight = 0
    private var radioReady = false
    private var draining = false
    private var drainAgain = false
    private(set) var inboxes: [RelayClient: [Data]] = [:]

    init(inboxes: [RelayClient: [Data]] = [:]) {
        self.inboxes = inboxes
    }

    // MARK: clients

    func attach(_ client: RelayClient) {
        attached.insert(client)
        // Messages kept while it was away.
        if !(inboxes[client] ?? []).isEmpty { toClient(client, Data([RelayMux.pushMsgWaiting])) }
    }

    /// Its waiting commands are dropped; one in flight is still answered, to nobody.
    func detach(_ client: RelayClient) {
        attached.remove(client)
        let dropped = queue.filter { $0.source == .client(client) }
        queue.removeAll { $0.source == .client(client) }
        for command in dropped { command.dispatched?() }
    }

    /// A frame a client wrote. `dispatched` is called when it reaches the radio,
    /// which for "next message" is at once, from the inbox.
    func fromClient(_ client: RelayClient, _ frame: Data, dispatched: (() -> Void)? = nil) {
        guard let code = frame.first else {
            dispatched?()
            return
        }
        if code == RelayMux.cmdSyncNextMessage {
            dispatched?()
            answerFromInbox(client)
            return
        }
        queue.append(Command(source: .client(client), frame: frame, dispatched: dispatched))
        pump()
    }

    /// Mirrors kept for it go out as pushes first; then the next message is the answer.
    private func answerFromInbox(_ client: RelayClient) {
        var inbox = inboxes[client] ?? []
        var answer = Data([RelayMux.respNoMoreMessages])
        var pushes: [Data] = []
        while !inbox.isEmpty {
            let frame = inbox.removeFirst()
            if frame.first == RelayMux.pushMirror {
                pushes.append(frame)
            } else {
                answer = frame
                break
            }
        }
        if inbox.count != (inboxes[client]?.count ?? 0) {
            inboxes[client] = inbox
            inboxesChanged()
        }
        for push in pushes { toClient(client, push) }
        toClient(client, answer)
    }

    // MARK: the radio

    func radioUp() {
        radioReady = true
        // Whatever arrived while nobody read the queue.
        drain()
        pump()
    }

    /// A command in flight is lost with the link; its sender times out on its own.
    func radioDown() {
        radioReady = false
        if inFlight?.source == .relay { draining = false }
        inFlight = nil
        flight += 1
    }

    func fromRadio(_ frame: Data) {
        guard let code = frame.first else { return }
        if code >= 0x80 {
            if code == RelayMux.pushMsgWaiting {
                drain()
            } else {
                for client in RelayClient.allCases where attached.contains(client) { toClient(client, frame) }
            }
            return
        }
        guard let command = inFlight else { return } // late, for a command given up on
        switch command.source {
        case .client(let client):
            if attached.contains(client) { toClient(client, frame) }
            mirror(command.frame, answer: frame, from: client)
        case .relay:
            if RelayMux.messageCodes.contains(code) {
                keep(frame)
                queue.append(Command(source: .relay, frame: Data([RelayMux.cmdSyncNextMessage]), dispatched: nil))
            } else {
                draining = false
                if drainAgain {
                    drainAgain = false
                    drain()
                }
            }
        }
        if RelayMux.isComplete(command.frame, answer: code) {
            finish()
        } else {
            arm(command) // a stream: each frame restarts the wait
        }
    }

    // MARK: the queue

    private func drain() {
        if draining {
            drainAgain = true
            return
        }
        draining = true
        queue.append(Command(source: .relay, frame: Data([RelayMux.cmdSyncNextMessage]), dispatched: nil))
        pump()
    }

    private func keep(_ message: Data) {
        for client in RelayClient.allCases {
            add(message, to: client)
            if attached.contains(client) { toClient(client, Data([RelayMux.pushMsgWaiting])) }
        }
        inboxesChanged()
    }

    /// A text the radio took from one client, told to the other.
    private func mirror(_ command: Data, answer: Data, from sender: RelayClient) {
        let taken: Bool
        switch command.first {
        case RelayMux.cmdSendTxtMsg: taken = answer.first == RelayMux.respSent
        case RelayMux.cmdSendChannelTxtMsg: taken = answer.first == RelayMux.respOk
        default: taken = false
        }
        guard taken, command.count < 256 else { return }
        var frame = Data([RelayMux.pushMirror, UInt8(command.count)])
        frame.append(command)
        frame.append(answer)
        var kept = false
        for client in RelayClient.allCases where client != sender {
            if attached.contains(client) {
                toClient(client, frame)
            } else {
                add(frame, to: client)
                kept = true
            }
        }
        if kept { inboxesChanged() }
    }

    private func add(_ frame: Data, to client: RelayClient) {
        var inbox = inboxes[client] ?? []
        inbox.append(frame)
        if inbox.count > RelayMux.inboxLimit { inbox.removeFirst(inbox.count - RelayMux.inboxLimit) }
        inboxes[client] = inbox
    }

    private func pump() {
        guard radioReady, inFlight == nil, !queue.isEmpty else { return }
        let command = queue.removeFirst()
        inFlight = command
        toRadio(command.frame)
        command.dispatched?()
        arm(command)
    }

    private func finish() {
        inFlight = nil
        flight += 1
        pump()
    }

    private func arm(_ command: Command) {
        flight += 1
        let mine = flight
        let (wait, silent) = RelayMux.patience(command.frame)
        after(wait) { [weak self] in
            guard let self, self.flight == mine, self.inFlight != nil else { return }
            if command.source == .relay { self.draining = false }
            if !silent { NSLog("MeshRelay: command %d got no answer", Int(command.frame.first ?? 0)) }
            self.finish()
        }
    }

    /// How long a command may wait for its answer, and whether the radio answers it at all.
    static func patience(_ frame: Data) -> (TimeInterval, Bool) {
        switch frame.first {
        case cmdReboot: return (1.5, true)
        case cmdFactoryReset: return (3, true)
        // About this radio (no key after the code and three zeros): only a push answers it.
        case cmdSendTelemetryReq where frame.count <= 4: return (0.3, true)
        case cmdGetContacts: return (20, false)
        default: return (8, false)
        }
    }

    /// Whether `answer` is a command's last frame: an error always is, and so is
    /// any single answer; only the contact list comes as a stream.
    static func isComplete(_ command: Data, answer: UInt8) -> Bool {
        if answer == respErr { return true }
        if command.first == cmdGetContacts { return answer == respEndOfContacts }
        return true
    }
}
