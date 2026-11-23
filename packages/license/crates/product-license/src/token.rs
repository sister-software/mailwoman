// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Platform license keys (`mwl1`) and training grants (`mwt1`): `<prefix>.<payload>.<signature>`, where the
//! payload is unpadded base64url of a UTF-8 JSON object and the signature is an Ed25519 signature over the ASCII
//! bytes `<prefix>.<payload>` exactly as the token carries them.
//!
//! The payload checks are those of `LicenseKeyPayloadSchema` and `TrainingGrantPayloadSchema` in
//! `@mailwoman/license/product/token`. A field neither schema defines is ignored. The shared fixtures under
//! `packages/license/test/fixtures/product/` hold both implementations to the same statuses.

use crate::keys::TrustMap;
use crate::time::{expiry_instant_ms, parse_calendar_date};
use base64::engine::general_purpose::GeneralPurpose;
use base64::engine::{DecodePaddingMode, GeneralPurposeConfig};
use base64::{alphabet, Engine};
use ed25519_dalek::Signature;
use serde::Serialize;
use serde_json::{Map, Value};

pub const LICENSE_KEY_PREFIX: &str = "mwl1";
pub const TRAINING_GRANT_PREFIX: &str = "mwt1";

/// Unpadded base64url that, like the browser's `atob`, accepts non-zero trailing bits.
pub(crate) const BASE64URL: GeneralPurpose = GeneralPurpose::new(
	&alphabet::URL_SAFE,
	GeneralPurposeConfig::new()
		.with_encode_padding(false)
		.with_decode_padding_mode(DecodePaddingMode::RequireNone)
		.with_decode_allow_trailing_bits(true),
);

/// Whether `text` is non-empty and uses only the unpadded base64url alphabet.
pub(crate) fn is_base64url(text: &str) -> bool {
	!text.is_empty()
		&& text
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The result of verifying a token: one of the four statuses the TypeScript verifier returns.
#[derive(Clone, Debug, PartialEq)]
pub enum Verification<P> {
	Valid { kid: String, payload: P },
	Expired { kid: String, payload: P },
	UnknownKey { kid: String, reason: String },
	Invalid { reason: String },
}

impl<P> Verification<P> {
	/// The status word the TypeScript verifier and the fixtures use.
	pub fn status(&self) -> &'static str {
		match self {
			Self::Valid { .. } => "valid",
			Self::Expired { .. } => "expired",
			Self::UnknownKey { .. } => "unknown_key",
			Self::Invalid { .. } => "invalid",
		}
	}
}

/// A platform key's download scope: `all`, or a list of packages and `tier:<name>` entries. It grants no training
/// permission, `all` included.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Scope {
	All(String),
	Entries(Vec<String>),
}

/// A validated platform license key payload.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LicenseKeyPayload {
	pub kid: String,
	pub licensee: String,
	pub issued: String,
	pub expires: Option<String>,
	pub scope: Scope,
	pub terms: String,
	pub lid: Option<String>,
	pub agreement: Option<String>,
	pub intent: Option<String>,
	pub seq: Option<i64>,
	pub install: Option<String>,
}

/// A validated commercial training grant payload.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TrainingGrantPayload {
	pub kid: String,
	pub grant: String,
	/// The party the grant was negotiated with. A training record never copies it.
	pub holder: String,
	pub agreement: String,
	pub issued: String,
	pub expires: String,
	pub permits: Vec<String>,
}

/// A payload that carries the fields every token verification reads.
pub trait TokenPayload: Sized {
	const PREFIX: &'static str;
	fn read(value: &Value) -> Result<Self, String>;
	fn kid(&self) -> &str;
	fn expires(&self) -> Option<&str>;
}

type Fields = Map<String, Value>;

fn non_empty(fields: &Fields, key: &str) -> Result<String, String> {
	match fields.get(key) {
		Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
		_ => Err(format!("{key}: expected a non-empty string")),
	}
}

fn date(fields: &Fields, key: &str) -> Result<String, String> {
	match fields.get(key) {
		Some(Value::String(s)) if parse_calendar_date(s).is_some() => Ok(s.clone()),
		_ => Err(format!("{key}: expected a real YYYY-MM-DD calendar date")),
	}
}

/// A field zod reads as `.nullable().optional()`: absent and `null` are both `None`.
fn nullable(
	fields: &Fields,
	key: &str,
	read: impl Fn(&Fields, &str) -> Result<String, String>,
) -> Result<Option<String>, String> {
	match fields.get(key) {
		None | Some(Value::Null) => Ok(None),
		Some(_) => read(fields, key).map(Some),
	}
}

fn version_one(fields: &Fields) -> Result<(), String> {
	if fields.get("v").and_then(Value::as_f64) == Some(1.0) {
		Ok(())
	} else {
		Err("v: expected 1".to_owned())
	}
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
	let items = value?.as_array()?;
	if items.is_empty() {
		return None;
	}
	items
		.iter()
		.map(|item| item.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
		.collect()
}

/// `z.uuid()`: an RFC 9562 UUID with version 1 to 8 and the RFC variant, or the nil or max UUID.
fn is_uuid(text: &str) -> bool {
	let lower = text.to_ascii_lowercase();
	if lower == "00000000-0000-0000-0000-000000000000" || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
		return true;
	}
	let groups: Vec<&str> = lower.split('-').collect();
	let lengths = [8, 4, 4, 4, 12];
	groups.len() == 5
		&& groups
			.iter()
			.zip(lengths)
			.all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
		&& (b'1'..=b'8').contains(&groups[2].as_bytes()[0])
		&& matches!(groups[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b')
}

const TERMS: [&str; 2] = ["LicenseRef-Commercial", "AGPL-3.0-only"];
const INTENTS: [&str; 6] = [
	"open-source",
	"non-profit",
	"academic",
	"student",
	"evaluation",
	"commercial",
];

impl TokenPayload for LicenseKeyPayload {
	const PREFIX: &'static str = LICENSE_KEY_PREFIX;

	fn read(value: &Value) -> Result<Self, String> {
		let fields = value.as_object().ok_or("expected a JSON object")?;
		version_one(fields)?;
		let scope = match fields.get("scope") {
			Some(Value::String(s)) if s == "all" => Scope::All(s.clone()),
			other => Scope::Entries(
				string_list(other).ok_or("scope: expected \"all\" or a non-empty list of non-empty strings")?,
			),
		};
		let terms = match fields.get("terms").and_then(Value::as_str) {
			Some(t) if TERMS.contains(&t) => t.to_owned(),
			_ => return Err(format!("terms: expected one of {}", TERMS.join(", "))),
		};
		let intent = match fields.get("intent") {
			None => None,
			Some(Value::String(i)) if INTENTS.contains(&i.as_str()) => Some(i.clone()),
			Some(_) => return Err(format!("intent: expected one of {}", INTENTS.join(", "))),
		};
		let seq = match fields.get("seq") {
			None => None,
			Some(v) => match v.as_f64() {
				// `z.number().int()` admits a safe integer: at most 2^53 - 1.
				Some(n) if n.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&n) => Some(n as i64),
				_ => return Err("seq: expected an integer of at least 1".to_owned()),
			},
		};
		let install = match fields.get("install") {
			None => None,
			Some(Value::String(u)) if is_uuid(u) => Some(u.clone()),
			Some(_) => return Err("install: expected a UUID".to_owned()),
		};
		Ok(Self {
			kid: non_empty(fields, "kid")?,
			licensee: non_empty(fields, "licensee")?,
			issued: date(fields, "issued")?,
			expires: nullable(fields, "expires", date)?,
			scope,
			terms,
			lid: nullable(fields, "lid", non_empty)?,
			agreement: nullable(fields, "agreement", non_empty)?,
			intent,
			seq,
			install,
		})
	}

	fn kid(&self) -> &str {
		&self.kid
	}

	fn expires(&self) -> Option<&str> {
		self.expires.as_deref()
	}
}

/// `mtg_` and 24 lowercase hex digits.
pub fn is_grant_id(text: &str) -> bool {
	text.strip_prefix("mtg_")
		.is_some_and(|hex| hex.len() == 24 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

impl TokenPayload for TrainingGrantPayload {
	const PREFIX: &'static str = TRAINING_GRANT_PREFIX;

	fn read(value: &Value) -> Result<Self, String> {
		let fields = value.as_object().ok_or("expected a JSON object")?;
		version_one(fields)?;
		let grant = non_empty(fields, "grant")
			.ok()
			.filter(|g| is_grant_id(g))
			.ok_or("grant: expected mtg_ and 24 lowercase hex digits")?;
		Ok(Self {
			kid: non_empty(fields, "kid")?,
			grant,
			holder: non_empty(fields, "holder")?,
			agreement: non_empty(fields, "agreement")?,
			issued: date(fields, "issued")?,
			expires: date(fields, "expires")?,
			permits: string_list(fields.get("permits"))
				.ok_or("permits: expected a non-empty list of non-empty strings")?,
		})
	}

	fn kid(&self) -> &str {
		&self.kid
	}

	fn expires(&self) -> Option<&str> {
		Some(&self.expires)
	}
}

/// The three encoded parts of a token, after trimming surrounding whitespace.
pub(crate) struct Parts<'a> {
	pub prefix: &'a str,
	pub payload: &'a str,
	pub signature: &'a str,
}

pub(crate) fn split(token: &str) -> Result<Parts<'_>, String> {
	let parts: Vec<&str> = token.trim().split('.').collect();
	let [prefix, payload, signature] = parts[..] else {
		return Err("not a product token (expected three dot-separated parts)".to_owned());
	};
	if prefix != LICENSE_KEY_PREFIX && prefix != TRAINING_GRANT_PREFIX {
		return Err(format!("unknown token prefix {prefix:?}"));
	}
	if !is_base64url(payload) {
		return Err("payload is not unpadded base64url".to_owned());
	}
	if !is_base64url(signature) {
		return Err("signature is not unpadded base64url".to_owned());
	}
	Ok(Parts {
		prefix,
		payload,
		signature,
	})
}

/// Verifies a token of payload type `P` offline against `trust` at `now_ms`.
pub fn verify<P: TokenPayload>(token: &str, trust: &TrustMap, now_ms: i64) -> Verification<P> {
	let invalid = |reason: String| Verification::Invalid { reason };
	let parts = match split(token) {
		Ok(parts) => parts,
		Err(reason) => return invalid(reason),
	};
	if parts.prefix != P::PREFIX {
		return invalid(format!("a {} token, not a {} token", parts.prefix, P::PREFIX));
	}
	let Some(text) = BASE64URL
		.decode(parts.payload)
		.ok()
		.and_then(|bytes| String::from_utf8(bytes).ok())
	else {
		return invalid("payload unreadable: not base64url-encoded UTF-8".to_owned());
	};
	let Ok(value) = serde_json::from_str::<Value>(&text) else {
		return invalid("payload unreadable: not JSON".to_owned());
	};
	let payload = match P::read(&value) {
		Ok(payload) => payload,
		Err(issue) => return invalid(format!("payload unreadable: {issue}")),
	};
	let kid = payload.kid().to_owned();
	let Some(key) = trust.get(&kid) else {
		return Verification::UnknownKey {
			reason: format!("signed by key id {kid}, which this build does not trust"),
			kid,
		};
	};
	let signed = BASE64URL
		.decode(parts.signature)
		.ok()
		.and_then(|bytes| Signature::from_slice(&bytes).ok())
		.is_some_and(|signature| {
			key.verify_strict(format!("{}.{}", parts.prefix, parts.payload).as_bytes(), &signature)
				.is_ok()
		});
	if !signed {
		return invalid(format!("signature does not verify under key id {kid}"));
	}
	if let Some(expires) = payload.expires() {
		if expiry_instant_ms(expires).is_some_and(|end| end < now_ms) {
			return Verification::Expired { kid, payload };
		}
	}
	Verification::Valid { kid, payload }
}

/// Verifies a platform license key.
pub fn verify_license_key(token: &str, trust: &TrustMap, now_ms: i64) -> Verification<LicenseKeyPayload> {
	verify(token, trust, now_ms)
}

/// Verifies a commercial training grant. A valid grant is not yet an admission: see
/// [`crate::entitlement::training_admission`].
pub fn verify_training_grant(token: &str, trust: &TrustMap, now_ms: i64) -> Verification<TrainingGrantPayload> {
	verify(token, trust, now_ms)
}
