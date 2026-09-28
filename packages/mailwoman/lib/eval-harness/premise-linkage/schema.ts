/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The premise-linkage row and report interface, fixed before any controlled data arrives so a
 *   provider's file populates an adapter rather than reshaping the evaluation after results are seen.
 *
 *   The two row types are the privacy design: {@link PremiseLinkageInputRow} carries the licensed
 *   address, the expected identifier, and the truth coordinate in memory only, while
 *   {@link PremiseLinkageResultRow} persists a salted case identifier, shape class, presence booleans,
 *   and closed-set outcomes with no free-text field for an address to leak through.
 *
 *   Every rate is a numerator and denominator as separate fields; no field stores a precomputed ratio.
 */

/**
 * How the input was shaped relative to the authoritative record it should link to; the reporting
 * axis that localizes an arm's effect to a register instead of averaging wins and losses.
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
 * Which components the input actually carried, as booleans rather than values:
 * naming a postcode is a reporting axis, naming a full postcode is a licensed field.
 */
export interface PremiseLinkagePresence {
	hasUnit: boolean
	hasPostcode: boolean
	hasStreet: boolean
	hasLocality: boolean
	hasHistoricalAlias: boolean
}

/**
 * One authoritative identifier, named by the scheme it belongs to; the scheme is carried per row
 * so a non-UK register grades against its own namespace without a second row type.
 */
export interface PremiseLinkageObjectID {
	scheme: string
	id: string
}

/**
 * Private: one controlled row as the adapter reads it, licensed fields included,
 * held in memory for one run and never serialized.
 */
export interface PremiseLinkageInputRow extends PremiseLinkagePresence {
	/**
	 * The address to grade, verbatim.
	 */
	input: string
	/**
	 * The identifier the register holds for this premise, held only while grading.
	 */
	expectedObjectID: PremiseLinkageObjectID
	/**
	 * Truth coordinate, when the row has one; absent means unmeasured, never zero.
	 */
	expectedLat?: number
	expectedLon?: number
	/**
	 * Whether the provider's terms permit a coordinate error to appear in a published aggregate;
	 * false keeps the row in every identifier metric and out of every coordinate one.
	 */
	coordinatePublishable: boolean
	inputShapeClass: PremiseLinkageInputShapeClass
}

/**
 * What one arm did with one row: `refused` and `ambiguous` are first-class
 * and never recorded as `wrong`, and an ambiguous answer is never `exact`.
 *
 * `errored` is not an outcome the arm produced — it marks a row that could not be graded
 * at all — and is excluded from every rate and reported as its own count.
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
 * Why a row was not `exact`, from a closed set rather than free text that could
 * carry an address or a provider payload.
 */
export const PremiseLinkageFailureCategory = {
	/**
	 * The arm names no premise identifier at all, the open arm's structural state
	 * rather than a failure of this row.
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
	 * The provider committed to a premise and named a different identifier than the register holds.
	 */
	IdentifierMismatch: "identifier_mismatch",
	/**
	 * The provider committed to a premise but named no identifier in the graded scheme —
	 * ungradable rather than wrong.
	 */
	SchemeAbsent: "scheme_absent",
	/**
	 * The provider threw — network, auth, timeout — which is never a refusal.
	 */
	TransportError: "transport_error",
} as const

export type PremiseLinkageFailureCategory =
	(typeof PremiseLinkageFailureCategory)[keyof typeof PremiseLinkageFailureCategory]

/**
 * Persistable: one arm's graded answer for one row, carrying no field that can be
 * joined back to a premise without the run's salt.
 */
export interface PremiseLinkageResultRow extends PremiseLinkagePresence {
	/**
	 * `sha256(salt ‖ NUL ‖ input)`, truncated.
	 *
	 * Two runs under different salts share no case identifier, so published results
	 * cannot be joined into a longer record of the same premises.
	 */
	caseID: string
	inputShapeClass: PremiseLinkageInputShapeClass
	outcome: PremiseLinkageOutcome
	/**
	 * Carried so the report writer can refuse a coordinate on a row whose terms forbid one;
	 * a permission flag is not a licensed value.
	 */
	coordinatePublishable: boolean
	/**
	 * Great-circle error in meters, present only when {@link coordinatePublishable} is true,
	 * the row carried a truth coordinate, and the arm produced one.
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
 * A numerator and the denominator it was measured against, both always stated
 * and neither inferred from the other.
 */
export interface PremiseLinkageCount {
	n: number
	of: number
}

/**
 * Whether the registered evaluation policy required a unique answer: under `abstain_ok`
 * a refusal leaves the eligible set, and under `unique_required` it stays in the
 * denominator while still being recorded as `refused`.
 */
export const PremiseLinkagePolicy = {
	UniqueRequired: "unique_required",
	AbstainPermitted: "abstain_ok",
} as const

export type PremiseLinkagePolicy = (typeof PremiseLinkagePolicy)[keyof typeof PremiseLinkagePolicy]

/**
 * Whether the run read controlled data or the shipped synthetic fixture, stamped into the
 * report so a self-check can never be read as a measurement of a real register.
 */
export const PremiseLinkageMode = {
	Synthetic: "synthetic",
	Controlled: "controlled",
} as const

export type PremiseLinkageMode = (typeof PremiseLinkageMode)[keyof typeof PremiseLinkageMode]

/**
 * The four identifier rates: `exact` and `wrong` over eligible rows, `refused`
 * and `ambiguous` over all rows.
 */
export interface PremiseLinkageRates {
	exactOverEligible: PremiseLinkageCount
	wrongOverEligible: PremiseLinkageCount
	refusedOverAll: PremiseLinkageCount
	ambiguousOverAll: PremiseLinkageCount
}

/**
 * One coordinate threshold and how many gradable rows met it, over a denominator smaller than the run.
 */
export interface PremiseLinkageCoordinateThreshold {
	thresholdM: number
	withinThreshold: PremiseLinkageCount
}

/**
 * One arm's aggregate; `perClass` is partial, so a class with no rows
 * or a suppressed cell is absent rather than reported as zero.
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
 * The arm-to-arm movement over all rows: `changed` counts rows whose outcome differs and `improved`
 * and `regressed` are its directional halves, with ungradable rows in the denominator and no numerator.
 */
export interface PremiseLinkageComparison {
	baselineArm: string
	candidateArm: string
	changed: PremiseLinkageCount
	improved: PremiseLinkageCount
	regressed: PremiseLinkageCount
}

/**
 * The publishable aggregate; rows never appear here.
 */
export interface PremiseLinkageReport {
	mode: PremiseLinkageMode
	mailwomanVersion: string
	policy: PremiseLinkagePolicy
	/**
	 * The minimum agreed with the data provider; a per-class cell below it is removed before publication.
	 */
	minCellSize: number
	/**
	 * How many cells the writer removed; zero means none were removed, which is distinct
	 * from no cells being small only if this number is visible.
	 */
	suppressedCells: number
	arms: PremiseLinkageArmReport[]
	comparison: PremiseLinkageComparison
}
