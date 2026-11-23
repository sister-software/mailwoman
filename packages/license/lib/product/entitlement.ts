// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The entitlement checks over a verified product token: whether it admits a commercial training
 *   run, and whether it admits commercial use of a model trained under a grant.
 *
 *   Platform use, training and commercial use of a trained model are separate permissions. A platform
 *   key (`mwl1`) grants artifact access through its `scope` and grants no training permission, `scope:
 *   "all"` included. A training grant (`mwt1`) grants exactly the permissions its `permits` list names.
 *   A missing credential is a refusal.
 *
 *   The Rust verifier returns the same refusal codes for the same fixtures.
 */

import { type TrainingGrantPayload, type TrainingGrantVerification, TrainingPermission } from "#product/token"

/**
 * Why an entitlement check refused.
 */
export const EntitlementRefusal = {
	/**
	 * No credential was configured.
	 */
	Missing: "missing",
	/**
	 * The credential is a platform key or another token that isn't a training grant.
	 */
	NotATrainingGrant: "not_a_training_grant",
	/**
	 * The token is malformed, its payload doesn't validate, or its signature doesn't verify.
	 */
	Invalid: "invalid",
	/**
	 * A key this build doesn't trust signed the token.
	 */
	UnknownKey: "unknown_key",
	/**
	 * The grant's inclusive expiry date has passed in UTC.
	 */
	Expired: "expired",
	/**
	 * The grant verified, and its `permits` list lacks the permission the check needs.
	 */
	NotPermitted: "not_permitted",
	/**
	 * The grant verified and permits deployment, but its ID differs from the one
	 * the model's provenance records.
	 */
	OtherGrant: "other_grant",
} as const

export type EntitlementRefusal = (typeof EntitlementRefusal)[keyof typeof EntitlementRefusal]

/**
 * The result of an entitlement check.
 */
export type EntitlementAdmission =
	| { admitted: true; grant: TrainingGrantPayload }
	| { admitted: false; refusal: EntitlementRefusal; reason: string }

function permits(grant: TrainingGrantPayload, permission: TrainingPermission): boolean {
	return grant.permits.includes(permission)
}

function refusalOf(
	verification: Exclude<TrainingGrantVerification, { status: "valid" }>
): Extract<EntitlementAdmission, { admitted: false }> {
	switch (verification.status) {
		case "expired":
			return {
				admitted: false,
				refusal: EntitlementRefusal.Expired,
				reason: `training grant ${verification.payload.grant} expired at the end of ${verification.payload.expires} UTC`,
			}
		case "unknown_key":
			return { admitted: false, refusal: EntitlementRefusal.UnknownKey, reason: verification.reason }
		case "invalid":
			return { admitted: false, refusal: EntitlementRefusal.Invalid, reason: verification.reason }
	}
}

/**
 * Whether a verified training grant admits a commercial training run: initial training,
 * a retry, a resume, or an export of the run's model.
 */
export function trainingAdmission(verification: TrainingGrantVerification): EntitlementAdmission {
	if (verification.status !== "valid") return refusalOf(verification)

	if (!permits(verification.payload, TrainingPermission.Train)) {
		return {
			admitted: false,
			refusal: EntitlementRefusal.NotPermitted,
			reason: `training grant ${verification.payload.grant} does not permit "${TrainingPermission.Train}"`,
		}
	}

	return { admitted: true, grant: verification.payload }
}

/**
 * Whether a verified grant admits commercial use of a model whose verified provenance records `grantID`.
 *
 * A model's provenance is a durable record of the run that produced it.
 * It never stands in for a current grant.
 *
 * After a training grant expires, a separate grant with the same ID and `deploy`
 * in its `permits` list covers continued commercial use.
 */
export function deploymentAdmission(verification: TrainingGrantVerification, grantID: string): EntitlementAdmission {
	if (verification.status !== "valid") return refusalOf(verification)

	if (!permits(verification.payload, TrainingPermission.Deploy)) {
		return {
			admitted: false,
			refusal: EntitlementRefusal.NotPermitted,
			reason: `grant ${verification.payload.grant} does not permit "${TrainingPermission.Deploy}"`,
		}
	}

	if (verification.payload.grant !== grantID) {
		return {
			admitted: false,
			refusal: EntitlementRefusal.OtherGrant,
			reason: `grant ${verification.payload.grant} does not cover a model trained under ${grantID}`,
		}
	}

	return { admitted: true, grant: verification.payload }
}
