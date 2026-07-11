//! claude-share wire protocol: JSON lines over the host's ssh channel to the relay.
//! A line-for-line port of packages/shared/protocol.js — that file and its tests
//! are the spec; when in doubt, match the JS behavior exactly (shallow validation,
//! drop-don't-crash on malformed input, 10 MB flood cap).
//!
//! Guests speak no protocol — they exchange raw terminal bytes. Only the
//! host<->relay control channel uses these messages.

use serde_json::Value;

/// Canonical message-type strings (the `t` field of every message).
pub mod types {
    pub const HELLO: &str = "hello"; // host->relay: {t, want:'room', secret?, pass?}
    pub const RECLAIM: &str = "reclaim"; // host->relay: {t, code}
    pub const ROOM: &str = "room"; // relay->host: {t, code, webUrl?}
    pub const GONE: &str = "gone"; // relay->host: {t, code}
    pub const REFUSED: &str = "refused"; // relay->host: {t, reason}
    pub const KNOCK: &str = "knock"; // relay->host: {t, id, name, fp, seen}
    pub const ADMIT: &str = "admit"; // host->relay: {t, id}
    pub const DENY: &str = "deny"; // host->relay: {t, id}
    pub const JOINED: &str = "joined"; // relay->host: {t, id}
    pub const LEFT: &str = "left"; // relay->host: {t, id}
    pub const KEY: &str = "key"; // relay->host: {t, id, data} (base64)
    pub const RESIZE: &str = "resize"; // relay->host: {t, id, cols, rows}
    pub const SCREEN: &str = "screen"; // host->relay: {t, data} (broadcast, base64)
    pub const TO: &str = "to"; // host->relay: {t, id, data} (one guest, base64)
    pub const DROP: &str = "drop"; // host->relay: {t, id, ban}
    pub const END: &str = "end"; // host->relay: {t}
    pub const STATE: &str = "state"; // host->relay: {t, data:{…}} overlay snapshot
    pub const POINTER: &str = "pointer"; // guest->host via relay: {t, id?, x, y}
    pub const UI: &str = "ui"; // guest->host via relay: {t, id?, action}
}

/// Serialize a message to a newline-terminated JSON byte vector, ready to write
/// to a stream. Mirrors `encode` in protocol.js.
pub fn encode(msg: &Value) -> Vec<u8> {
    let mut out = serde_json::to_vec(msg).unwrap_or_else(|_| b"null".to_vec());
    out.push(b'\n');
    out
}

/// Newline-free buffer cap (10 MB). Real messages are tiny (a full-repaint screen
/// frame is a few KB of base64), so a partial line this large is a peer that never
/// terminates — a memory-exhaustion flood. We drop it rather than grow.
const MAX_BUF: usize = 10 * 1024 * 1024;

/// Stateful, per-connection stream decoder. Feed it raw chunks; it buffers
/// partial lines and returns parsed messages once each line is complete.
/// One instance per ssh channel. Mirrors `Decoder` in protocol.js (buffering at
/// the byte level, so a UTF-8 sequence split across chunks reassembles cleanly).
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the messages completed by this chunk (possibly empty).
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).take(nl).collect();
            let text = String::from_utf8_lossy(&line);
            if text.trim().is_empty() {
                continue;
            }
            // Malformed line: drop it (spec: the relay and host drop anything that
            // fails the check). One bad line must never sever the connection or
            // swallow the valid messages that follow it.
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                out.push(v);
            }
        }
        // Only a newline-free remainder is left now. If it has outgrown the cap,
        // no terminator is coming — clear it so a peer can't exhaust memory.
        if self.buf.len() > MAX_BUF {
            self.buf.clear();
        }
        out
    }
}

/// Stateless one-shot decode of a chunk containing only complete lines (e.g. the
/// output of `encode`). A trailing partial line is ignored.
pub fn decode(chunk: &[u8]) -> Vec<Value> {
    Decoder::new().push(chunk)
}

fn is_str(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(_)))
}
fn is_num(v: Option<&Value>) -> bool {
    // serde_json numbers are always finite, matching JS Number.isFinite on JSON input.
    matches!(v, Some(Value::Number(_)))
}
fn is_obj(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}
fn absent_or_str(v: Option<&Value>) -> bool {
    v.is_none() || is_str(v)
}

/// A {t:'ui'} action — the boundary that lets a browser button drive the host,
/// so it fails closed. Mirrors `isUiAction` in protocol.js.
fn is_ui_action(a: Option<&Value>) -> bool {
    let Some(Value::Object(m)) = a else {
        return false;
    };
    let kind = m.get("kind").and_then(Value::as_str);
    match kind {
        Some("admit") | Some("deny") | Some("kick") | Some("deldraft") => is_str(m.get("id")),
        Some("role") => is_str(m.get("id")) && is_str(m.get("role")),
        Some("command") => is_str(m.get("text")),
        Some("caret") => is_str(m.get("id")) && is_num(m.get("offset")),
        Some("delrange") => is_str(m.get("id")) && is_num(m.get("start")) && is_num(m.get("end")),
        Some("place") => {
            is_str(m.get("id"))
                && (m.get("home") == Some(&Value::Bool(true)) || (is_num(m.get("x")) && is_num(m.get("y"))))
        }
        Some("unqueue") => is_num(m.get("n")),
        Some("scroll") => is_num(m.get("lines")),
        Some("resync") => true,
        _ => false,
    }
}

/// Shallow structural validation of a decoded message. True only for a known type
/// whose required fields are present and correctly typed. The relay and host drop
/// anything that fails this check. Mirrors `validate` in protocol.js.
pub fn validate(msg: &Value) -> bool {
    let Value::Object(m) = msg else {
        return false;
    };
    let t = m.get("t").and_then(Value::as_str);
    match t {
        Some(types::HELLO) => {
            m.get("want").and_then(Value::as_str) == Some("room")
                && absent_or_str(m.get("secret"))
                && absent_or_str(m.get("pass"))
        }
        Some(types::ROOM) => is_str(m.get("code")) && absent_or_str(m.get("webUrl")),
        Some(types::RECLAIM) | Some(types::GONE) => is_str(m.get("code")),
        Some(types::REFUSED) => is_str(m.get("reason")),
        Some(types::KNOCK) => {
            is_str(m.get("id"))
                && is_str(m.get("name"))
                && is_str(m.get("fp"))
                && matches!(m.get("seen"), Some(Value::String(_)) | Some(Value::Bool(_)) | Some(Value::Null))
        }
        Some(types::ADMIT) | Some(types::DENY) | Some(types::JOINED) | Some(types::LEFT) => is_str(m.get("id")),
        Some(types::KEY) | Some(types::TO) => is_str(m.get("id")) && is_str(m.get("data")),
        Some(types::RESIZE) => is_str(m.get("id")) && is_num(m.get("cols")) && is_num(m.get("rows")),
        Some(types::SCREEN) => is_str(m.get("data")),
        Some(types::DROP) => is_str(m.get("id")) && matches!(m.get("ban"), Some(Value::Bool(_))),
        Some(types::END) => true,
        Some(types::STATE) => is_obj(m.get("data")),
        Some(types::POINTER) => is_num(m.get("x")) && is_num(m.get("y")) && absent_or_str(m.get("id")),
        Some(types::UI) => absent_or_str(m.get("id")) && is_ui_action(m.get("action")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encode_round_trips_through_decode() {
        let msgs = vec![
            json!({"t":"hello","want":"room"}),
            json!({"t":"hello","want":"room","secret":"s","pass":"p"}),
            json!({"t":"room","code":"brave-otter","webUrl":"https://claudecollab.org"}),
            json!({"t":"refused","reason":"secret"}),
            json!({"t":"knock","id":"g1","name":"sid","fp":"SHA256:x","seen":null}),
            json!({"t":"key","id":"g1","data":"aGk="}),
            json!({"t":"state","data":{"room":"r","queue":[]}}),
            json!({"t":"end"}),
        ];
        for m in msgs {
            let decoded = decode(&encode(&m));
            assert_eq!(decoded, vec![m.clone()], "round-trip of {m}");
            assert!(validate(&decoded[0]), "round-tripped message validates: {m}");
        }
    }

    #[test]
    fn decoder_buffers_partial_lines_across_pushes() {
        let mut d = Decoder::new();
        let line = encode(&json!({"t":"screen","data":"QUJD"}));
        let (a, b) = line.split_at(7);
        assert!(d.push(a).is_empty(), "no message before the newline");
        let got = d.push(b);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["data"], "QUJD");
    }

    #[test]
    fn decoder_drops_malformed_lines_and_survives() {
        let mut d = Decoder::new();
        let got = d.push(b"{not json}\n\n{\"t\":\"end\"}\n");
        assert_eq!(got, vec![json!({"t":"end"})], "bad + blank lines dropped, good one kept");
    }

    #[test]
    fn decoder_caps_an_unterminated_flood() {
        let mut d = Decoder::new();
        d.push(&vec![b'x'; 11 * 1024 * 1024]); // newline-free flood > MAX_BUF
        let got = d.push(b"{\"t\":\"end\"}\n");
        assert_eq!(got, vec![json!({"t":"end"})], "a following valid line still parses");
    }

    #[test]
    fn decoder_reassembles_utf8_split_across_chunks() {
        let mut d = Decoder::new();
        let line = encode(&json!({"t":"refused","reason":"héllo ✦"}));
        // Split inside the multi-byte '✦' sequence.
        let cut = line.iter().position(|&b| b == 0xe2).unwrap() + 1;
        d.push(&line[..cut]);
        let got = d.push(&line[cut..]);
        assert_eq!(got[0]["reason"], "héllo ✦");
    }

    #[test]
    fn validate_accepts_well_formed_messages() {
        // Mirrors the `good` fixture list in packages/shared/protocol.test.js.
        let good = vec![
            json!({"t":"hello","want":"room"}),
            json!({"t":"hello","want":"room","secret":"hunter2"}),
            json!({"t":"hello","want":"room","pass":"letmein"}),
            json!({"t":"reclaim","code":"brave-otter"}),
            json!({"t":"room","code":"brave-otter"}),
            json!({"t":"room","code":"brave-otter","webUrl":"https://claude-share.fly.dev"}),
            json!({"t":"gone","code":"brave-otter"}),
            json!({"t":"refused","reason":"secret"}),
            json!({"t":"knock","id":"g1","name":"siddh","fp":"a1","seen":false}),
            json!({"t":"knock","id":"g1","name":"siddh","fp":"a1","seen":"siddh"}),
            json!({"t":"knock","id":"g1","name":"siddh","fp":"a1","seen":null}),
            json!({"t":"admit","id":"g1"}),
            json!({"t":"deny","id":"g1"}),
            json!({"t":"joined","id":"g1"}),
            json!({"t":"left","id":"g1"}),
            json!({"t":"key","id":"g1","data":"aGk="}),
            json!({"t":"resize","id":"g1","cols":80,"rows":24}),
            json!({"t":"screen","data":"aGk="}),
            json!({"t":"to","id":"g1","data":"aGk="}),
            json!({"t":"drop","id":"g1","ban":true}),
            json!({"t":"drop","id":"g1","ban":false}),
            json!({"t":"end"}),
            json!({"t":"state","data":{}}),
            json!({"t":"state","data":{"room":"r","participants":[],"queue":[],"paused":true}}),
            json!({"t":"pointer","x":0,"y":0}),
            json!({"t":"pointer","x":0.5,"y":0.5,"id":"g1"}),
            json!({"t":"ui","action":{"kind":"admit","id":"k1"}}),
            json!({"t":"ui","action":{"kind":"deny","id":"k1"}}),
            json!({"t":"ui","action":{"kind":"command","text":"/pause"}}),
            json!({"t":"ui","id":"g1","action":{"kind":"command","text":"/role @x prompter"}}),
            json!({"t":"ui","id":"host","action":{"kind":"role","id":"g2","role":"prompter"}}),
            json!({"t":"ui","id":"host","action":{"kind":"kick","id":"g2"}}),
            json!({"t":"ui","id":"g1","action":{"kind":"caret","id":"d1","offset":3}}),
            json!({"t":"ui","action":{"kind":"delrange","id":"d1","start":0,"end":4}}),
            json!({"t":"ui","action":{"kind":"deldraft","id":"d1"}}),
            json!({"t":"ui","action":{"kind":"place","id":"d1","x":0.2,"y":0.8}}),
            json!({"t":"ui","action":{"kind":"place","id":"d1","home":true}}),
            json!({"t":"ui","action":{"kind":"unqueue","n":2}}),
            json!({"t":"ui","id":"g1","action":{"kind":"scroll","lines":-3}}),
            json!({"t":"ui","action":{"kind":"resync"}}),
        ];
        for m in good {
            assert!(validate(&m), "should accept {m}");
        }
    }

    #[test]
    fn validate_rejects_malformed_messages() {
        // Mirrors the `bad` fixture list in packages/shared/protocol.test.js.
        let bad = vec![
            json!(null),
            json!(42),
            json!("end"),
            json!([]),
            json!({}),
            json!({"t":"nope"}),
            json!({"t":"hello","want":"shell"}),
            json!({"t":"hello","want":"room","secret":42}),
            json!({"t":"hello","want":"room","pass":42}),
            json!({"t":"refused"}),
            json!({"t":"refused","reason":7}),
            json!({"t":"room"}),
            json!({"t":"room","code":5}),
            json!({"t":"reclaim"}),
            json!({"t":"gone","code":5}),
            json!({"t":"admit"}),
            json!({"t":"admit","id":7}),
            json!({"t":"key","id":"g1"}),
            json!({"t":"resize","id":"g1","cols":"80","rows":24}),
            json!({"t":"drop","id":"g1"}),
            json!({"t":"drop","id":"g1","ban":"yes"}),
            json!({"t":"knock","id":"g1","name":"x","fp":"a1"}), // missing seen
            json!({"t":"state"}),
            json!({"t":"state","data":null}),
            json!({"t":"state","data":[]}),
            json!({"t":"state","data":"nope"}),
            json!({"t":"pointer","x":0}),
            json!({"t":"pointer","x":"0","y":0}),
            json!({"t":"ui","action":{"kind":"admit"}}),
            json!({"t":"ui","action":{"kind":"launch-missiles"}}),
            json!({"t":"ui","action":"admit"}),
            json!({"t":"ui"}),
        ];
        for m in bad {
            assert!(!validate(&m), "should reject {m}");
        }
    }
}
