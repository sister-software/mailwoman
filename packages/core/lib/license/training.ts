// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The commercial training entitlement check over a raw credential: absent,
 *   a platform key, or a training grant.
 *
 *   The Rust trainer runs the same check at its training entry point
 *   (`trainer authorize` and `trainer train` in a build with the `commercial` feature).
 *   This module serves the issuer's tooling and the host-side preflight.
 *
 *   The preflight rejects a local credential before a sandbox starts.
 */

import {
	type EntitlementAdmission,
	EntitlementRefusal,
	trainingAdmission,
} from "@mailwoman/license/product/entitlement"
import { splitProductToken, TRAINING_GRANT_PREFIX } from "@mailwoman/license/product/token"
import { trustedLicenseSigningKeys } from "@mailwoman/license/product/trust"

import { verifyTrainingGrant } from "#license/key"

/**
 * The environment variable the commercial trainer reads its training grant from.
 *
 * The Modal launcher fills it from the training Secret `MAILWOMAN_MODAL_TRAINING_SECRET`
 * identifies, so the token never enters a command argument, a launch record or a log.
 */
export const TRAINING_GRANT_ENV = "MAILWOMAN_TRAINING_GRANT"

/**
 * Checks whether a credential admits a commercial training run.
 *
 * A missing credential and a platform key are refusals: a platform key's
 * `scope` governs artifact access only.
 */
export async function checkTrainingEntitlement(
	token: string | null | undefined,
	options: { trustedKeys?: Readonly<Record<string, string>>; now?: Date } = {}
): Promise<EntitlementAdmission> {
	if (!token?.trim()) {
		return {
			admitted: false,
			refusal: EntitlementRefusal.Missing,
			reason: `no training grant in ${TRAINING_GRANT_ENV}`,
		}
	}

	const parts = splitProductToken(token)

	if (!("reason" in parts) && parts.prefix !== TRAINING_GRANT_PREFIX) {
		return {
			admitted: false,
			refusal: EntitlementRefusal.NotATrainingGrant,
			reason: `a ${parts.prefix} platform key grants no training permission; commercial training needs a ${TRAINING_GRANT_PREFIX} training grant`,
		}
	}

	const verification = await verifyTrainingGrant(token, {
		trustedKeys: options.trustedKeys ?? trustedLicenseSigningKeys(),
		...(options.now ? { now: options.now } : {}),
	})

	return trainingAdmission(verification)
}
