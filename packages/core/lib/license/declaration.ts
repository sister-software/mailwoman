/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The wire shapes of the license worker's declaration, evaluation, claim and download routes, and the one
 *   constant both ends read. This module imports only types, so the worker bundles it under the `workerd`
 *   condition and the CLI's client in `status.ts` reads the same shapes.
 */

import type { LicenseIntent } from "#license/key"

/**
 * The number of days before a token's expiry at which the CLI notice announces it
 * and the worker re-issues a declaration on refresh.
 */
export const EXPIRY_NOTICE_DAYS = 28

/**
 * A declaration of intent.
 *
 * `open-source` gives a public source URL.
 * The other intents give an organization or institution and an email address at it.
 */
export interface DeclarationRequest {
	intent: Exclude<LicenseIntent, "commercial">
	name: string
	sourceURL?: string
	organization?: string
	email?: string
	install?: string
}

/**
 * What the declaration and evaluation routes answer.
 *
 * `issued` includes the token in the response.
 * Only the `open-source` intent receives it.
 *
 * `pending` identifies the claim the CLI polls while the token travels by email.
 */
export type DeclarationAnswer =
	| { status: "issued"; token: string; lid: string; secret: string; issued: string; expires: string }
	| { status: "pending"; claim: string }
	| { status: "refused"; reason: string }
	| { status: "unreachable"; reason: string }

/**
 * What the declaration claim route answers: the delivery state of the message that holds the token.
 *
 * The route never answers the token or the secret, so the stated address is the one place they arrive.
 */
export type DeclarationClaimAnswer =
	| { status: "pending" }
	| { status: "sent"; licensee: string; issued: string; expires: string }
	| { status: "failed" }
	| { status: "revoked" }
	| { status: "not_found" }
	| { status: "unreachable"; reason: string }

/**
 * A request for a paid artifact.
 */
export interface DownloadRequest {
	token: string
	artifact: string
	install?: string
}

/**
 * What the download route answers.
 *
 * `unavailable` is a worker whose bucket is not yet provisioned.
 */
export type DownloadAnswer =
	| { status: "granted"; url: string; expires: string; bytes: number | null }
	| { status: "refused"; reason: string }
	| { status: "unavailable" }
	| { status: "unreachable"; reason: string }
