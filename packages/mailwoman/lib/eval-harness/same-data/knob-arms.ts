/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `ResolveOpts` arms the same-data `knob` phase replays, read from a JSON file.
 *
 *   A resolver option that the fixture replay ignores produces a column identical to the production arm, and so does
 *   a misspelled option name. The reader rejects an unknown key and a value of the wrong type, so an identical column
 *   means the option had no effect on this panel.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { ResolveOpts } from "@mailwoman/core/resolver"

/**
 * A JSON value type a knob arm may set, or `null` for an option JSON cannot
 * express (a function, a lookup, a map).
 */
type KnobOptionKind = "number" | "boolean" | "string" | "string[]" | "weak-resolution" | null

/**
 * The JSON type of every `ResolveOpts` field.
 *
 * `satisfies` over the required form of `ResolveOpts` makes a new resolver option a compile
 * error here until it is classified, so the key list cannot fall behind the interface.
 */
const KNOB_OPTION_KINDS = {
	maxLookups: "number",
	minWinningScore: "number",
	candidatesPerLookup: "number",
	defaultCountry: "string",
	defaultCountryIsInferred: "boolean",
	fuzzyCountryScope: "string",
	bias: null,
	parentFallback: "boolean",
	placetypeMap: null,
	locale: "string",
	anchorPosterior: null,
	anchorWeight: "number",
	localeCountryPrior: "string",
	localeCountryPriorWeight: "number",
	capitalLevel: null,
	hardCountry: "string",
	addressPoints: null,
	addressPointBboxFallback: "boolean",
	interpolation: null,
	interpolationRadiusCalibration: "number",
	streetCentroids: null,
	streetCountryHints: "string[]",
	spanRescore: "boolean",
	spanRescoreThresholdKm: "number",
	spanRescoreRequireContextRemainder: "boolean",
	spanRescoreWeakResolution: "weak-resolution",
	postalCompoundRecovery: "boolean",
	postcodeConsistency: "boolean",
	postcodeConsistencyThresholdKm: "number",
	postcodeConsistencyMaxMoveKm: "number",
	postcodeCountryCoherence: "boolean",
	postcodeCountryCoherenceThresholdKm: "number",
	postcodeShapeCoherence: "boolean",
	postcodeContainmentCoherence: "boolean",
	postcodePrefixPrior: "boolean",
	postcodeFormatCountries: "string[]",
	postcodePrefixIndex: null,
	adminCoherence: "boolean",
	hierarchyCompletion: "boolean",
	includeAncestors: "boolean",
	adminContainmentRerank: "boolean",
	traceSink: null,
	diagnoseUnreachable: "boolean",
} as const satisfies Record<keyof Required<ResolveOpts>, KnobOptionKind>

const WEAK_RESOLUTION_READINGS = new Set(["score", "containment", "either"])

/**
 * One knob arm: the column label and the options it replays with.
 */
export interface KnobArm {
	label: string
	opts: ResolveOpts
}

function matchesKind(value: unknown, kind: Exclude<KnobOptionKind, null>): boolean {
	switch (kind) {
		case "number":
			return typeof value === "number" && Number.isFinite(value)
		case "boolean":
			return typeof value === "boolean"
		case "string":
			return typeof value === "string"
		case "string[]":
			return Array.isArray(value) && value.every((entry) => typeof entry === "string")
		case "weak-resolution":
			return typeof value === "string" && WEAK_RESOLUTION_READINGS.has(value)
	}
}

/**
 * Validate a parsed arms file: a non-empty array of `{ "label": string, "opts": { … } }` with distinct labels.
 *
 * @throws When an entry is malformed, a label repeats, an option name is not a `ResolveOpts`
 * field, an option cannot be expressed in JSON, or a value has the wrong type.
 * The message names the arm and the option.
 */
export function parseKnobArms(value: unknown, source = "arms file"): KnobArm[] {
	if (!Array.isArray(value) || !value.length) {
		throw new Error(`${source}: expected a non-empty array of { "label", "opts" } arms`)
	}

	const labels = new Set<string>()

	return value.map((entry: unknown, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${source}: arm ${index} is not an object`)
		}

		const { label, opts } = entry as { label?: unknown; opts?: unknown }

		if (typeof label !== "string" || !label.length) {
			throw new Error(`${source}: arm ${index} has no string "label"`)
		}

		if (labels.has(label)) throw new Error(`${source}: arm label "${label}" appears twice`)

		labels.add(label)

		if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
			throw new Error(`${source}: arm "${label}" has no "opts" object`)
		}

		for (const [key, optionValue] of Object.entries(opts)) {
			if (!Object.hasOwn(KNOB_OPTION_KINDS, key)) {
				throw new Error(`${source}: arm "${label}" sets "${key}", which is not a ResolveOpts field`)
			}

			const kind = KNOB_OPTION_KINDS[key as keyof typeof KNOB_OPTION_KINDS]

			if (kind === null) {
				throw new Error(`${source}: arm "${label}" sets "${key}", which a JSON arms file cannot express`)
			}

			if (!matchesKind(optionValue, kind)) {
				throw new Error(`${source}: arm "${label}" sets "${key}" to ${stringifyJSON(optionValue)}; expected ${kind}`)
			}
		}

		return { label, opts: opts as ResolveOpts }
	})
}

/**
 * Read and validate a knob arms file.
 */
export async function readKnobArms(path: string): Promise<KnobArm[]> {
	return parseKnobArms(await readLocalJSONFile<unknown>(path), path)
}
