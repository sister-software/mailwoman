/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The six outcome comparators own no equality of their own and keep their axes disjoint. An identity law therefore never falls back to distance.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { accountRefinement } from "#eval-harness/conformance/candidate-admissibility"
import type { ConformanceFixture, ConformanceRelation, OutcomeComparatorName } from "#eval-harness/conformance/fixture"
import { componentMatches, DEFAULT_TOL_M } from "#eval-harness/gauntlet/check-case"
import type { GauntletResult } from "#eval-harness/gauntlet/harness"
import { compareComponents } from "#eval-harness/invariance/compare"

/**
 * One side of a law: the assembled result, plus whatever mechanism account the observer was able to attach.
 */
export interface ConformanceOutcome {
	/**
	 * The assembled result, projected through the Gauntlet's own `toGauntletResult`
	 * so this comparator set and the board's grader agree on which field a component lives in.
	 */
	result: GauntletResult
	/**
	 * The mechanism-account shapes this run matched, in the account's own stage order,
	 * where `undefined` means no account was attached and is not an empty account.
	 */
	mechanismShapes?: readonly string[]
	/**
	 * The resolver's interior for this run, one record per backend lookup, where `[]` is
	 * a real reading of no lookup and `undefined` the absence of a trace.
	 */
	candidates?: readonly ResolveNodeTrace[]
}

/**
 * What a comparator observed, where `undecidable` means it could not read its axis
 * and `unmeasured` that the axis was read but its window was too small to decide.
 */
export type ObservedRelation = ConformanceRelation | "undecidable" | "unmeasured"

/**
 * One comparator's reading of a pair of outcomes.
 */
export interface ComparatorReading {
	comparator: OutcomeComparatorName
	observed: ObservedRelation
	/**
	 * What the comparator actually read on each side, stated whatever the verdict
	 * so an absence is not reported as an agreement.
	 */
	basis: string
	/**
	 * Per-dimension differences, empty when `observed` is `equivalent`.
	 */
	differences: string[]
}

/**
 * Populated component entries, dropping absent and blank values, since a blank string
 * is an absent component rather than one whose value is the empty string.
 */
function populatedComponents(result: GauntletResult): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [tag, value] of Object.entries(result.components)) {
		if (typeof value === "string" && value.trim()) {
			out[tag] = value
		}
	}

	return out
}

// #region resolution_identity

/**
 * The resolved admin chain as namespaced stable identity keys, finest first,
 * with entries lacking a `placeID` counted apart because a name is not an identity.
 */
function identityChain(result: GauntletResult): { keys: string[]; unverifiable: number } {
	const keys: string[] = []
	let unverifiable = 0

	for (const entry of result.hierarchy) {
		if (entry.placeID) {
			keys.push(`${entry.tag}:${entry.placeID}`)
		} else {
			unverifiable += 1
		}
	}

	return { keys, unverifiable }
}

/**
 * Whether `outer` is the same chain as `inner` extended at the fine end,
 * since `hierarchy` runs locality → country.
 */
function extendsChain(inner: readonly string[], outer: readonly string[]): boolean {
	if (outer.length <= inner.length) return false

	const offset = outer.length - inner.length

	return inner.every((key, index) => outer[index + offset] === key)
}

function compareResolutionIdentity(base: ConformanceOutcome, variant: ConformanceOutcome): ComparatorReading {
	const a = identityChain(base.result)
	const b = identityChain(variant.result)

	const basis =
		`identity chain base [${a.keys.join(" ← ") || "none"}] (${a.unverifiable} unverifiable) · ` +
		`variant [${b.keys.join(" ← ") || "none"}] (${b.unverifiable} unverifiable) · coordinates not read`

	if (!a.keys.length && !b.keys.length) {
		return {
			comparator: "resolution_identity",
			observed: "undecidable",
			basis,
			differences: [
				"neither outcome carries a stable place identity — nothing to compare, and a coordinate is not one",
			],
		}
	}

	if (a.keys.length === b.keys.length && a.keys.every((key, index) => b.keys[index] === key)) {
		return { comparator: "resolution_identity", observed: "equivalent", basis, differences: [] }
	}

	if (extendsChain(a.keys, b.keys)) {
		const added = b.keys.slice(0, b.keys.length - a.keys.length)

		return {
			comparator: "resolution_identity",
			observed: "refines",
			basis,
			differences: [`variant adds ${added.join(", ")} at the fine end of the same chain`],
		}
	}

	return {
		comparator: "resolution_identity",
		observed: "diverges",
		basis,
		differences: [`base [${a.keys.join(" ← ") || "none"}] ≠ variant [${b.keys.join(" ← ") || "none"}]`],
	}
}

// #endregion

// #region assembled_coordinate

function compareAssembledCoordinate(
	fixture: ConformanceFixture,
	base: ConformanceOutcome,
	variant: ConformanceOutcome
): ComparatorReading {
	const toleranceM = fixture.toleranceM ?? DEFAULT_TOL_M
	const a = base.result
	const b = variant.result
	const aResolved = a.lat != null && a.lon != null
	const bResolved = b.lat != null && b.lon != null
	const distanceM = aResolved && bResolved ? haversineKm(a.lat!, a.lon!, b.lat!, b.lon!) * 1000 : null

	const basis =
		`base ${aResolved ? `(${a.lat}, ${a.lon}) tier ${a.tier}` : `abstained, tier ${a.tier}`} · ` +
		`variant ${bResolved ? `(${b.lat}, ${b.lon}) tier ${b.tier}` : `abstained, tier ${b.tier}`} · ` +
		`${distanceM === null ? "no distance" : `${distanceM.toFixed(0)} m`} against a ${toleranceM} m tolerance`

	if (!aResolved && !bResolved) {
		return { comparator: "assembled_coordinate", observed: "equivalent", basis, differences: [] }
	}

	if (!aResolved) {
		return {
			comparator: "assembled_coordinate",
			observed: "refines",
			basis,
			differences: [`base abstained, variant resolved (${b.lat}, ${b.lon}) at tier ${b.tier}`],
		}
	}

	if (!bResolved) {
		return {
			comparator: "assembled_coordinate",
			observed: "diverges",
			basis,
			differences: [`base resolved (${a.lat}, ${a.lon}), variant abstained`],
		}
	}

	if (distanceM! > toleranceM) {
		return {
			comparator: "assembled_coordinate",
			observed: "diverges",
			basis,
			differences: [`coordinate moved ${distanceM!.toFixed(0)} m (tolerance ${toleranceM} m)`],
		}
	}

	// Inside tolerance is not enough: a tier change is reported as a divergence with both
	// tiers listed separately rather than absorbed by the distance bar.
	if (a.tier !== b.tier) {
		return {
			comparator: "assembled_coordinate",
			observed: "diverges",
			basis,
			differences: [`tier ${a.tier} → ${b.tier} inside the ${toleranceM} m tolerance`],
		}
	}

	return { comparator: "assembled_coordinate", observed: "equivalent", basis, differences: [] }
}

// #endregion

// #region parse_whole_strict

function compareParseWholeStrict(base: ConformanceOutcome, variant: ConformanceOutcome): ComparatorReading {
	const a = populatedComponents(base.result)
	const b = populatedComponents(variant.result)
	const aKeys = Object.keys(a).toSorted()
	const bKeys = Object.keys(b).toSorted()
	const basis = `base {${aKeys.join(", ") || "empty"}} · variant {${bKeys.join(", ") || "empty"}} · exact case-folded equality`

	if (!aKeys.length && !bKeys.length) {
		return {
			comparator: "parse_whole_strict",
			observed: "undecidable",
			basis,
			differences: ["neither outcome produced a component — two empty parses agree about nothing"],
		}
	}

	const differences: string[] = []

	for (const tag of new Set([...aKeys, ...bKeys])) {
		const before = a[tag]
		const after = b[tag]

		if (before === undefined) {
			differences.push(`${tag}: ∅ → "${after}"`)
		} else if (after === undefined) {
			differences.push(`${tag}: "${before}" → ∅`)
		} else if (!componentMatches(after, before)) {
			differences.push(`${tag}: "${before}" → "${after}"`)
		}
	}

	return differences.length
		? { comparator: "parse_whole_strict", observed: "diverges", basis, differences: differences.toSorted() }
		: { comparator: "parse_whole_strict", observed: "equivalent", basis, differences: [] }
}

// #endregion

// #region component_map

function containsAll(inner: Record<string, string>, outer: Record<string, string>): boolean {
	return Object.entries(inner).every(([tag, value]) => {
		const found = outer[tag]

		return found !== undefined && componentMatches(found, value)
	})
}

function compareComponentMap(base: ConformanceOutcome, variant: ConformanceOutcome): ComparatorReading {
	const a = populatedComponents(base.result)
	const b = populatedComponents(variant.result)
	const aKeys = Object.keys(a)
	const bKeys = Object.keys(b)

	if (!aKeys.length && !bKeys.length) {
		return {
			comparator: "component_map",
			observed: "undecidable",
			basis: "base {empty} · variant {empty}",
			differences: ["neither outcome produced a component — two empty parses agree about nothing"],
		}
	}

	// The invariance suite's severity reading, whose critical-tag rule this module must not re-invent.
	const { verdict, diff } = compareComponents(a, b)
	const basis = `compareComponents verdict ${verdict} · base {${aKeys.toSorted().join(", ") || "empty"}} · variant {${bKeys.toSorted().join(", ") || "empty"}}`

	if (verdict === "INVARIANT") {
		return { comparator: "component_map", observed: "equivalent", basis, differences: [] }
	}

	const added = bKeys.filter((tag) => a[tag] === undefined)

	// Containment plus at least one new component is the refinement reading, so an invariance
	// law reaching this branch sees `refines` where it expected `equivalent`.
	if (added.length && containsAll(a, b)) {
		return {
			comparator: "component_map",
			observed: "refines",
			basis,
			differences: [`variant adds ${added.toSorted().join(", ")}`, ...diff],
		}
	}

	return { comparator: "component_map", observed: "diverges", basis, differences: diff }
}

// #endregion

// #region mechanism_shape

function compareMechanismShape(base: ConformanceOutcome, variant: ConformanceOutcome): ComparatorReading {
	const a = base.mechanismShapes
	const b = variant.mechanismShapes

	if (!a || !b) {
		const missing = [!a ? "base" : null, !b ? "variant" : null].filter((side) => side !== null)

		return {
			comparator: "mechanism_shape",
			observed: "undecidable",
			basis: `no mechanism account attached to ${missing.join(" and ")}`,
			differences: [
				`the observer attached no mechanism account to ${missing.join(" and ")} — an absent account is not an ` +
					`account that matched no shape (that reads as an empty list)`,
			],
		}
	}

	const basis = `base [${a.join(", ") || "no shape matched"}] · variant [${b.join(", ") || "no shape matched"}]`

	if (a.length === b.length && a.every((shape, index) => b[index] === shape)) {
		return { comparator: "mechanism_shape", observed: "equivalent", basis, differences: [] }
	}

	const onlyBase = a.filter((shape) => !b.includes(shape))
	const onlyVariant = b.filter((shape) => !a.includes(shape))
	const differences: string[] = []

	if (onlyBase.length) {
		differences.push(`only in base: ${onlyBase.join(", ")}`)
	}

	if (onlyVariant.length) {
		differences.push(`only in variant: ${onlyVariant.join(", ")}`)
	}

	// Same members in a different order is a real difference, because the account emits shapes in pipeline-stage order.
	if (!differences.length) {
		differences.push(`same shapes in a different boundary order: [${a.join(", ")}] → [${b.join(", ")}]`)
	}

	return { comparator: "mechanism_shape", observed: "diverges", basis, differences }
}

// #endregion

// #region candidate_admissibility

function compareCandidateAdmissibility(base: ConformanceOutcome, variant: ConformanceOutcome): ComparatorReading {
	const a = base.candidates
	const b = variant.candidates

	if (!a || !b) {
		const missing = [!a ? "base" : null, !b ? "variant" : null].filter((side) => side !== null)

		return {
			comparator: "candidate_admissibility",
			observed: "undecidable",
			basis: `no resolver trace attached to ${missing.join(" and ")}`,
			differences: [
				`the observer attached no resolver trace to ${missing.join(" and ")} — the walk records nothing unless a ` +
					`sink asks it to, so this is tracing being off rather than a run with no lookups (that reads as an empty list)`,
			],
		}
	}

	const reading = accountRefinement(a, b)

	return {
		comparator: "candidate_admissibility",
		observed: reading.relation,
		basis: reading.basis,
		differences: reading.differences,
	}
}

// #endregion

/**
 * Reads a pair of outcomes on the axis specified by the fixture.
 *
 * @throws On a comparator name outside the closed set, which can only come from
 * a hand-built fixture that skipped the loader.
 */
export function compareOutcomes(
	fixture: ConformanceFixture,
	base: ConformanceOutcome,
	variant: ConformanceOutcome
): ComparatorReading {
	switch (fixture.outcomeComparator) {
		case "resolution_identity":
			return compareResolutionIdentity(base, variant)
		case "assembled_coordinate":
			return compareAssembledCoordinate(fixture, base, variant)
		case "parse_whole_strict":
			return compareParseWholeStrict(base, variant)
		case "component_map":
			return compareComponentMap(base, variant)
		case "mechanism_shape":
			return compareMechanismShape(base, variant)
		case "candidate_admissibility":
			return compareCandidateAdmissibility(base, variant)
		default: {
			const unknown: never = fixture.outcomeComparator

			throw new Error(`fixture "${fixture.id}": unknown outcomeComparator ${stringifyJSON(unknown)}`)
		}
	}
}
