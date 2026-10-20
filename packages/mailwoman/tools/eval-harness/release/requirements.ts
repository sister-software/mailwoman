/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The release-requirement specification: the versioned, committed declaration a release candidate is
 *   evaluated against. It is independent of `scope.config.json`, which describes training coverage.
 *
 *   A numerical threshold is `null` until it is registered. A `null` threshold never defaults to a value: the
 *   evaluator reports the check it governs as insufficient evidence. The reader refuses a malformed
 *   specification rather than filling a field.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import type { HeldoutProvenance, HeldoutRowKind } from "#tools/eval-harness/heldout/per/country"

/**
 * The specification format version this reader accepts.
 */
export const RELEASE_SPEC_SCHEMA_VERSION = 1

/**
 * The multiple-comparison corrections the evaluator implements for simultaneous bounds.
 */
export const MultipleComparisonMethod = {
	Bonferroni: "bonferroni",
	Sidak: "sidak",
} as const

export type MultipleComparisonMethod = (typeof MultipleComparisonMethod)[keyof typeof MultipleComparisonMethod]

const PROVENANCE_CLASSES: readonly HeldoutProvenance[] = ["verified_unseen", "known_overlap", "unknown"]
const ROW_KINDS: readonly HeldoutRowKind[] = ["address", "gazetteer"]

/**
 * Which held-out rows a requirement or the objective reads.
 */
export interface RowSelector {
	/**
	 * Row kinds admitted; an absent list admits every kind.
	 */
	kinds?: HeldoutRowKind[]
	/**
	 * Row sources admitted; an absent list admits every source.
	 */
	sources?: string[]
	/**
	 * Countries admitted; an absent list admits every country.
	 */
	countries?: string[]
}

/**
 * A required country: its candidate exact parse rate must meet `minimum`.
 */
export interface CountryRequirement {
	id: string
	kind: "country"
	country: string
	/**
	 * Why the product requires this country.
	 */
	reason: string
	/**
	 * Minimum candidate exact parse rate in `[0, 1]`, or `null` while unregistered.
	 */
	minimum: number | null
	select?: Omit<RowSelector, "countries">
}

/**
 * A required capability: an address task with its own expected behavior,
 * scored by exact parse on the rows its selector names.
 */
export interface CapabilityRequirement {
	id: string
	kind: "capability"
	/**
	 * The address task, such as recovering a unit or reading a PO Box.
	 */
	task: string
	metric: "exact_parse"
	reason: string
	minimum: number | null
	/**
	 * The largest permitted loss, `published - candidate`, in exact parse rate.
	 *
	 * Absent or `null` registers no additional loss limit; the minimum still applies.
	 */
	maxLoss?: number | null
	maxLossReason?: string
	select: RowSelector
}

export type ReleaseRequirement = CountryRequirement | CapabilityRequirement

/**
 * An identity the evaluation is tied to.
 * `sha256` is `null` while unregistered.
 */
export interface ArtifactIdentity {
	description: string
	sha256: string | null
}

export interface ReleaseRequirementSpec {
	schemaVersion: typeof RELEASE_SPEC_SCHEMA_VERSION
	/**
	 * This specification's own version.
	 * A change to any requirement creates a new version.
	 */
	specVersion: string
	rationale: string
	requirements: ReleaseRequirement[]
	objective: {
		/**
		 * The fixed objective country set C; Q is the equal-weight mean of per-country exact parse rates.
		 */
		countries: string[]
		select?: Omit<RowSelector, "countries">
		/**
		 * Minimum `Q_candidate - Q_published`, or `null` while unregistered.
		 */
		minimumImprovement: number | null
	}
	identities: {
		dataset: { id: string | null; sha256: string | null }
		scorer: { id: string; revision: string }
		inference: { description: string; options: Record<string, unknown> }
		published: ArtifactIdentity
		candidate: ArtifactIdentity
	}
	statistics: {
		/**
		 * Simultaneous confidence level in `(0, 1)`, or `null` while unregistered.
		 */
		confidenceLevel: number | null
		multipleComparison: MultipleComparisonMethod
		/**
		 * The resampling unit.
		 *
		 * `group` resamples by a row's grouping metadata and falls back to row identity.
		 */
		samplingUnit: "group"
		groupingAssumption: string
		resamples: number
		seed: number
		/**
		 * Required interval half-width, or `null` while unregistered.
		 * Reported against, never defaulted.
		 */
		requiredPrecision: number | null
	}
	provenance: {
		/**
		 * The provenance classes comparative claims may use.
		 * Every class is reported; only these decide.
		 */
		admitted: HeldoutProvenance[]
	}
	evaluations: {
		development: { id: string | null; description: string }
		confirmation: { id: string | null; description: string }
	}
}

class SpecError extends Error {
	constructor(source: string, path: string, problem: string) {
		super(`${source}: ${path} ${problem}`)
		this.name = "ReleaseSpecError"
	}
}

type Check = (value: unknown, path: string) => void

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value)
}

/**
 * Validates a parsed specification and returns it typed, or throws naming the first malformed field.
 */
export function validateReleaseSpec(input: unknown, source = "release spec"): ReleaseRequirementSpec {
	const fail = (path: string, problem: string): never => {
		throw new SpecError(source, path, problem)
	}

	const object = (value: unknown, path: string): Record<string, unknown> =>
		isObject(value) ? value : fail(path, "must be an object")

	const string: Check = (value, path) => {
		if (typeof value !== "string" || !value.trim()) {
			fail(path, "must be a non-empty string")
		}
	}

	const nullableString: Check = (value, path) => {
		if (value !== null) {
			string(value, path)
		}
	}

	const finite = (value: unknown, path: string, lo: number, hi: number, nullable: boolean) => {
		if (value === null && nullable) return

		if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi) {
			fail(path, `must be ${nullable ? "null or " : ""}a number in [${lo}, ${hi}]`)
		}
	}

	const stringList = (value: unknown, path: string, allowed?: readonly string[]) => {
		if (!Array.isArray(value)) {
			fail(path, "must be an array")
		}

		const list = value as unknown[]

		for (const [i, item] of list.entries()) {
			string(item, `${path}[${i}]`)

			if (allowed && !allowed.includes(item as string)) {
				fail(`${path}[${i}]`, `must be one of ${allowed.join(", ")}`)
			}
		}

		if (new Set(list).size !== list.length) {
			fail(path, "holds a duplicate")
		}
	}

	const selector = (value: unknown, path: string, countries: boolean) => {
		if (value === undefined) return

		const sel = object(value, path)

		for (const key of Object.keys(sel)) {
			if (key !== "kinds" && key !== "sources" && !(countries && key === "countries")) {
				fail(`${path}.${key}`, "is unknown")
			}
		}

		if (sel.kinds !== undefined) {
			stringList(sel.kinds, `${path}.kinds`, ROW_KINDS)
		}

		if (sel.sources !== undefined) {
			stringList(sel.sources, `${path}.sources`)
		}

		if (sel.countries !== undefined) {
			stringList(sel.countries, `${path}.countries`)
		}
	}

	const root = object(input, "$")

	if (root.schemaVersion !== RELEASE_SPEC_SCHEMA_VERSION) {
		fail("$.schemaVersion", `must be ${RELEASE_SPEC_SCHEMA_VERSION}`)
	}

	string(root.specVersion, "$.specVersion")
	string(root.rationale, "$.rationale")

	if (!Array.isArray(root.requirements)) {
		fail("$.requirements", "must be an array")
	}

	const ids = new Set<string>()

	for (const [i, value] of (root.requirements as unknown[]).entries()) {
		const path = `$.requirements[${i}]`
		const req = object(value, path)

		string(req.id, `${path}.id`)

		if (ids.has(req.id as string)) {
			fail(`${path}.id`, "duplicates another requirement")
		}

		ids.add(req.id as string)
		string(req.reason, `${path}.reason`)

		if (!("minimum" in req)) {
			fail(`${path}.minimum`, "must be present (null while unregistered)")
		}

		finite(req.minimum, `${path}.minimum`, 0, 1, true)

		if (req.kind === "country") {
			string(req.country, `${path}.country`)
			selector(req.select, `${path}.select`, false)
		} else if (req.kind === "capability") {
			string(req.task, `${path}.task`)

			if (req.metric !== "exact_parse") {
				fail(`${path}.metric`, "must be exact_parse")
			}

			finite(req.maxLoss ?? null, `${path}.maxLoss`, 0, 1, true)

			if (req.maxLoss != null) {
				string(req.maxLossReason, `${path}.maxLossReason`)
			}

			selector(req.select, `${path}.select`, true)

			if (req.select === undefined) {
				fail(`${path}.select`, "must name the capability's rows")
			}
		} else {
			fail(`${path}.kind`, "must be country or capability")
		}
	}

	const objective = object(root.objective, "$.objective")

	stringList(objective.countries, "$.objective.countries")
	selector(objective.select, "$.objective.select", false)

	if (!("minimumImprovement" in objective)) {
		fail("$.objective.minimumImprovement", "must be present (null while unregistered)")
	}

	finite(objective.minimumImprovement, "$.objective.minimumImprovement", -1, 1, true)

	const identities = object(root.identities, "$.identities")
	const dataset = object(identities.dataset, "$.identities.dataset")

	nullableString(dataset.id, "$.identities.dataset.id")
	nullableString(dataset.sha256, "$.identities.dataset.sha256")

	const scorer = object(identities.scorer, "$.identities.scorer")

	string(scorer.id, "$.identities.scorer.id")
	string(scorer.revision, "$.identities.scorer.revision")

	const inference = object(identities.inference, "$.identities.inference")

	string(inference.description, "$.identities.inference.description")
	object(inference.options, "$.identities.inference.options")

	for (const arm of ["published", "candidate"] as const) {
		const identity = object(identities[arm], `$.identities.${arm}`)

		string(identity.description, `$.identities.${arm}.description`)

		if (identity.sha256 !== null && !(typeof identity.sha256 === "string" && /^[0-9a-f]{64}$/u.test(identity.sha256))) {
			fail(`$.identities.${arm}.sha256`, "must be null or a lowercase sha256 hex digest")
		}
	}

	const statistics = object(root.statistics, "$.statistics")

	if (!("confidenceLevel" in statistics)) {
		fail("$.statistics.confidenceLevel", "must be present")
	}

	if (statistics.confidenceLevel !== null) {
		finite(statistics.confidenceLevel, "$.statistics.confidenceLevel", 0, 1, false)

		if (statistics.confidenceLevel === 0 || statistics.confidenceLevel === 1) {
			fail("$.statistics.confidenceLevel", "must lie strictly between 0 and 1")
		}
	}

	if (!Object.values<unknown>(MultipleComparisonMethod).includes(statistics.multipleComparison)) {
		fail(
			"$.statistics.multipleComparison",
			`names an unknown method ${String(statistics.multipleComparison)}; known: ${Object.values(MultipleComparisonMethod).join(", ")}`
		)
	}

	if (statistics.samplingUnit !== "group") {
		fail("$.statistics.samplingUnit", "must be group")
	}

	string(statistics.groupingAssumption, "$.statistics.groupingAssumption")

	if (!Number.isSafeInteger(statistics.resamples) || (statistics.resamples as number) < 1) {
		fail("$.statistics.resamples", "must be a positive integer")
	}

	if (!Number.isSafeInteger(statistics.seed)) {
		fail("$.statistics.seed", "must be an integer")
	}

	if (!("requiredPrecision" in statistics)) {
		fail("$.statistics.requiredPrecision", "must be present")
	}

	finite(statistics.requiredPrecision, "$.statistics.requiredPrecision", 0, 1, true)

	const provenance = object(root.provenance, "$.provenance")

	stringList(provenance.admitted, "$.provenance.admitted", PROVENANCE_CLASSES)

	const evaluations = object(root.evaluations, "$.evaluations")

	for (const which of ["development", "confirmation"] as const) {
		const evaluation = object(evaluations[which], `$.evaluations.${which}`)

		nullableString(evaluation.id, `$.evaluations.${which}.id`)
		string(evaluation.description, `$.evaluations.${which}.description`)
	}

	return root as unknown as ReleaseRequirementSpec
}

/**
 * Reads and validates a committed specification file.
 */
export async function readReleaseSpec(path: PathBuilderLike): Promise<ReleaseRequirementSpec> {
	return validateReleaseSpec(await readLocalJSONFile<unknown>(path), path.toString())
}
