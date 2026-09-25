//! The few frames the core reads for itself: messages from the radio's queue,
//! and a node heard for the first time. Laid out as
//! `packages/meshcore/src/protocol/frames.ts` reads them.

use crate::codes::*;

/// A message the radio handed over, before its names are known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Received {
    /// From one node: a person, or a room relaying a member's post.
    Direct {
        sender_prefix: [u8; PUB_KEY_PREFIX_SIZE],
        txt_type: u8,
        timestamp: u32,
        /// The author's key prefix, on a room's `SignedPlain` post.
        signer: Option<[u8; 4]>,
        text: String,
    },
    /// On a channel: the text is `<sender>: <text>`, as the firmware puts it on the air.
    Channel {
        index: u8,
        txt_type: u8,
        timestamp: u32,
        text: String,
    },
}

/// A node heard for the first time (`NEW_ADVERT`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Heard {
    pub key: [u8; PUB_KEY_SIZE],
    /// Its advert type: a person's radio, a repeater, a room, a sensor.
    pub kind: u8,
    pub name: String,
}

/// Reads a message frame; `None` for anything else, a short frame, or channel data (no text).
pub fn read_message(frame: &[u8]) -> Option<Received> {
    let (&code, rest) = frame.split_first()?;
    let mut r = Reader(rest);
    match code {
        RESP_CONTACT_MSG_RECV | RESP_CONTACT_MSG_RECV_V3 => {
            if code == RESP_CONTACT_MSG_RECV_V3 {
                r.take(3)?; // SNR, then two reserved bytes
            }
            let sender_prefix = r.take(PUB_KEY_PREFIX_SIZE)?.try_into().ok()?;
            r.take(1)?; // path length
            let txt_type = r.u8()?;
            let timestamp = r.u32()?;
            let signer = if txt_type == TXT_TYPE_SIGNED_PLAIN {
                Some(r.take(4)?.try_into().ok()?)
            } else {
                None
            };
            Some(Received::Direct {
                sender_prefix,
                txt_type,
                timestamp,
                signer,
                text: text(r.0),
            })
        }
        RESP_CHANNEL_MSG_RECV | RESP_CHANNEL_MSG_RECV_V3 => {
            if code == RESP_CHANNEL_MSG_RECV_V3 {
                r.take(3)?;
            }
            let index = r.u8()?;
            r.take(1)?;
            let txt_type = r.u8()?;
            let timestamp = r.u32()?;
            Some(Received::Channel {
                index,
                txt_type,
                timestamp,
                text: text(r.0),
            })
        }
        _ => None,
    }
}

/// Reads a `NEW_ADVERT` push: code, key (32), type, flags, path length, path (64), name (32), ...
pub fn read_new_advert(frame: &[u8]) -> Option<Heard> {
    let (&code, rest) = frame.split_first()?;
    if code != PUSH_NEW_ADVERT {
        return None;
    }
    let mut r = Reader(rest);
    let key = r.take(PUB_KEY_SIZE)?.try_into().ok()?;
    let kind = r.u8()?;
    r.take(2 + MAX_PATH_SIZE)?; // flags, path length, path
    let name = text(r.take(32)?);
    Some(Heard { key, kind, name })
}

/// Text up to the first zero byte, as the firmware pads its fields.
pub fn text(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// A channel message's `<sender>: <text>`, split; no sender when there is no `": "` past the start.
pub fn split_channel_text(text: &str) -> (Option<&str>, &str) {
    match text.find(": ") {
        Some(at) if at > 0 => (Some(&text[..at]), &text[at + 2..]),
        _ => (None, text),
    }
}

/// Lower-case hex, as the page writes keys.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Some(head)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    #[test]
    fn reads_a_direct_message_v3() {
        let f = frame(&[
            &[16, 0xf4, 0, 0],
            &[1, 2, 3, 4, 5, 6],
            &[2, 0],
            &0x6543_2100u32.to_le_bytes(),
            b"hi there",
        ]);
        assert_eq!(
            read_message(&f),
            Some(Received::Direct {
                sender_prefix: [1, 2, 3, 4, 5, 6],
                txt_type: 0,
                timestamp: 0x6543_2100,
                signer: None,
                text: "hi there".into()
            })
        );
    }

    #[test]
    fn reads_the_legacy_frame_and_a_rooms_signed_post() {
        let f = frame(&[
            &[7],
            &[9; 6],
            &[0xff, 2],
            &5u32.to_le_bytes(),
            &[0xaa, 0xbb, 0xcc, 0xdd],
            b"posted\0\0",
        ]);
        assert_eq!(
            read_message(&f),
            Some(Received::Direct {
                sender_prefix: [9; 6],
                txt_type: 2,
                timestamp: 5,
                signer: Some([0xaa, 0xbb, 0xcc, 0xdd]),
                text: "posted".into()
            })
        );
    }

    #[test]
    fn reads_a_channel_message() {
        let f = frame(&[
            &[17, 12, 0, 0, 1, 3, 0],
            &7u32.to_le_bytes(),
            "Wan8: привет".as_bytes(),
        ]);
        assert_eq!(
            read_message(&f),
            Some(Received::Channel {
                index: 1,
                txt_type: 0,
                timestamp: 7,
                text: "Wan8: привет".into()
            })
        );
        let legacy = frame(&[&[8, 2, 0xff, 0], &7u32.to_le_bytes(), b"x"]);
        assert!(matches!(
            read_message(&legacy),
            Some(Received::Channel { index: 2, .. })
        ));
    }

    #[test]
    fn a_short_frame_or_channel_data_is_not_a_message() {
        assert_eq!(read_message(&[16, 0, 0, 0, 1, 2]), None);
        assert_eq!(read_message(&[27, 0, 0, 0, 1, 0, 0, 0, 1, 9]), None);
        assert_eq!(read_message(&[]), None);
    }

    #[test]
    fn reads_a_new_advert() {
        let mut f = vec![PUSH_NEW_ADVERT];
        f.extend((1..=32).collect::<Vec<u8>>());
        f.push(ADV_TYPE_REPEATER);
        f.extend([0u8; 66]);
        let mut name = [0u8; 32];
        name[..6].copy_from_slice(b"Albtrs");
        f.extend(name);
        f.extend([0u8; 16]);
        let heard = read_new_advert(&f).unwrap();
        assert_eq!(heard.key[0], 1);
        assert_eq!(heard.kind, ADV_TYPE_REPEATER);
        assert_eq!(heard.name, "Albtrs");
        assert_eq!(read_new_advert(&f[..120]), None);
    }

    #[test]
    fn splits_channel_text_as_the_page_does() {
        assert_eq!(
            split_channel_text("RM55: hi: there"),
            (Some("RM55"), "hi: there")
        );
        assert_eq!(split_channel_text(": hi"), (None, ": hi"));
        assert_eq!(split_channel_text("no sender"), (None, "no sender"));
    }
}
