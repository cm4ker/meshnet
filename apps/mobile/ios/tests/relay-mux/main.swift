import Foundation

// Checks for `RelayMux`, run on a Mac by `tests/run.sh`: the mux is compiled
// with this file as a plain program, no Xcode project and no radio.

var failures = 0

func check(_ condition: Bool, _ what: String, line: Int = #line) {
    if !condition {
        failures += 1
        print("FAIL line \(line): \(what)")
    }
}

func bytes(_ values: UInt8...) -> Data { Data(values) }

/// A mux wired to lists, with timers run by hand.
final class Rig {
    let mux: RelayMux
    var radio: [Data] = []
    var got: [RelayClient: [Data]] = [.page: [], .computer: []]
    var timers: [(TimeInterval, () -> Void)] = []

    init(inboxes: [RelayClient: [Data]] = [:]) {
        mux = RelayMux(inboxes: inboxes)
        mux.toRadio = { [unowned self] in self.radio.append($0) }
        mux.toClient = { [unowned self] client, frame in self.got[client, default: []].append(frame) }
        mux.after = { [unowned self] delay, block in self.timers.append((delay, block)) }
    }

    /// Fires every timer set so far.
    func timeout() {
        let due = timers
        timers = []
        for (_, block) in due { block() }
    }

    func clear() {
        radio = []
        got = [.page: [], .computer: []]
    }
}

let sync = bytes(10)
let noMore = bytes(10)
let ok = bytes(0)
let message = bytes(16, 1, 2, 3)

// Up with an empty queue: the relay reads it once and forwards nothing.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.radioUp()
    check(rig.radio == [sync], "reads the radio's queue on start")
    rig.mux.fromRadio(noMore)
    check(rig.got[.page]!.isEmpty, "the relay's own answer goes to nobody")
}

// Commands from both go one at a time, and each answer to its sender.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.attach(.computer)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.clear()
    rig.mux.fromClient(.page, bytes(22, 3))
    rig.mux.fromClient(.computer, bytes(5))
    check(rig.radio == [bytes(22, 3)], "only the first command goes out")
    rig.mux.fromRadio(bytes(13, 9))
    check(rig.got[.page] == [bytes(13, 9)], "the answer goes to the page")
    check(rig.got[.computer]!.isEmpty, "not to the computer")
    check(rig.radio == [bytes(22, 3), bytes(5)], "then the computer's command goes out")
    rig.mux.fromRadio(bytes(9, 1, 2, 3, 4))
    check(rig.got[.computer] == [bytes(9, 1, 2, 3, 4)], "its answer goes to the computer")
}

// The contact list is a stream: the next command waits for its end.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.attach(.computer)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.clear()
    rig.mux.fromClient(.computer, bytes(4))
    rig.mux.fromClient(.page, bytes(20))
    rig.mux.fromRadio(bytes(2, 2, 0, 0, 0))
    rig.mux.fromRadio(bytes(3, 0xaa))
    check(rig.radio == [bytes(4)], "waits while contacts arrive")
    rig.mux.fromRadio(bytes(3, 0xbb))
    rig.mux.fromRadio(bytes(4, 0, 0, 0, 0))
    check(rig.got[.computer]!.count == 4, "the computer gets the whole stream")
    check(rig.radio == [bytes(4), bytes(20)], "the page's command goes after the end")
}

// An error ends a stream too.
do {
    let rig = Rig()
    rig.mux.attach(.computer)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.clear()
    rig.mux.fromClient(.computer, bytes(4))
    rig.mux.fromClient(.computer, bytes(5))
    rig.mux.fromRadio(bytes(1, 2))
    check(rig.radio == [bytes(4), bytes(5)], "an error is a whole answer")
}

// Pushes go to both; the radio's own "message waiting" goes to neither.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.attach(.computer)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.clear()
    rig.mux.fromRadio(bytes(0x82, 1, 2, 3, 4))
    check(rig.got[.page] == [bytes(0x82, 1, 2, 3, 4)] && rig.got[.computer] == [bytes(0x82, 1, 2, 3, 4)], "a push reaches both")
    rig.mux.fromRadio(bytes(0x83))
    check(rig.radio == [sync], "message waiting makes the relay read the queue")
    check(!rig.got[.page]!.contains(bytes(0x83)), "and is not passed on as it is")
}

// A message read by the relay lands in both inboxes; each reads its own copy.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.attach(.computer)
    rig.mux.radioUp()
    rig.mux.fromRadio(message)
    check(rig.got[.page] == [bytes(0x83)] && rig.got[.computer] == [bytes(0x83)], "both are told a message waits")
    check(rig.radio == [sync, sync], "the relay reads on")
    rig.mux.fromRadio(noMore)
    rig.clear()
    rig.mux.fromClient(.page, sync)
    check(rig.got[.page] == [message], "the page reads its copy")
    rig.mux.fromClient(.page, sync)
    check(rig.got[.page] == [message, noMore], "then nothing more")
    rig.mux.fromClient(.computer, sync)
    check(rig.got[.computer] == [message], "the computer still has its copy")
    check(rig.radio.isEmpty, "none of that asks the radio")
}

// A computer away keeps its copies; told of them when it comes back.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.radioUp()
    rig.mux.fromRadio(message)
    rig.mux.fromRadio(noMore)
    check(rig.got[.computer]!.isEmpty, "an absent computer is told nothing")
    rig.mux.attach(.computer)
    check(rig.got[.computer] == [bytes(0x83)], "and is told when it attaches")
    let saved = Rig(inboxes: rig.mux.inboxes)
    saved.mux.attach(.computer)
    check(saved.got[.computer] == [bytes(0x83)], "the inboxes survive a restart")
}

// A "message waiting" during a read makes one more pass after it.
do {
    let rig = Rig()
    rig.mux.radioUp()
    rig.mux.fromRadio(bytes(0x83))
    rig.mux.fromRadio(noMore)
    check(rig.radio == [sync, sync], "reads again after a push mid-read")
    rig.mux.fromRadio(noMore)
    check(rig.radio.count == 2, "and then stops")
}

// A command the radio never answers is given up on, and the queue moves.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.clear()
    rig.timers = []
    rig.mux.fromClient(.page, bytes(19))
    rig.mux.fromClient(.page, bytes(5))
    check(RelayMux.patience(bytes(19)).0 < 2, "a reboot is not waited on long")
    rig.timeout()
    check(rig.radio == [bytes(19), bytes(5)], "the next command goes after the timeout")
    rig.mux.fromRadio(bytes(9, 0, 0, 0, 0))
    check(rig.got[.page] == [bytes(9, 0, 0, 0, 0)], "and gets its answer")
}

// A stale timer does nothing to the next command.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.timers = []
    rig.clear()
    rig.mux.fromClient(.page, bytes(5))
    rig.mux.fromRadio(bytes(9, 0, 0, 0, 0))
    rig.mux.fromClient(.page, bytes(20))
    rig.mux.fromClient(.page, bytes(22))
    let first = rig.timers.removeFirst()
    first.1()
    check(rig.radio == [bytes(5), bytes(20)], "the old command's timer leaves the new one waiting")
}

// Commands wait while the radio is down; one in flight is dropped with it.
do {
    let rig = Rig()
    rig.mux.attach(.computer)
    var sent = false
    rig.mux.fromClient(.computer, bytes(5), dispatched: { sent = true })
    check(rig.radio.isEmpty && !sent, "nothing goes before the radio is up")
    rig.mux.radioUp()
    check(rig.radio == [bytes(5)] && sent, "the command goes once it is up, and its sender hears it went")
    rig.mux.fromRadio(bytes(9, 0, 0, 0, 0))
    check(rig.radio == [bytes(5), sync], "then the relay reads the queue")
    rig.mux.fromRadio(noMore)
    rig.mux.fromClient(.computer, bytes(20))
    rig.clear()
    rig.mux.radioDown()
    rig.mux.fromRadio(bytes(9, 0, 0, 0, 0))
    check(rig.got[.computer]!.isEmpty, "an answer after the drop belongs to nothing")
}

// A detached client's waiting commands are dropped.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.attach(.computer)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.clear()
    rig.mux.fromClient(.page, bytes(5))
    rig.mux.fromClient(.computer, bytes(20))
    rig.mux.fromClient(.page, bytes(22))
    rig.mux.detach(.computer)
    rig.mux.fromRadio(bytes(9, 0, 0, 0, 0))
    check(rig.radio == [bytes(5), bytes(22)], "the computer's command never goes")
}

// A text one sends is told to the other, with the radio's answer.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.attach(.computer)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.clear()
    let dm = bytes(2, 0, 0, 1, 2, 3, 4, 9, 9, 9, 9, 9, 9, 104, 105)
    let sent = bytes(6, 0, 7, 7, 7, 7, 0xd0, 7, 0, 0)
    rig.mux.fromClient(.page, dm)
    rig.mux.fromRadio(sent)
    check(rig.got[.page] == [sent], "the sender gets the answer")
    var mirror = bytes(0xF0, UInt8(dm.count))
    mirror.append(dm)
    mirror.append(sent)
    check(rig.got[.computer] == [mirror], "the other gets the command and the answer")
    rig.clear()
    let channel = bytes(3, 0, 1, 1, 2, 3, 4, 104, 105)
    rig.mux.fromClient(.computer, channel)
    rig.mux.fromRadio(ok)
    check(rig.got[.page]!.first == 0xF0, "a channel text too, on OK")
    rig.clear()
    rig.mux.fromClient(.computer, channel)
    rig.mux.fromRadio(bytes(1, 2))
    check(rig.got[.page]!.isEmpty, "not one the radio refused")
    rig.mux.fromClient(.computer, bytes(5))
    rig.mux.fromRadio(bytes(9, 0, 0, 0, 0))
    check(rig.got[.page]!.isEmpty, "nor any other command")
}

// One for a client that is away waits, and goes ahead of its next message.
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.mux.fromClient(.page, bytes(3, 0, 0, 1, 2, 3, 4, 104))
    rig.mux.fromRadio(ok)
    rig.mux.fromRadio(bytes(0x83))
    rig.mux.fromRadio(message)
    rig.mux.fromRadio(noMore)
    rig.mux.attach(.computer)
    check(rig.got[.computer] == [bytes(0x83)], "the computer is told something waits")
    rig.mux.fromClient(.computer, sync)
    check(rig.got[.computer]!.count == 3 && rig.got[.computer]![1].first == 0xF0 && rig.got[.computer]![2] == message, "the mirror as a push, then the message")
    rig.mux.fromClient(.computer, sync)
    check(rig.got[.computer]!.last == noMore, "then nothing more")
}

// Only mirrors waiting: pushed, and the answer is "no more".
do {
    let rig = Rig()
    rig.mux.attach(.page)
    rig.mux.radioUp()
    rig.mux.fromRadio(noMore)
    rig.mux.fromClient(.page, bytes(3, 0, 0, 1, 2, 3, 4, 104))
    rig.mux.fromRadio(ok)
    rig.mux.attach(.computer)
    rig.clear()
    rig.mux.fromClient(.computer, sync)
    check(rig.got[.computer]!.count == 2 && rig.got[.computer]![0].first == 0xF0 && rig.got[.computer]![1] == noMore, "a mirror, then no more")
}

// Self telemetry is answered by a push only.
do {
    check(RelayMux.patience(bytes(39, 0, 0, 0)).1, "self telemetry expects no answer")
    check(!RelayMux.patience(bytes(39, 0, 0, 0, 1, 2, 3, 4, 5, 6)).1, "a contact's does")
}

if failures == 0 {
    print("RelayMux: all checks passed")
} else {
    print("RelayMux: \(failures) failed")
    exit(1)
}
