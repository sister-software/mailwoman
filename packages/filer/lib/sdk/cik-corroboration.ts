/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The check between a name match and a database write.
 *
 *   `resolveCIKCandidates` (`edgar-filings.ts`) scores a company name against EDGAR's registrant index
 *   and deliberately returns EVERY candidate above a threshold, never a winner, because two different
 *   companies can canonicalize to the same name. Something still has to decide, and deciding on the score
 *   alone is measurably wrong: taking the top candidate for 24 telecom registrant names on 2026-08-03
 *   returned the wrong company twice.
 *
 *   | query                  | resolved to                                | score |
 *   | ---------------------- | ------------------------------------------ | ----- |
 *   | `Altice USA, Inc.`     | AlTi Global, Inc. — SIC 6282, investment advice | 0.829 |
 *   | `WideOpenWest, Inc.`   | WidePoint Corp — SIC 7373, systems design   | 0.886 |
 *
 *   Both are vendored under their TRUE registrant names in `test-fixtures/edgar/` as evidence. A name
 *   score of 0.886 is not a weak signal — it is a confident one, pointing at the wrong company. No
 *   threshold fixes that, because the scores are not the problem: a second, INDEPENDENT signal is what
 *   was missing.
 *
 *   **SIC is that signal, and it is already free.** EDGAR's submissions payload — the same document
 *   `fetchTenKFilings` reads — carries the registrant's Standard Industrial Classification. Both false
 *   matches above fall outside the communications range; the real carriers land inside it.
 *
 *   **The check is honest about what it costs.** Measured over the same 24 registrants, an SIC-only rule
 *   rejects 2 of 2 false matches and accepts 6 of 8 real carriers. The two it wrongly rejects are
 *   Bandwidth Inc. (SIC 7372, prepackaged software — a CLEC whose own Exhibit 21 lists
 *   `Bandwidth.com CLEC, LLC`) and Ooma, Inc. (SIC 7374). SEC files VoIP and CPaaS carriers under
 *   software classifications routinely, and widening the allowlist far enough to admit them readmits
 *   WidePoint at 7373. So the allowlist stays narrow and {@link CIKCorroborationOptions.pinnedCIKs}
 *   carries the exceptions: a pin is a named, auditable decision about ONE registrant, where a widened
 *   range is an unnamed decision about thousands.
 *
 *   **A rejection is an abstention, not a denial.** `corroborated: false` means no second source agreed,
 *   which is not evidence the match is wrong — absence is not impossibility. Callers count these; they do
 *   not record them as negative facts.
 */

import type { CIK } from "#sdk/edgar-filings"

/**
 * SIC codes this check accepts as corroborating a telecom identity — SEC's Office of Telecommunications range,
 * enumerated rather than expressed as a `48xx` prefix test so each entry is a decision someone made.
 *
 * `4813` (telephone, no radiotelephone) covers the ILECs and most CLECs; `4841` the cable operators; `4899` the
 * "communications services, NEC" bucket satellite and in-flight providers land in.
 */
export const TELECOM_SIC_CODES: ReadonlySet<string> = new Set([
	"4812", // Radiotelephone communications.
	"4813", // Telephone communications (no radiotelephone) — the ILECs and most CLECs.
	"4822", // Telegraph and other message communications.
	"4832", // Radio broadcasting stations.
	"4833", // Television broadcasting stations.
	"4841", // Cable and other pay television services.
	"4899", // Communications services, NEC — where satellite and in-flight providers land.
])

/**
 * Why a candidate was or was not corroborated. A caller reporting a run needs to distinguish these — a `pinned`
 * acceptance is an operator decision to audit, an `sic` acceptance is a source agreeing, and `no-sic` is a gap in what
 * EDGAR published rather than a judgment about the company.
 */
export const CIKCorroborationBasis = {
	/**
	 * The registrant's SIC is in {@linkcode TELECOM_SIC_CODES}.
	 */
	TelecomSIC: "telecom-sic",
	/**
	 * An operator pinned this CIK explicitly. The SIC was not consulted.
	 */
	Pinned: "pinned",
	/**
	 * A real SIC, outside the accepted set. The most common rejection, and the one that caught both false matches.
	 */
	NonTelecomSIC: "non-telecom-sic",
	/**
	 * EDGAR published no SIC for this registrant. Nothing to corroborate against; not a judgment.
	 */
	NoSIC: "no-sic",
} as const

export type CIKCorroborationBasis = (typeof CIKCorroborationBasis)[keyof typeof CIKCorroborationBasis]

export interface CIKCorroborationVerdict {
	corroborated: boolean
	basis: CIKCorroborationBasis
	/**
	 * The SIC actually consulted, when there was one — carried so a run's report can name it rather than saying only that
	 * a candidate was rejected.
	 */
	sic?: string
}

export interface CIKCorroborationOptions {
	/**
	 * CIKs an operator has decided are telecom carriers despite their SIC. Checked BEFORE the SIC, so a pin is a decision
	 * rather than a tiebreak.
	 *
	 * This is the escape valve for the Bandwidth/Ooma class — real carriers SEC files under a software SIC. Keep it a
	 * list of specific registrants with a reason recorded alongside; the moment it grows into a range it has become the
	 * widened allowlist this design rejected.
	 */
	pinnedCIKs?: ReadonlySet<string>
	/**
	 * SIC codes accepted as corroborating. Defaults to {@linkcode TELECOM_SIC_CODES}. Overridable so a caller working a
	 * different vertical does not have to fork the check — NOT so a telecom run can quietly widen it.
	 */
	acceptedSICCodes?: ReadonlySet<string>
}

/**
 * Decide whether a name-matched CIK is corroborated by a second signal.
 *
 * `sic` is the registrant's SIC exactly as EDGAR's submissions payload states it (`sic` field, a 4-digit string);
 * `null`/`undefined`/empty all mean EDGAR published none.
 *
 * Never throws, and never consults the name score — the score is what this exists to be independent of.
 */
export function corroborateCIK(
	cik: CIK,
	sic: string | null | undefined,
	options: CIKCorroborationOptions = {}
): CIKCorroborationVerdict {
	if (options.pinnedCIKs?.has(cik)) {
		return { corroborated: true, basis: CIKCorroborationBasis.Pinned }
	}

	const trimmed = (sic ?? "").trim()

	if (!trimmed) {
		return { corroborated: false, basis: CIKCorroborationBasis.NoSIC }
	}

	const accepted = options.acceptedSICCodes ?? TELECOM_SIC_CODES

	return accepted.has(trimmed)
		? { corroborated: true, basis: CIKCorroborationBasis.TelecomSIC, sic: trimmed }
		: { corroborated: false, basis: CIKCorroborationBasis.NonTelecomSIC, sic: trimmed }
}
