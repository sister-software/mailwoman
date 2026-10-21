/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The stamp contains no licensee or key ID. It works offline by design.
 *   The well-known register supplies the doctor's freshness check, so each process makes no network call.
 */

import { EXPIRY_NOTICE_DAYS } from "#license/declaration"
import { docsSiteURL } from "#license/docs-site"
import { licenseExpiryInstant, type LicenseKeyPayload, type LicenseKeyVerification, LicenseTerms } from "#license/key"
import { appliedLicenseBranch, grantsCommercialTerms } from "#license/obligations"

/**
 * The singular page path the notice and the `Link: rel="license"` header point at,
 * matching `license_url` and the `license` command.
 */
export const LICENSE_PAGE_PATH = "/license"

/**
 * The AGPL source offer to network users.
 * The commercial agreement waives this obligation.
 */
const NOTICE_OBLIGATION = "modified or network-served copies must offer their source."
const NOTICE_REMEDY = "A commercial license waives that obligation"

/**
 * The wire shape every stamped output uses, keyed in snake case.
 */
/**
 * A precision ceiling a result met: the level it resolved to, the uninstalled tier
 * that covers the country, and the command that fetches it.
 */
export interface EngineCoverage {
	resolved: string
	tier: string
	command: string
}

export interface EngineStamp {
	name: "mailwoman"
	version: string
	/**
	 * The license branch that applies to this installation: `AGPL-3.0-only`,
	 * or `LicenseRef-Commercial` when the configured key verifies on the commercial branch.
	 */
	license: string
	license_url: string
	notice: string | null
	/**
	 * Present only on a result that an uninstalled tier would have resolved further.
	 */
	coverage?: EngineCoverage
}

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * Whole days from `now` to the last millisecond of the expiry date.
 */
function daysUntil(expires: string, now: Date): number {
	return Math.floor((licenseExpiryInstant(expires).getTime() - now.getTime()) / MILLISECONDS_PER_DAY)
}

/**
 * The payload of a valid key on the open-source branch, or `null` for every other reading.
 */
function declaredPayload(key: LicenseKeyVerification | undefined): LicenseKeyPayload | null {
	return key?.status === "valid" && key.payload.terms === LicenseTerms.OpenSource ? key.payload : null
}

/**
 * The stamp's statement of a declaration.
 *
 * It carries the intent and the expiry date and never the licensee,
 * because the stamp travels in every API response.
 */
function declaredNoticeSentence(payload: LicenseKeyPayload): string {
	const intent = payload.intent ?? "open-source"

	if (intent === "evaluation") return `Evaluating until ${payload.expires ?? "the end of the evaluation"}.`

	return payload.expires ? `Declared ${intent} until ${payload.expires}.` : `Declared ${intent}.`
}

/**
 * The routes an evaluator has once the thirty days end.
 * An evaluation is never re-issued.
 */
const EVALUATION_ROUTES = "declare an open-source, non-profit, academic or student use, or buy a license"

/**
 * The stderr statement of a declaration, which may name the licensee
 * because it stays on the operator's machine.
 *
 * Within `EXPIRY_NOTICE_DAYS` of the expiry it states the days left
 * and the command that re-issues the token.
 */
function declaredNoticeLine(payload: LicenseKeyPayload, licenseURL: string, now: Date): string {
	const intent = payload.intent ?? "open-source"
	const evaluation = intent === "evaluation"
	const verb = evaluation ? "Evaluating" : `Declared ${intent}`
	const head = `${verb} for ${payload.licensee}${payload.expires ? ` until ${payload.expires}` : ""}`
	const days = payload.expires ? daysUntil(payload.expires, now) : null

	if (days != null && days <= EXPIRY_NOTICE_DAYS) {
		const span = days === 1 ? "1 day" : `${days} days`
		const next = evaluation ? `${EVALUATION_ROUTES}, before then` : "run `mailwoman license refresh` before then"

		return `${head}, which is in ${span}: ${next}. ${licenseURL}`
	}

	return `${head}: ${licenseURL}`
}

export function licensePageURL(docsURL?: string): string {
	return `${docsSiteURL(docsURL)}${LICENSE_PAGE_PATH}`
}

function noticeSentence(license: string, expiredOn?: string): string {
	const qualifier = expiredOn ? ` (the configured license key expired on ${expiredOn})` : ""

	return `mailwoman is licensed ${license}${qualifier}: ${NOTICE_OBLIGATION}`
}

/**
 * Build the offline stamp, taking the branch from `appliedLicenseBranch` —
 * the function the doctor calls too — so the two agree by construction.
 */
export function buildEngineStamp(input: {
	version: string
	expression: string
	key?: LicenseKeyVerification
}): EngineStamp {
	const commercial = grantsCommercialTerms(input.key)
	const license = appliedLicenseBranch(input.expression, input.key)
	const declared = declaredPayload(input.key)

	return {
		name: "mailwoman",
		version: input.version,
		license,
		license_url: licensePageURL(),
		notice: commercial
			? null
			: `${noticeSentence(license)} ${declared ? declaredNoticeSentence(declared) : `${NOTICE_REMEDY}.`}`,
	}
}

/**
 * The stderr notice: two lines, or no notice when the commercial branch applies.
 *
 * An expired key states its date because that tells the operator what to do,
 * while every other failed reading leaves the reason to `mailwoman doctor`.
 */
export function licenseNoticeLines(
	stamp: EngineStamp,
	key?: LicenseKeyVerification,
	now: Date = new Date()
): [string, string] | null {
	if (!stamp.notice) return null

	const declared = declaredPayload(key)

	if (declared) return [noticeSentence(stamp.license), declaredNoticeLine(declared, stamp.license_url, now)]

	const expiredOn = key?.status === "expired" ? (key.payload.expires ?? undefined) : undefined

	if (expiredOn && key?.status === "expired" && key.payload.terms === LicenseTerms.OpenSource) {
		const ended =
			key.payload.intent === "evaluation"
				? `Your evaluation ended on ${expiredOn}: ${EVALUATION_ROUTES}.`
				: `Your declaration expired on ${expiredOn}: run \`mailwoman license refresh\`, or declare again.`

		return [noticeSentence(stamp.license, expiredOn), `${ended} ${stamp.license_url}`]
	}

	return [noticeSentence(stamp.license, expiredOn), `${NOTICE_REMEDY}: ${stamp.license_url}`]
}
