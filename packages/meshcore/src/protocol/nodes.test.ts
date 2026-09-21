import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, fromHex, toHex, utf8 } from "./bytes.js";
import { Cmd, Push, ReqType, TxtType } from "./codes.js";
import * as cmd from "./commands.js";
import { decodeFrame, readAccessList, readAvgMinMax, readNodeStats, readOwnerInfo } from "./frames.js";

const KEY = fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

test("a password longer than the firmware reads is refused here, not cut there", () => {
  assert.throws(() => cmd.sendLogin(KEY, "sixteen-letters!"), /at most 15 bytes/);
  assert.equal(cmd.sendLogin(KEY, "fifteen-letters").length, 1 + 32 + 15);
});

test("a console command is a text message of type CliData", () => {
  const frame = cmd.sendCliCommand(KEY.subarray(0, 6), "3f|get tx");
  assert.equal(frame[0], Cmd.SendTxtMsg);
  assert.equal(frame[1], TxtType.CliData);
  assert.equal(new TextDecoder().decode(frame.subarray(13)), "3f|get tx");
});

test("request bodies: access list, owner info, a sensor's window", () => {
  assert.deepEqual([...cmd.accessListRequest()], [ReqType.GetAccessList, 0, 0]);
  assert.deepEqual([...cmd.ownerInfoRequest()], [ReqType.GetOwnerInfo]);
  assert.deepEqual([...cmd.avgMinMaxRequest(86_400)], [ReqType.GetAvgMinMax, 0x80, 0x51, 0x01, 0x00, 0, 0, 0, 0, 0, 0]);
  const neighbours = cmd.neighboursRequest({ count: 5, offset: 300, order: 3, random: new Uint8Array([9, 9, 9, 9]) });
  assert.deepEqual([...neighbours], [ReqType.GetNeighbours, 0, 5, 0x2c, 0x01, 3, 6, 9, 9, 9, 9]);
});

test("login success names the role in its permissions byte, apart from the admin flag", () => {
  const frame = decodeFrame(new ByteWriter().u8(Push.LoginSuccess).u8(0).bytes(KEY.subarray(0, 6)).u32(1_700_000_000).u8(2).u8(1).toBytes());
  assert.equal(frame.kind, "loginSuccess");
  if (frame.kind !== "loginSuccess") return;
  assert.equal(frame.adminFlag, 0);
  assert.equal(frame.permissions, 2);
  assert.equal(frame.firmwareLevel, 1);
  // The legacy "OK" answer stops after the prefix.
  const legacy = decodeFrame(new ByteWriter().u8(Push.LoginSuccess).u8(0).bytes(KEY.subarray(0, 6)).toBytes());
  assert.equal(legacy.kind === "loginSuccess" && legacy.permissions, null);
});

test("a status body shorter than the common 48 bytes is not read", () => {
  assert.equal(readNodeStats(new Uint8Array(40), "repeater"), null);
});

test("an access list is seven bytes a client", () => {
  const entries = readAccessList(fromHex("aabbccddeeff03" + "11223344556601"));
  assert.deepEqual(
    entries.map((e) => [toHex(e.prefix), e.permissions]),
    [
      ["aabbccddeeff", 3],
      ["112233445566", 1],
    ],
  );
});

test("owner info splits on the first two newlines only", () => {
  assert.deepEqual(readOwnerInfo(utf8("v1.17.1\nRoof North\nNorth group\nask on #test")), {
    firmware: "v1.17.1",
    name: "Roof North",
    owner: "North group\nask on #test",
  });
});

test("a sensor's series summaries use its own widths and scales, big-endian", () => {
  const body = new ByteWriter()
    .u32(1_700_000_000)
    // Channel 1 temperature: signed, two bytes, tenths. -2.5, 17.6, 9.8.
    .u8(1)
    .u8(0x67)
    .bytes(fromHex("ffe7"))
    .bytes(fromHex("00b0"))
    .bytes(fromHex("0062"))
    // Channel 1 voltage: two bytes, hundredths. 3.91, 4.05, 3.97.
    .u8(1)
    .u8(0x74)
    .bytes(fromHex("0187"))
    .bytes(fromHex("0195"))
    .bytes(fromHex("018d"))
    .toBytes();
  const { time, series } = readAvgMinMax(body);
  assert.equal(time, 1_700_000_000);
  assert.deepEqual(series, [
    { channel: 1, lppType: 0x67, min: -2.5, max: 17.6, avg: 9.8 },
    { channel: 1, lppType: 0x74, min: 3.91, max: 4.05, avg: 3.97 },
  ]);
});
