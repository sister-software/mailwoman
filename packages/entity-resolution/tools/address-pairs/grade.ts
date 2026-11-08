/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grades duplicate-detection arms against an adjudicated address pair set, per stratum.
 *
 *   An arm predicts, for each pair, whether the lower-ranked row repeats the higher-ranked row's delivery point and may
 *   be dropped. Each arm reads the unit as a precondition: two rows whose unit identifiers differ, or of which one
 *   states a unit and the other none, are different delivery points, because dropping the unit row would lose the
 *   unit.
 *
 *   - `rule` is the deterministic rule the layer build applies: the same postcode key, the same unit text, and points
 *     within 0.002 degrees.
 *   - `rule-unit-identifier` is that rule with the unit compared by identifier, so `#2` and `UNIT 2` agree.
 *   - `fellegi-sunter` scores the postcode, locality and distance with `@mailwoman/match`. Its `m` and
 *     `u` are fitted by EM on an unlabeled population of candidate pairs, never on the labels. A point a source
 *     shares among more than five addresses locates none of them, so a pair touching one has no distance evidence.
 *
 *   A pair adjudicated `unsure` is left out of every count.
 */

import { normalizeAddressToken } from "@mailwoman/codex/address/key"
import { usUnitIdentifier } from "@mailwoman/codex/us/unit/designator"
import {
	agreementPattern,
	type Comparison,
	type ComparisonLevel,
	distanceComparison,
	estimateParameters,
	type FellegiSunterModel,
	scorePair,
} from "@mailwoman/match"

import type { AddressPair, AddressPairRecord, AddressPairStratum } from "#tools/address-pairs/sample"

/**
 * The counts and rates of one arm over one set of pairs.
 */
export interface ArmGrade {
	truePositive: number
	falsePositive: number
	falseNegative: number
	trueNegative: number
	precision: number | null
	recall: number | null
}

/**
 * One arm's predictions and grades.
 */
export interface ArmResult {
	arm: string
	overall: ArmGrade
	byStratum: Partial<Record<AddressPairStratum, ArmGrade>>
	/**
	 * Every pair the arm got wrong, for inspection.
	 */
	errors: Array<{
		pairID: string
		stratum: AddressPairStratum
		predicted: boolean
		label: boolean
		score: number | null
	}>
}

/**
 * Distinct addresses a source may place at one point before the point stops locating any one of them.
 */
export const STACKED_POINT_ADDRESSES = 5

const RULE_DEGREES = 0.002

/**
 * A record's unit identifier, read again from its unit text against its own number and street.
 */
export function unitIdentifierOf(record: AddressPairRecord): string | null {
	return usUnitIdentifier(record.unit, { number: record.number, street: record.streetRaw })
}

/**
 * Whether two records state the same unit by identifier, or neither states one.
 */
export function unitsAgree(a: AddressPairRecord, b: AddressPairRecord): boolean {
	return unitIdentifierOf(a) === unitIdentifierOf(b)
}

function grade(outcomes: ReadonlyArray<{ predicted: boolean; label: boolean }>): ArmGrade {
	let truePositive = 0
	let falsePositive = 0
	let falseNegative = 0
	let trueNegative = 0

	for (const { predicted, label } of outcomes) {
		if (predicted && label) {
			truePositive++
		} else if (predicted) {
			falsePositive++
		} else if (label) {
			falseNegative++
		} else {
			trueNegative++
		}
	}

	return {
		truePositive,
		falsePositive,
		falseNegative,
		trueNegative,
		precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
		recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null,
	}
}

function gradeArm(
	arm: string,
	pairs: readonly AddressPair[],
	predict: (pair: AddressPair) => { predicted: boolean; score: number | null }
): ArmResult {
	const rows = pairs.map((pair) => ({ pair, label: pair.adjudication === "same-address", ...predict(pair) }))
	const strata = new Set(rows.map((row) => row.pair.stratum))

	return {
		arm,
		overall: grade(rows),
		byStratum: Object.fromEntries(
			[...strata].map((stratum) => [stratum, grade(rows.filter((row) => row.pair.stratum === stratum))])
		),
		errors: rows
			.filter((row) => row.predicted !== row.label)
			.map((row) => ({
				pairID: row.pair.pairID,
				stratum: row.pair.stratum,
				predicted: row.predicted,
				label: row.label,
				score: row.score,
			})),
	}
}

const postcodeComparison: Comparison<AddressPairRecord> = {
	name: "postcode",
	levels: [
		{ label: "same", m: 0.9, u: 0.5 },
		{ label: "different", m: 0.1, u: 0.5 },
	],
	assess: (a, b) =>
		a.postcode && b.postcode && a.postcode !== "0" && b.postcode !== "0" ? (a.postcode === b.postcode ? 0 : 1) : -1,
}

const localityKeys = (record: AddressPairRecord) =>
	new Set(record.localities.map((name) => normalizeAddressToken(name)).filter((name) => name.length > 0))

const localityComparison: Comparison<AddressPairRecord> = {
	name: "locality",
	levels: [
		{ label: "shared-name", m: 0.85, u: 0.3 },
		{ label: "no-shared-name", m: 0.15, u: 0.7 },
	],
	assess(a, b) {
		const ka = localityKeys(a)
		const kb = localityKeys(b)

		if (!ka.size || !kb.size) return -1

		return [...ka].some((name) => kb.has(name)) ? 0 : 1
	},
}

/**
 * Seed distance levels for address points: one building, one block, one neighborhood, one town, and farther.
 */
export const ADDRESS_POINT_DISTANCE_LEVELS: ComparisonLevel[] = [
	{ label: "same-building", maxKm: 0.05, m: 0.6, u: 0.05 },
	{ label: "same-block", maxKm: 0.5, m: 0.3, u: 0.15 },
	{ label: "same-neighborhood", maxKm: 2, m: 0.07, u: 0.2 },
	{ label: "same-town", maxKm: 10, m: 0.02, u: 0.3 },
	{ label: "far", m: 0.01, u: 0.3 },
]

/**
 * Builds the address-point Fellegi-Sunter model over postcode, locality and distance.
 *
 * The house number is left out: every pair of a postcode key group shares it, so it gives no evidence.
 */
export function addressPointModel(): FellegiSunterModel<AddressPairRecord> {
	const distance = distanceComparison<AddressPairRecord>({
		name: "distance",
		extract: (r) => ({ latitude: r.lat, longitude: r.lon }),
		levels: ADDRESS_POINT_DISTANCE_LEVELS.map((level) => ({ ...level })),
	})

	return {
		lambda: 0.5,
		comparisons: [
			postcodeComparison,
			localityComparison,
			{
				...distance,
				assess: (a, b) =>
					a.stack > STACKED_POINT_ADDRESSES || b.stack > STACKED_POINT_ADDRESSES ? -1 : distance.assess(a, b),
			},
		],
	}
}

/**
 * Fits the address-point model by EM on the population pairs whose units agree, the pairs the model decides.
 */
export function fitAddressPointModel(population: readonly AddressPair[]): {
	model: FellegiSunterModel<AddressPairRecord>
	lambda: number
	converged: boolean
	fittedOn: number
} {
	const base = addressPointModel()
	const decided = population.filter((pair) => unitsAgree(pair.higher, pair.lower))
	const patterns = decided.map((pair) => agreementPattern(base.comparisons, pair.higher, pair.lower))
	const fitted = estimateParameters(base, patterns)

	return { model: fitted.model, lambda: fitted.lambda, converged: fitted.converged, fittedOn: decided.length }
}

/**
 * Grades the three arms over the adjudicated pairs.
 *
 * @param population The unlabeled candidate pairs EM is fitted on.
 * @param threshold The match probability at or above which the Fellegi-Sunter arm drops the lower row.
 */
export function gradeAddressPairs(
	pairs: readonly AddressPair[],
	population: readonly AddressPair[],
	threshold = 0.5
): {
	arms: ArmResult[]
	model: FellegiSunterModel<AddressPairRecord>
	lambda: number
	converged: boolean
	fittedOn: number
	graded: number
	unsure: number
} {
	const graded = pairs.filter(
		(pair) => pair.adjudication === "same-address" || pair.adjudication === "different-address"
	)

	const fitted = fitAddressPointModel(population)
	const sameKey = (pair: AddressPair) => pair.stratum !== "postcode-differs"

	const degrees = (pair: AddressPair) =>
		Math.max(Math.abs(pair.higher.lat - pair.lower.lat), Math.abs(pair.higher.lon - pair.lower.lon))

	const arms = [
		gradeArm("rule", graded, (pair) => ({ predicted: pair.ruleDrops, score: null })),
		gradeArm("rule-unit-identifier", graded, (pair) => ({
			predicted: sameKey(pair) && unitsAgree(pair.higher, pair.lower) && degrees(pair) <= RULE_DEGREES,
			score: null,
		})),
		gradeArm("fellegi-sunter", graded, (pair) => {
			const { probability } = scorePair(fitted.model, pair.higher, pair.lower)

			return { predicted: unitsAgree(pair.higher, pair.lower) && probability >= threshold, score: probability }
		}),
	]

	return {
		arms,
		model: fitted.model,
		lambda: fitted.lambda,
		converged: fitted.converged,
		fittedOn: fitted.fittedOn,
		graded: graded.length,
		unsure: pairs.length - graded.length,
	}
}
