/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The five outcome comparators, and the one rule they all obey.
 *
 *   **This module owns no equality of its own.** Every judgment here is delegated to a grader that already
 *   exists and is already tested: `componentMatches` and `DEFAULT_TOL_M` from the Gauntlet's `check-case.ts`,
 *   `haversineKm` from `@mailwoman/spatial`, `compareComponents` from the invariance mini-suite. What lives
 *   here is the part none of them has an opinion about — which AXIS a given law is stated on, and what
 *   `equivalent` / `refines` / `diverges` mean on that axis.
 *
 *   THE AXES ARE DISJOINT ON PURPOSE. `resolution_identity` never reads a coordinate and
 *   `assembled_coordinate` never reads a place id. That separation is the whole reason the comparator set is
 *   closed: an identity law that could fall back to distance would pass whenever two DIFFERENT places
 *   happened to sit inside the tolerance, which is precisely the failure the Gauntlet's own place-identity
 *   gate was added for — Gaborone resolving to an Austrian hamlet came back with the right parsed locality
 *   and only a coordinate 8,045 km away to say so, and a namesake inside a 25 km bar would have had nothing
 *   at all.
 *
 *   AN AXIS ABSENT ON BOTH SIDES IS `undecidable`, NEVER `equivalent`. Two runs that resolved no place agree
 *   about nothing; two empty parses agree about nothing; two outcomes carrying no mechanism account agree
 *   about nothing. Reporting agreement there would let a law pass on a pair of total failures, and the
 *   reading would be indistinguishable from a law that genuinely holds. The reading says what it read, and
 *   the runner counts `undecidable` as a violation with the reason attached.
 *
 *   A `mechanismShapes` of `[]` is a real reading — the account ran and matched no shape. `undefined` is the
 *   absence of an account. The two are kept apart for the same reason the mechanism-account design keeps an
 *   empty lookup list apart from a null one.
 */

import { haversineKm } from "@mailwoman/spatial"

import { componentMatches, DEFAULT_TOL_M } from "../gauntlet/check-case.ts"
import type { GauntletResult } from "../gauntlet/harness.ts"
import { compareComponents } from "../invariance/compare.ts"
import type { ConformanceFixture, ConformanceRelation, OutcomeComparatorName } from "./fixture.ts"

/**
 * One side of a law: the assembled result, plus whatever mechanism account the observer was able to attach.
 */
export interface ConformanceOutcome {
	/**
	 * The assembled result, projected through the Gauntlet's own `toGauntletResult`. Reusing that projection is what
	 * keeps this comparator set and the board's grader from disagreeing about which field a component lives in.
	 */
	result: GauntletResult
	/**
	 * The mechanism-account shapes this run matched, in the account's own seam order.
	 *
	 * The vocabulary is `@mailwoman/dev-mcp`'s `DIAGNOSE_SHAPES`, and it is deliberately NOT imported here: dev-mcp is a
	 * private maintainer workspace that depends on `mailwoman`, so the dependency can only run in that direction, and a
	 * second copy of the vocabulary would drift from the predicates that define it. The observer supplies the labels;
	 * this module compares them and reports what it was given.
	 *
	 * `undefined` means no account was attached — see the module docstring for why that is not an empty account.
	 */
	mechanismShapes?: readonly string[]
}

/**
 * What a comparator observed. `undecidable` is a first-class reading: the comparator could not read its axis, and says
 * so rather than reporting the agreement of two absences.
 */
export type ObservedRelation = ConformanceRelation | "undecidable"

/**
 * One comparator's reading of a pair of outcomes.
 */
export interface ComparatorReading {
	comparator: OutcomeComparatorName
	observed: ObservedRelation
	/**
	 * What the comparator actually read on each side, stated whatever the verdict — the sentence that keeps an absence
	 * from being reported as an agreement.
	 */
	basis: string
	/**
	 * Per-dimension differences, empty when `observed` is `equivalent`.
	 */
	differences: string[]
}

/**
 * Populated component entries, dropping absent and blank values. A blank string is an absent component, not a component
 * whose value is the empty string.
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

//#region resolution_identity

/**
 * The resolved admin chain as stable identity keys, finest first.
 *
 * A `placeID` is namespaced (`wof:1108826319`), so the source travels with the key: two ids minted by different
 * gazetteers can never compare equal by accident, which is the provenance half of "stable identity". An entry with no
 * `placeID` is UNVERIFIABLE, counted apart rather than folded in under its name — a name is not an identity, and
 * counting it as one is how a namesake passes.
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
 * Is `outer` the same chain as `inner` extended at the FINE end? `hierarchy` runs locality → country, so a refinement
 * adds entries at the front and leaves the tail untouched.
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

//#endregion

//#region assembled_coordinate

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

	// Inside tolerance is not enough. The Gauntlet grades tier strictly for the reason its own runner states — an
	// `address_point` that drifts to `admin` is a regression even when the point barely moves — so a tier change is
	// reported as a divergence with both tiers named rather than absorbed by the distance bar.
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

//#endregion

//#region parse_whole_strict

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

//#endregion

//#region component_map

/**
 * Is every populated base component present in the variant with an equal value?
 */
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

	// The invariance suite's severity reading, carried WHATEVER branch is taken below. Its critical-tag rule
	// (house_number / street / postcode) is the judgment this module must not re-invent, and a law that fails
	// still wants to know whether the drift was DEGRADED or LOST.
	const { verdict, diff } = compareComponents(a, b)
	const basis = `compareComponents verdict ${verdict} · base {${aKeys.toSorted().join(", ") || "empty"}} · variant {${bKeys.toSorted().join(", ") || "empty"}}`

	if (verdict === "INVARIANT") {
		return { comparator: "component_map", observed: "equivalent", basis, differences: [] }
	}

	const added = bKeys.filter((tag) => a[tag] === undefined)

	// A refinement law's variant carries MORE information, so `compareComponents`'s hallucination rule does not
	// apply to it: that rule reads a gained critical tag as LOST because its premise is that both sides were fed
	// the same information. Containment plus at least one new component is the refinement reading, and the
	// severity verdict above still travels with it — an invariance law reaches this branch too, sees `refines`
	// where it expected `equivalent`, and fails with LOST printed beside the gained tag.
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

//#endregion

//#region mechanism_shape

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

	// Same members, different order: the account emits shapes in pipeline-seam order, so the sequence carries which
	// seam spoke first and a reordering is a real difference rather than a set equality.
	if (!differences.length) {
		differences.push(`same shapes in a different seam order: [${a.join(", ")}] → [${b.join(", ")}]`)
	}

	return { comparator: "mechanism_shape", observed: "diverges", basis, differences }
}

//#endregion

/**
 * Read a pair of outcomes on the axis the fixture named.
 *
 * Throws on a comparator name outside the closed set. `loadConformanceFixtures` refuses one already, so reaching this
 * means a caller built a fixture by hand and skipped the loader — which is exactly the path that must not default.
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
		default: {
			const unknown: never = fixture.outcomeComparator

			throw new Error(`fixture "${fixture.id}": unknown outcomeComparator ${JSON.stringify(unknown)}`)
		}
	}
}
