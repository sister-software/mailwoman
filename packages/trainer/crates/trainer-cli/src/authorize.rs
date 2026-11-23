// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The training entry point's license check.
//!
//! The build decides the branch. A binary built with the `commercial` feature is the commercial trainer: every
//! `trainer train` and `trainer authorize` verifies the `mwt1` training grant in `MAILWOMAN_TRAINING_GRANT` against
//! the trust register embedded at build time, and refuses before it reads the corpus, writes a checkpoint, or
//! initializes a GPU. No config value or flag turns the check off, because the check is compiled in. A binary built
//! without the feature is the open-source trainer, trains under the AGPL, and checks no grant. Each run records the
//! branch it trained under in `TRAINING.json`.
//!
//! Offline verification observes expiry: a grant admits every process that starts before its expiry date ends in
//! UTC, including a retry or a resume, and a process admitted before expiry trains to completion. A start, retry or
//! resume after expiry is refused. Revocation before expiry is the issuer's choice of a short expiry.

use product_license::entitlement::{check_training, Admission};
use product_license::keys::{trusted_license_keys, TrustMap};
use product_license::token::TrainingGrantPayload;
use product_license::TRAINING_GRANT_ENV;

/// The exit code of an authorization refusal. The sandbox supervisor reads it as a refusal a retry would repeat.
pub const AUTHORIZATION_REFUSED_EXIT: u8 = 3;

/// The license branch this binary trains under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Branch {
	Commercial,
	OpenSource,
}

impl Branch {
	/// The branch compiled into this binary.
	pub const fn compiled() -> Self {
		if cfg!(feature = "commercial") {
			Self::Commercial
		} else {
			Self::OpenSource
		}
	}

	/// The SPDX identifier a training record states.
	pub fn license(self) -> &'static str {
		match self {
			Self::Commercial => "LicenseRef-Commercial",
			Self::OpenSource => "AGPL-3.0-only",
		}
	}

	/// The build a training record states.
	pub fn build(self) -> &'static str {
		match self {
			Self::Commercial => "commercial",
			Self::OpenSource => "open-source",
		}
	}
}

/// A refusal at the training entry point, with the refusal code the TypeScript check uses.
#[derive(Debug)]
pub struct Refused {
	pub code: &'static str,
	pub reason: String,
}

/// The keys a grant verifies under.
///
/// A debug build, which the crate's tests run, also reads `MAILWOMAN_TRAINING_TRUST_FILE`, a JSON object of key id
/// to spki PEM. A release build, which every trainer image is, reads only the embedded register, so a caller can't
/// make the trainer trust a key of its own.
fn trust() -> Result<TrustMap, String> {
	if cfg!(debug_assertions) {
		if let Some(path) = std::env::var_os("MAILWOMAN_TRAINING_TRUST_FILE") {
			let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.to_string_lossy()))?;
			let map: serde_json::Map<String, serde_json::Value> =
				serde_json::from_str(&text).map_err(|e| e.to_string())?;
			return TrustMap::from_pems(map.iter().filter_map(|(k, v)| Some((k.as_str(), v.as_str()?))));
		}
	}
	Ok(trusted_license_keys())
}

/// The instant authorization is checked at. A debug build reads `MAILWOMAN_TRAINING_NOW` (RFC 3339) so the tests can
/// cross an expiry boundary; a release build reads the clock.
fn now_ms() -> i64 {
	if cfg!(debug_assertions) {
		if let Some(ms) = std::env::var("MAILWOMAN_TRAINING_NOW")
			.ok()
			.and_then(|t| product_license::time::parse_utc_instant_ms(&t))
		{
			return ms;
		}
	}
	product_license::time::now_ms()
}

/// The grant that admits this process: `None` on the open-source branch, and a refusal when the commercial branch's
/// grant is missing, invalid, expired or doesn't permit training.
pub fn authorize() -> Result<(Option<TrainingGrantPayload>, i64), Refused> {
	let now = now_ms();
	if Branch::compiled() == Branch::OpenSource {
		return Ok((None, now));
	}
	let trust = trust().map_err(|reason| Refused {
		code: "invalid",
		reason,
	})?;
	let token = std::env::var(TRAINING_GRANT_ENV).ok();
	match check_training(token.as_deref(), &trust, now) {
		Admission::Admitted(grant) => Ok((Some(grant), now)),
		Admission::Refused { refusal, reason } => Err(Refused {
			code: refusal.code(),
			reason,
		}),
	}
}

/// The JSON `trainer authorize` prints: the branch, the outcome, and the grant's claims without its holder. The token
/// itself is never printed.
pub fn report(outcome: &Result<(Option<TrainingGrantPayload>, i64), Refused>) -> serde_json::Value {
	let branch = Branch::compiled();
	match outcome {
		Ok((grant, _)) => serde_json::json!({
			"branch": branch.license(),
			"admitted": true,
			"grant": grant.as_ref().map(|g| serde_json::json!({
				"grant": g.grant, "agreement": g.agreement, "kid": g.kid, "expires": g.expires, "permits": g.permits,
			})),
		}),
		Err(refused) => serde_json::json!({
			"branch": branch.license(),
			"admitted": false,
			"refusal": refused.code,
			"reason": refused.reason,
		}),
	}
}
