/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The premise-linkage row and report contract (#1902) — fixed BEFORE any controlled data arrives, so
 *   a provider's file populates an adapter rather than reshaping the evaluation after results are
 *   seen.
 *
 *   Two row types, and the split is the whole privacy design. {@link PremiseLinkageInputRow} is
 *   PRIVATE: it carries the licensed address, the expected authoritative identifier, and the truth
 *   coordinate, and it exists only in memory for the length of one run.
 *   {@link PremiseLinkageResultRow} is what may be PERSISTED: a salted case identifier, the shape
 *   class, the presence booleans, one outcome from a closed set, and a failure category from a closed
 *   set. There is no free-text field on the persistable row, because free text is how an address
 *   leaks.
 *
 *   Every rate in {@link PremiseLinkageReport} is a {@link PremiseLinkageCount} — a numerator and its
 *   denominator as separate fields. Nothing here stores a precomputed ratio: a ratio cannot say
 *   whether it was measured over three rows or three thousand, and a reader who cannot see the
 *   denominator cannot tell a result from a rounding artifact.
 */

/**
 * How the input was shaped relative to the authoritative record it should link to. The reporting axis: a per-class
 * table localizes an arm's effect to a register instead of averaging wins and losses into one number.
 */
export const PremiseLinkageInputShapeClass = {
	/**
	 * The address as the register itself writes it.
	 */
	Clean: "clean",
	/**
	 * One or more tokens misspelled.
	 */
	Misspelled: "misspelled",
	/**
	 * The register's own tokens, in a different order.
	 */
	Reordered: "reordered",
	/**
	 * A superseded name the register still cross-references.
	 */
	Historic: "historic",
	/**
	 * A unit inside a building that holds several.
	 */
	MultiUnit: "multi_unit",
} as const

export type PremiseLinkageInputShapeClass =
	(typeof PremiseLinkageInputShapeClass)[keyof typeof PremiseLinkageInputShapeClass]

/**
 * Every shape class, in report order.
 */
export const PREMISE_LINKAGE_SHAPE_CLASSES: ReadonlyArray<PremiseLinkageInputShapeClass> = [
	PremiseLinkageInputShapeClass.Clean,
	PremiseLinkageInputShapeClass.Misspelled,
	PremiseLinkageInputShapeClass.Reordered,
	PremiseLinkageInputShapeClass.Historic,
	PremiseLinkageInputShapeClass.MultiUnit,
]

/**
 * Which components the input actually carried. Booleans, never the values: "this row named a postcode" is a reporting
 * axis, "this row named SW1A 1AA" is a licensed field.
 */
export interface PremiseLinkagePresence {
	hasUnit: boolean
	hasPostcode: boolean
	hasStreet: boolean
	hasLocality: boolean
	hasHistoricalAlias: boolean
}

/**
 * One authoritative identifier, named by the scheme it belongs to (`{ scheme: "uprn", id: "…" }`). The scheme is
 * carried per row rather than assumed, so a run against a non-UK register grades against its own namespace without a
 * second row type.
 */
export interface PremiseLinkageObjectID {
	scheme: string
	id: string
}

/**
 * PRIVATE. One controlled row as the adapter reads it — licensed fields included. Held in memory for one run and never
 * serialized: nothing in this repository writes this type to disk.
 */
export interface PremiseLinkageInputRow extends PremiseLinkagePresence {
	/**
	 * The address to grade, verbatim.
	 */
	input: string
	/**
	 * The identifier the register holds for this premise — the grading truth, held only while grading.
	 */
	expectedObjectID: PremiseLinkageObjectID
	/**
	 * Truth coordinate, when the row has one. Absent means UNMEASURED, never zero: a row without a truth coordinate is
	 * excluded from the coordinate table rather than counted as a miss.
	 */
	expectedLat?: number
	expectedLon?: number
	/**
	 * Whether the provider's terms permit a coordinate ERROR to appear in a published aggregate. False keeps the row in
	 * every identifier metric and out of every coordinate one.
	 */
	coordinatePublishable: boolean
	inputShapeClass: PremiseLinkageInputShapeClass
}

/**
 * What one arm did with one row.
 *
 * `refused` and `ambiguous` are first-class, exactly as the #1901 contract makes them: a refusal is an arm that
 * declined to name a premise, and an ambiguous answer keeps its candidates. Neither is ever recorded as `wrong`, and an
 * ambiguous answer is never recorded as `exact`.
 *
 * `errored` is NOT an outcome the arm produced — it marks a row that could not be graded at all (a transport failure,
 * or a match that named no identifier in the graded scheme). It is excluded from every rate and reported as its own
 * count, because folding an unreadable row into a denominator turns "I could not measure this" into "there was none of
 * it".
 */
export const PremiseLinkageOutcome = {
	Exact: "exact",
	Wrong: "wrong",
	Refused: "refused",
	Ambiguous: "ambiguous",
	Errored: "errored",
} as const

export type PremiseLinkageOutcome = (typeof PremiseLinkageOutcome)[keyof typeof PremiseLinkageOutcome]

/**
 * Why a row was not `exact`, from a CLOSED set. Deliberately not free text: a free-text reason field is where an
 * address, a provider payload, or a stack trace carrying either one ends up.
 */
export const PremiseLinkageFailureCategory = {
	/**
	 * The arm names no premise identifier at all. The open arm's structural state — it has no authoritative namespace to
	 * answer in, which is the gap the authoritative arm exists to measure rather than a failure of this row.
	 */
	ArmAssertsNoIdentifier: "arm_asserts_no_identifier",
	/**
	 * The provider answered and declined (out of coverage, below its own floor, query shape out of scope).
	 */
	ProviderRefused: "provider_refused",
	/**
	 * The provider returned candidates it would not decide between.
	 */
	ProviderAmbiguous: "provider_ambiguous",
	/**
	 * The provider committed to a premise and named a DIFFERENT identifier than the register holds.
	 */
	IdentifierMismatch: "identifier_mismatch",
	/**
	 * The provider committed to a premise but named no identifier in the graded scheme — ungradable, not wrong.
	 */
	SchemeAbsent: "scheme_absent",
	/**
	 * The provider threw: network, auth, timeout. Never a refusal.
	 */
	TransportError: "transport_error",
} as const

export type PremiseLinkageFailureCategory =
	(typeof PremiseLinkageFailureCategory)[keyof typeof PremiseLinkageFailureCategory]

/**
 * PERSISTABLE. One arm's graded answer for one row, carrying nothing that can be joined back to a premise without the
 * run's salt.
 */
export interface PremiseLinkageResultRow extends PremiseLinkagePresence {
	/**
	 * `sha256(salt ‖ NUL ‖ input)`, truncated. Two runs under different salts share no case identifier, so published
	 * results cannot be joined into a longer record of the same premises.
	 */
	caseID: string
	inputShapeClass: PremiseLinkageInputShapeClass
	outcome: PremiseLinkageOutcome
	/**
	 * Carried so the report writer can REFUSE a coordinate on a row whose terms forbid one. A permission flag is not a
	 * licensed value; the check it enables is only possible if the flag travels with the row.
	 */
	coordinatePublishable: boolean
	/**
	 * Great-circle error in meters between the truth coordinate and the coordinate this arm answered with. Present only
	 * when {@link coordinatePublishable} is true, the row carried a truth coordinate, and the arm produced one.
	 */
	coordinateErrorM?: number
	/**
	 * The provider consulted for this arm, or `"none"` for the open arm.
	 */
	providerName: string
	providerDatasetVersion?: string
	mailwomanVersion: string
	failureCategory?: PremiseLinkageFailureCategory
}

/**
 * A numerator and the denominator it was measured against. Both are always stated; neither is ever inferred from the
 * other.
 */
export interface PremiseLinkageCount {
	n: number
	of: number
}

/**
 * Whether the registered evaluation policy required a unique answer.
 *
 * This is the ONLY thing that moves a refusal into a denominator. Under `abstain_ok` a refusal leaves the eligible set,
 * because an arm that declined was not asked to be right. Under `unique_required` it stays in the denominator — and it
 * is still recorded as `refused`, never rewritten to `wrong`. The policy changes what a rate is measured over; it never
 * changes what an arm did.
 */
export const PremiseLinkagePolicy = {
	UniqueRequired: "unique_required",
	AbstainPermitted: "abstain_ok",
} as const

export type PremiseLinkagePolicy = (typeof PremiseLinkagePolicy)[keyof typeof PremiseLinkagePolicy]

/**
 * Whether the run read controlled data or the shipped synthetic fixture. Stamped into the report so a synthetic
 * self-check can never be read as a measurement of a real register.
 */
export const PremiseLinkageMode = {
	Synthetic: "synthetic",
	Controlled: "controlled",
} as const

export type PremiseLinkageMode = (typeof PremiseLinkageMode)[keyof typeof PremiseLinkageMode]

/**
 * The four identifier rates, each with its own denominator. `exact` and `wrong` are measured over ELIGIBLE rows (see
 * {@link PremiseLinkagePolicy}); `refused` and `ambiguous` over ALL rows, so a reader can see how much of the run each
 * abstention class accounts for without reconstructing it.
 */
export interface PremiseLinkageRates {
	exactOverEligible: PremiseLinkageCount
	wrongOverEligible: PremiseLinkageCount
	refusedOverAll: PremiseLinkageCount
	ambiguousOverAll: PremiseLinkageCount
}

/**
 * One coordinate threshold and how many gradable rows met it. The denominator is rows carrying PUBLISHABLE coordinate
 * truth, which is smaller than the run — stated here rather than assumed equal to the row count.
 */
export interface PremiseLinkageCoordinateThreshold {
	thresholdM: number
	withinThreshold: PremiseLinkageCount
}

/**
 * One arm's aggregate. `perClass` is partial: a class with no rows is ABSENT rather than reported as zero, and a class
 * suppressed for cell size is removed the same way — an absent class means "not published here", which is what both
 * cases are.
 */
export interface PremiseLinkageArmReport {
	arm: string
	providerName: string
	providerDatasetVersion?: string
	rowsRead: number
	erroredOverAll: PremiseLinkageCount
	overall: PremiseLinkageRates
	perClass: Partial<Record<PremiseLinkageInputShapeClass, PremiseLinkageRates>>
	coordinateThresholds: PremiseLinkageCoordinateThreshold[]
}

/**
 * The arm-to-arm movement, all three counted over ALL rows. `changed` counts rows whose outcome differs; `improved` and
 * `regressed` are the directional halves of it. Rows that could not be graded in both arms contribute to no numerator
 * and stay in the denominator, so the three numbers never add up to more than the run.
 */
export interface PremiseLinkageComparison {
	baselineArm: string
	candidateArm: string
	changed: PremiseLinkageCount
	improved: PremiseLinkageCount
	regressed: PremiseLinkageCount
}

/**
 * The publishable aggregate. Rows never appear here — the report is what leaves the controlled environment, and the
 * rows are what the report was computed from.
 */
export interface PremiseLinkageReport {
	mode: PremiseLinkageMode
	mailwomanVersion: string
	policy: PremiseLinkagePolicy
	/**
	 * The minimum agreed with the data provider. A per-class cell whose denominator falls below it is removed before
	 * publication.
	 */
	minCellSize: number
	/**
	 * How many cells the writer removed. Zero means none were removed, which is a different statement from "no cells were
	 * small" only if you can see this number — which is why it is always present.
	 */
	suppressedCells: number
	arms: PremiseLinkageArmReport[]
	comparison: PremiseLinkageComparison
}
