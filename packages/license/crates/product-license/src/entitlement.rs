// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The training and deployment entitlement checks, with the refusal codes of `EntitlementRefusal` in
//! `@mailwoman/license/product/entitlement`.
//!
//! A platform key grants no training permission, `scope: "all"` included, and a missing credential grants
//! nothing.

use crate::keys::TrustMap;
use crate::token::{split, verify_training_grant, TrainingGrantPayload, Verification, LICENSE_KEY_PREFIX};

/// The permission a grant must carry to admit a commercial training run.
pub const TRAIN: &str = "train";

/// The permission a grant must carry to admit commercial use of a model trained under it.
pub const DEPLOY: &str = "deploy";

/// Why an entitlement check refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
	Missing,
	NotATrainingGrant,
	Invalid,
	UnknownKey,
	Expired,
	NotPermitted,
	OtherGrant,
}

impl Refusal {
	/// The refusal code the TypeScript check and the fixtures use.
	pub fn code(self) -> &'static str {
		match self {
			Self::Missing => "missing",
			Self::NotATrainingGrant => "not_a_training_grant",
			Self::Invalid => "invalid",
			Self::UnknownKey => "unknown_key",
			Self::Expired => "expired",
			Self::NotPermitted => "not_permitted",
			Self::OtherGrant => "other_grant",
		}
	}
}

/// The result of an entitlement check.
#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
	Admitted(TrainingGrantPayload),
	Refused { refusal: Refusal, reason: String },
}

impl Admission {
	/// `admitted`, or the refusal code.
	pub fn code(&self) -> &'static str {
		match self {
			Self::Admitted(_) => "admitted",
			Self::Refused { refusal, .. } => refusal.code(),
		}
	}
}

fn refused(refusal: Refusal, reason: String) -> Admission {
	Admission::Refused { refusal, reason }
}

/// The grant of a valid verification, or the refusal code and reason of any other.
fn refusal_of(verification: Verification<TrainingGrantPayload>) -> Result<TrainingGrantPayload, (Refusal, String)> {
	match verification {
		Verification::Valid { payload, .. } => Ok(payload),
		Verification::Expired { payload, .. } => Err((
			Refusal::Expired,
			format!(
				"training grant {} expired at the end of {} UTC",
				payload.grant, payload.expires
			),
		)),
		Verification::UnknownKey { reason, .. } => Err((Refusal::UnknownKey, reason)),
		Verification::Invalid { reason } => Err((Refusal::Invalid, reason)),
	}
}

/// Whether a verified grant admits a commercial training run: an initial start, a retry, a resume, or an export.
pub fn training_admission(verification: Verification<TrainingGrantPayload>) -> Admission {
	match refusal_of(verification) {
		Err((refusal, reason)) => refused(refusal, reason),
		Ok(grant) if !grant.permits.iter().any(|p| p == TRAIN) => refused(
			Refusal::NotPermitted,
			format!("training grant {} does not permit \"{TRAIN}\"", grant.grant),
		),
		Ok(grant) => Admission::Admitted(grant),
	}
}

/// Whether a verified grant admits commercial use of a model whose verified provenance records `grant_id`.
pub fn deployment_admission(verification: Verification<TrainingGrantPayload>, grant_id: &str) -> Admission {
	match refusal_of(verification) {
		Err((refusal, reason)) => refused(refusal, reason),
		Ok(grant) if !grant.permits.iter().any(|p| p == DEPLOY) => refused(
			Refusal::NotPermitted,
			format!("grant {} does not permit \"{DEPLOY}\"", grant.grant),
		),
		Ok(grant) if grant.grant != grant_id => refused(
			Refusal::OtherGrant,
			format!("grant {} does not cover a model trained under {grant_id}", grant.grant),
		),
		Ok(grant) => Admission::Admitted(grant),
	}
}

/// Checks whether a raw credential, absent, a platform key or a training grant, admits a commercial training run.
pub fn check_training(token: Option<&str>, trust: &TrustMap, now_ms: i64) -> Admission {
	let Some(token) = token.filter(|t| !t.trim().is_empty()) else {
		return refused(
			Refusal::Missing,
			format!("no training grant in {}", crate::TRAINING_GRANT_ENV),
		);
	};
	if split(token).is_ok_and(|parts| parts.prefix == LICENSE_KEY_PREFIX) {
		return refused(
			Refusal::NotATrainingGrant,
			"a mwl1 platform key grants no training permission; commercial training needs a mwt1 training grant"
				.to_owned(),
		);
	}
	training_admission(verify_training_grant(token, trust, now_ms))
}
