/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What a layer lookup can report, with each outcome's meaning fixed so callers cannot conflate them.
 *
 *   Today's readers already behave this way, case by case: a provider with no database for a country
 *   answers an empty bundle and the ladder moves on, a lookup with no match returns `null`, and an
 *   OpenStreetMap extract whose license a configured refusal names stops the session. These
 *   declarations name those cases so a catalog can report them without translating one into another.
 */

/**
 * The outcome of consulting one role for one scope.
 */
export const LayerOutcome = {
	/**
	 * The lookup matched and returned a value.
	 */
	Answered: "answered",
	/**
	 * No artifact is selected for the role and scope, or the selected artifact is not installed.
	 *
	 * The next source in the selection order is consulted, and after the last one
	 * resolution continues at a coarser tier.
	 * An absent layer is not evidence about the address.
	 */
	Absent: "absent",
	/**
	 * The artifact opened and the lookup found no match.
	 *
	 * The next source in the order is not consulted, because the first readable source answers.
	 * Without coverage evidence for the location, a miss supports no claim that the address does not exist.
	 */
	Unsuccessful: "unsuccessful",
	/**
	 * The selected artifact exists and cannot be used: it does not open, fails integrity
	 * or digest checks, or has a schema or normalization the reader does not support.
	 *
	 * This is an error whose message includes the artifact's path.
	 * It is never reported as an absent layer.
	 */
	Unreadable: "unreadable",
	/**
	 * A configured obligation refusal applies to the selected artifact's license.
	 *
	 * The refusal stops the caller and repeats the artifact's recorded provenance.
	 * It is never reported as an absent layer, because the customer chose to refuse data that is present.
	 */
	Refused: "refused",
} as const

export type LayerOutcome = (typeof LayerOutcome)[keyof typeof LayerOutcome]

/**
 * Why a selected artifact was unreadable.
 */
export const UnreadableReason = {
	/**
	 * The file could not be opened or read, such as a permission failure.
	 */
	Unopenable: "unopenable",
	/**
	 * The bytes do not match the artifact's identity or fail an integrity check.
	 */
	Corrupt: "corrupt",
	/**
	 * The manifest is missing or lacks required metadata.
	 */
	Unmanifested: "unmanifested",
	/**
	 * The schema version or normalization is one the reader does not support.
	 */
	Unsupported: "unsupported",
} as const

export type UnreadableReason = (typeof UnreadableReason)[keyof typeof UnreadableReason]

/**
 * A layer lookup's outcome with the fields each case must report.
 */
export type LayerLookupOutcome<T> =
	| { outcome: typeof LayerOutcome.Answered; value: T; path: string }
	| { outcome: typeof LayerOutcome.Absent }
	| { outcome: typeof LayerOutcome.Unsuccessful; path: string }
	| { outcome: typeof LayerOutcome.Unreadable; path: string; reason: UnreadableReason; detail: string }
	| { outcome: typeof LayerOutcome.Refused; path: string; refusal: string; detail: string }

/**
 * A selected artifact that exists and cannot be used, naming its path.
 */
export class UnreadableArtifactError extends Error {
	readonly path: string
	readonly reason: UnreadableReason

	constructor(path: string, reason: UnreadableReason, detail: string, options?: ErrorOptions) {
		super(`${path} is unreadable (${reason}): ${detail}`, options)
		this.name = "UnreadableArtifactError"
		this.path = path
		this.reason = reason
	}
}

/**
 * Whether the selection order moves to its next source after this outcome.
 *
 * Only an absent layer does.
 * An unreadable or refused artifact stops the caller, and an unsuccessful lookup
 * is the answer of the first readable source.
 */
export function consultsNextSource(outcome: LayerOutcome): boolean {
	return outcome === LayerOutcome.Absent
}
