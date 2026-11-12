// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A declaration of intent turns into one declared license and its first issuance.
 *
 *   An `open-source` declaration receives its token and refresh secret in the response.
 *   The other intents receive the token by email and a claim id in the response,
 *   so the address is a possession proof.
 *
 *   A re-issuance mints the next `seq` when the current token is within `EXPIRY_NOTICE_DAYS` of
 *   its expiry, and for an open-source declaration reads the source URL's license file first.
 *   The ledger's unique pair on `(lid, seq)` makes two racing re-issuances one row.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { type DeclarationRequest, EXPIRY_NOTICE_DAYS } from "@mailwoman/core/license/declaration"
import { encodeLicenseKey, type LicenseKeyPayload, LicenseTerms } from "@mailwoman/core/license/key"
import { applyStep } from "@mailwoman/core/state-machine"

import { todayUTC } from "#dates"
import type { EmailProvider } from "#email/provider"
import type { LicenseWorkerEnv } from "#env"
import { daysBetween, expiryForIntent } from "#expiry"
import { newClaimID, newIssuanceID, newLicenseID, newRefreshSecret, secretDigest } from "#identifiers"
import type { Ledger } from "#ledger/client"
import {
	clearDeclarationPendingSecret,
	createDeclaration,
	currentIssuance,
	findDeclaration,
	findEvaluationByEmail,
	insertIssuance,
	setDeclarationVerification,
} from "#ledger/declarations"
import { emailMachine, issuanceEmailCarrier } from "#ledger/machines"
import type { DeclarationRow, IssuanceRow } from "#ledger/schema"
import { verifySourceURL } from "#verify-source"

export interface DeclarationDependencies {
	ledger: Ledger
	email: EmailProvider
	/**
	 * Reads the declared source URL's license file.
	 * A test scripts it.
	 */
	fetch: typeof fetch
	/**
	 * The clock, in milliseconds; `Date.now` unless a test injects one.
	 */
	now?: () => number
}

export type DeclarationRefusal = "evaluation_exists" | "missing_email" | "missing_source_url" | "issuance_disabled"

export type DeclarationOutcome =
	| { outcome: "issued"; lid: string; token: string; secret: string; issued: string; expires: string }
	| { outcome: "pending"; claim: string; lid: string }
	| { outcome: "refused"; reason: DeclarationRefusal }

/**
 * The intents whose token travels by email rather than in the response.
 */
const EMAILED_INTENTS: ReadonlySet<DeclarationRequest["intent"]> = new Set([
	"non-profit",
	"academic",
	"student",
	"evaluation",
])

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/u.test(error.message)
}

/**
 * Mint the issuance with the given `seq` for a declared license and answer its row.
 *
 * When another caller minted that ordinal first, the row that landed is answered.
 */
async function mintIssuance(
	env: LicenseWorkerEnv,
	deps: DeclarationDependencies,
	declaration: DeclarationRow,
	seq: number,
	install: string | null
): Promise<IssuanceRow> {
	const issued = todayUTC(deps.now)
	const expires = expiryForIntent(declaration.intent, issued)

	const payload: LicenseKeyPayload = {
		v: 1,
		kid: env.LICENSE_SIGNING_KID,
		licensee: declaration.licensee,
		issued,
		expires,
		scope: "all",
		terms: LicenseTerms.OpenSource,
		lid: declaration.lid,
		intent: declaration.intent,
		seq,
		...(install ? { install } : {}),
	}

	const token = await encodeLicenseKey(payload, env.LICENSE_SIGNING_KEY_PEM)

	await insertIssuance(deps.ledger, {
		issuance_id: newIssuanceID(),
		lid: declaration.lid,
		seq,
		issued,
		expires,
		install,
		payload_json: stringifyJSON(payload),
		token,
	})

	const current = await currentIssuance(deps.ledger, declaration.lid)

	if (!current) throw new Error(`issuance ${seq} for ${declaration.lid} vanished after insert`)

	return current
}

/**
 * What sending one issuance's email needs from the dependencies.
 */
export type IssuanceEmailDependencies = Pick<DeclarationDependencies, "ledger" | "email" | "now">

/**
 * Send an issuance to the declaration's address and record the result.
 *
 * An open-source declaration has no address, because its token was answered
 * in the response, so it skips the send.
 * A sent message included the declaration's pending refresh secret.
 * The ledger then clears that secret.
 */
async function emailIssuance(
	deps: IssuanceEmailDependencies,
	declaration: DeclarationRow,
	issuance: IssuanceRow,
	refreshSecret: string | null
): Promise<"sent" | "failed" | "skipped"> {
	if (!declaration.email) return "skipped"

	const carrier = issuanceEmailCarrier(deps.ledger, issuance.issuance_id)

	let messageID: string

	try {
		;({ messageID } = await deps.email.send(
			{
				to: declaration.email,
				licensee: declaration.licensee,
				token: issuance.token,
				lid: declaration.lid,
				issued: issuance.issued,
				expires: issuance.expires,
				agreement: null,
				intent: declaration.intent,
				refreshSecret,
			},
			issuance.issuance_id
		))
	} catch {
		await applyStep(emailMachine, carrier, issuance.email_state, { kind: "failed" })

		return "failed"
	}

	// A conflict means another send recorded its outcome first.
	// The provider deduplicates on the issuance id, so this send's acceptance needs no second record.
	await applyStep(emailMachine, carrier, issuance.email_state, { kind: "sent", messageID })

	if (refreshSecret) {
		await clearDeclarationPendingSecret(deps.ledger, declaration.lid, new Date((deps.now ?? Date.now)()).toISOString())
	}

	return "sent"
}

/**
 * Send an issuance's email again, after a provider refusal or a crash before the send.
 *
 * The message includes the declaration's pending refresh secret.
 * The ledger holds that secret until a first message is sent.
 *
 * The issuance id is the provider's idempotency key, as on the first attempt.
 */
export function resendIssuanceEmail(
	deps: IssuanceEmailDependencies,
	declaration: DeclarationRow,
	issuance: IssuanceRow
): Promise<"sent" | "failed" | "skipped"> {
	return emailIssuance(deps, declaration, issuance, declaration.refresh_secret_pending)
}

/**
 * Record a declaration and mint its first token.
 */
export async function issueDeclaration(
	env: LicenseWorkerEnv,
	deps: DeclarationDependencies,
	request: DeclarationRequest
): Promise<DeclarationOutcome> {
	if (!env.issuanceEnabled) return { outcome: "refused", reason: "issuance_disabled" }

	const emailed = EMAILED_INTENTS.has(request.intent)
	// One address is one address whatever its case or surrounding space, so the one-evaluation rule reads it normalized.
	const email = request.email?.trim().toLowerCase() || null

	if (request.intent === "open-source" && !request.sourceURL)
		return { outcome: "refused", reason: "missing_source_url" }

	if (emailed && !email) return { outcome: "refused", reason: "missing_email" }

	if (request.intent === "evaluation" && email && (await findEvaluationByEmail(deps.ledger, email))) {
		return { outcome: "refused", reason: "evaluation_exists" }
	}

	const lid = newLicenseID()
	const secret = newRefreshSecret()
	const claim = emailed ? newClaimID() : null

	try {
		await createDeclaration(deps.ledger, {
			lid,
			intent: request.intent,
			licensee: request.name,
			email,
			organization: request.organization ?? null,
			source_url: request.sourceURL ?? null,
			claim_id: claim,
			refresh_secret_sha256: await secretDigest(secret),
			// The secret travels in the response for open-source and in the message for the other intents.
			// An emailed declaration keeps it until its first message is sent.
			// A resend after a failed send includes it.
			// No route answers it.
			refresh_secret_pending: emailed ? secret : null,
			first_install: request.install ?? null,
		})
	} catch (error) {
		if (isUniqueViolation(error) && request.intent === "evaluation") {
			return { outcome: "refused", reason: "evaluation_exists" }
		}

		throw error
	}

	const declaration = await findDeclaration(deps.ledger, lid)

	if (!declaration) throw new Error(`declaration ${lid} vanished after insert`)

	const issuance = await mintIssuance(env, deps, declaration, 1, request.install ?? null)

	if (emailed && claim) {
		await emailIssuance(deps, declaration, issuance, secret)

		return { outcome: "pending", claim, lid }
	}

	return { outcome: "issued", lid, token: issuance.token, secret, issued: issuance.issued, expires: issuance.expires }
}

/**
 * The current issuance, or the next one when the current expires within `EXPIRY_NOTICE_DAYS` or is absent.
 *
 * A re-issued open-source declaration has its source URL read first,
 * and the result is recorded on the declaration.
 * A re-issued token travels to the declaration's address when it has one.
 */
export async function reissueDeclaration(
	env: LicenseWorkerEnv,
	deps: DeclarationDependencies,
	declaration: DeclarationRow
): Promise<IssuanceRow | null> {
	const current = await currentIssuance(deps.ledger, declaration.lid)
	const today = todayUTC(deps.now)

	if (current && daysBetween(today, current.expires) > EXPIRY_NOTICE_DAYS) return current

	// An evaluation is thirty days once.
	// Its token is answered while it lasts and never minted again.
	// The address that received it continues by declaring or buying, as the spec and the message both say.
	// The kill switch likewise stops every mint, so a refresh under it serves the token that exists.
	if (declaration.intent === "evaluation" || !env.issuanceEnabled) {
		return current && daysBetween(today, current.expires) >= 0 ? current : null
	}

	if (declaration.intent === "open-source" && declaration.source_url) {
		const verification = await verifySourceURL(deps.fetch, declaration.source_url)

		await setDeclarationVerification(
			deps.ledger,
			declaration.lid,
			verification,
			new Date((deps.now ?? Date.now)()).toISOString()
		)
	}

	const issuance = await mintIssuance(
		env,
		deps,
		declaration,
		(current?.seq ?? 0) + 1,
		current?.install ?? declaration.first_install
	)

	await emailIssuance(deps, declaration, issuance, null)

	return issuance
}
