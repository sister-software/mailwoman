// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The release-requirement specification: the versioned, committed declaration
 *   a release candidate is evaluated against.
 *
 *   It is independent of `scope.config.json`, which describes training coverage.
 *
 *   A numerical threshold is `null` until it is registered.
 *   A `null` threshold never defaults to a value: the evaluator reports the
 *   check it governs as insufficient evidence.
 *
 *   The reader refuses a malformed specification rather than filling a field.
 */

import { COMPONENT_TAGS } from "@mailwoman/codex/component"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import type { HeldoutProvenance, HeldoutRowKind } from "#tools/eval-harness/heldout/per/country"

/**
 * The specification format version this reader accepts.
 *
 * Schema 4 lists each evaluation role's collections, lists the dataset identity's collections,
 * adds the `withoutTags` selector and the `geocode` requirement kind.
 */
export const RELEASE_SPEC_SCHEMA_VERSION = 4

/**
 * The multiple-comparison corrections the evaluator implements for simultaneous bounds.
 */
export const MultipleComparisonMethod = {
	Bonferroni: "bonferroni",
	Sidak: "sidak",
} as const

export type MultipleComparisonMethod = (typeof MultipleComparisonMethod)[keyof typeof MultipleComparisonMethod]

/**
 * Every held-out provenance class, in report order.
 *
 * It lives here rather than beside the type so a spec reader doesn't load the scorer's model runtime.
 */
export const HELDOUT_PROVENANCE_CLASSES = [
	"verified_unseen",
	"unseen_by_candidate",
	"known_overlap",
	"unknown",
] as const satisfies readonly HeldoutProvenance[]

const ROW_KINDS: readonly HeldoutRowKind[] = ["address", "gazetteer"]

/**
 * Which held-out rows a requirement or the objective reads.
 */
export interface RowSelector {
	/**
	 * Row kinds admitted.
	 * An absent list admits every kind.
	 */
	kinds?: HeldoutRowKind[]
	/**
	 * Row sources admitted.
	 * An absent list admits every source.
	 */
	sources?: string[]
	/**
	 * Countries admitted.
	 * An absent list admits every country.
	 */
	countries?: string[]
	/**
	 * Component tags that exclude a row when its expected spans hold any of them.
	 * An absent list admits every row.
	 *
	 * A row whose outcome records no expected tags can't be selected by this field,
	 * and the evaluator refuses it.
	 */
	withoutTags?: string[]
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
	/**
	 * Minimum candidate exact parse rate in `[0, 1]`, or `null` while unregistered.
	 *
	 * Absent registers no minimum, and the registered `maxLoss` is then the capability's only check.
	 */
	minimum?: number | null
	/**
	 * The largest permitted loss, `published - candidate`, in exact parse rate.
	 *
	 * Absent or `null` registers no additional loss limit.
	 * The minimum still applies.
	 */
	maxLoss?: number | null
	maxLossReason?: string
	select: RowSelector
}

/**
 * A required geocode outcome: the loss a change may make in the share of rows whose
 * resolved components and places equal the expected ones (`heldout/per/geocode`).
 *
 * It reads the rows of `countries` that `select` admits, with probe sources left out, and bounds
 * the equal-country mean paired difference, candidate minus published, below by `-maxLoss`.
 * A change that moves only the resolver leaves every exact-parse outcome equal,
 * so this is the check that measures it.
 * It registers no minimum.
 */
export interface GeocodeRequirement {
	id: string
	kind: "geocode"
	task: string
	metric: "geocode_outcome"
	reason: string
	/**
	 * The countries whose rows the check reads, each one stratum of equal weight.
	 */
	countries: string[]
	select?: Omit<RowSelector, "countries">
	/**
	 * The largest permitted loss in equal-country geocode outcome rate, or `null` while unregistered.
	 */
	maxLoss: number | null
	maxLossReason: string
	/**
	 * The provenance classes the check reads when both arms' `model.onnx` sha256 are equal.
	 *
	 * Those arms differ only after the parse, so a row the one model trained on favors neither arm.
	 * Otherwise the check reads `provenance.admitted.comparative`.
	 */
	sameModelAdmitted: HeldoutProvenance[]
}

export type ReleaseRequirement = CountryRequirement | CapabilityRequirement | GeocodeRequirement

/**
 * An identity the evaluation is tied to.
 * `sha256` is `null` while unregistered.
 */
export interface ArtifactIdentity {
	description: string
	sha256: string | null
}

/**
 * A pinned collection of the dataset identity and the rows sha256 its manifest records.
 */
export interface DatasetIdentity {
	id: string
	sha256: string
}

/**
 * The two evaluation roles a specification pins collections for.
 */
export const EVALUATION_ROLES = ["development", "confirmation"] as const

export type EvaluationRole = (typeof EVALUATION_ROLES)[number]

/**
 * One evaluation role: the collections a report for that role scores together.
 */
export interface EvaluationCollections {
	/**
	 * Pinned collection ids, `<datasetID>@<version>`, with distinct dataset ids.
	 */
	ids: string[]
	description: string
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
		 * The fixed objective country set C. Q is the equal-weight mean of per-country exact parse rates.
		 */
		countries: string[]
		select?: Omit<RowSelector, "countries">
		/**
		 * Minimum `Q_candidate - Q_published`, or `null` while unregistered.
		 */
		minimumImprovement: number | null
	}
	identities: {
		/**
		 * The collections the release decision reads, the confirmation role's collections.
		 */
		dataset: DatasetIdentity[]
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
		 * `group`: a row's grouping metadata within its country identifies its independent unit.
		 */
		samplingUnit: "group"
		/**
		 * Whether the rows are declared independent, so that a row without grouping metadata is its own unit.
		 *
		 * `false` makes any check that reads an ungrouped row insufficient evidence.
		 * There's no default: the reader refuses a specification that omits it.
		 */
		rowsIndependent: boolean
		groupingAssumption: string
		/**
		 * Required interval half-width, or `null` while unregistered.
		 * Reported against, never defaulted.
		 */
		requiredPrecision: number | null
	}
	provenance: {
		/**
		 * The provenance classes each kind of check reads.
		 * Every class is reported, and only these decide.
		 *
		 * `minimum`: the classes a minimum check (a candidate rate against its minimum) reads.
		 * A row the candidate never trained on measures the candidate whatever the published model saw.
		 *
		 * `comparative`: the classes the objective and max-loss checks read.
		 * A comparison needs rows neither model trained on, so each listed class
		 * must also be listed under `minimum`.
		 */
		admitted: {
			minimum: HeldoutProvenance[]
			comparative: HeldoutProvenance[]
		}
	}
	evaluations: Record<EvaluationRole, EvaluationCollections>
	/**
	 * A limit on the candidate vocabulary, read from a reachability census
	 * (`heldout/dataset/reachability.run.ts`) of the candidate's `tokenizer.model`.
	 *
	 * `maximumUnreachableEdges` bounds the gold edges at a character-class change that fall inside one piece.
	 * Such an edge is outside every output the model can produce, so the registered
	 * value is zero rather than a fitted one.
	 */
	vocabulary?: { maximumUnreachableEdges: number; reason: string }
}

/**
 * The sources a specification's capability requirements select: the capability probes.
 *
 * A probe's rows measure one address task, such as reading a PO Box, rather than how the model
 * reads its country's ordinary addresses, so a country cell and the objective leave them out.
 */
export function capabilityProbeSources(spec: Pick<ReleaseRequirementSpec, "requirements">): ReadonlySet<string> {
	return new Set(spec.requirements.flatMap((req) => (req.kind === "capability" ? (req.select.sources ?? []) : [])))
}

class SpecError extends Error {
	constructor(source: string, path: string, problem: string) {
		super(`${source}: ${path} ${problem}`)
		this.name = "ReleaseSpecError"
	}
}

/**
 * Splits a pinned collection id, `<datasetID>@<version>`, or returns `null` for any other shape.
 *
 * The version is the 16 hex digits `heldoutDatasetVersion` derives from the collection's rows.
 */
export function parseCollectionID(id: string): { datasetID: string; version: string } | null {
	const match = /^(?<datasetID>[^@\s]+)@(?<version>[0-9a-f]{16})$/u.exec(id)

	return match?.groups ? { datasetID: match.groups.datasetID!, version: match.groups.version! } : null
}

/**
 * The version a specification writes for a collection it names before the
 * collection is frozen, `<datasetID>@pending`.
 *
 * The reader refuses it, so the specification can't be read until the pin is filled.
 */
export const PENDING_COLLECTION_SUFFIX = "@pending"

type Check = (value: unknown, path: string) => void

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value)
}

/**
 * Throws, through `fail`, naming the first malformed collection pin: the dataset
 * identity's list and each evaluation role's `ids`.
 */
function assertCollectionPins(
	dataset: unknown,
	evaluations: Record<string, unknown>,
	fail: (path: string, problem: string) => never
): void {
	const refusePlaceholder = (id: unknown, path: string) => {
		if (typeof id === "string" && id.endsWith(PENDING_COLLECTION_SUFFIX)) {
			fail(
				path,
				`holds the placeholder ${id}: the collection isn't frozen yet; pin <datasetID>@<version> once ` +
					"heldout/dataset/freeze.run.ts writes it"
			)
		}
	}

	const collectionList = (value: unknown, path: string) => {
		if (!Array.isArray(value) || !value.length) {
			fail(path, "must be a non-empty array")
		}

		const datasetIDs = new Set<string>()

		for (const [i, id] of (value as unknown[]).entries()) {
			refusePlaceholder(id, `${path}[${i}]`)

			const parsed = typeof id === "string" ? parseCollectionID(id) : null

			if (!parsed) {
				fail(`${path}[${i}]`, "must be <datasetID>@<16 hex digit version>")
			}

			if (datasetIDs.has(parsed!.datasetID)) {
				fail(`${path}[${i}]`, `pins ${parsed!.datasetID} a second time`)
			}

			datasetIDs.add(parsed!.datasetID)
		}
	}

	if (!Array.isArray(dataset) || !dataset.length) {
		fail("$.identities.dataset", "must be a non-empty array of { id, sha256 } (a single object is schema 3)")
	}

	const entries = dataset as unknown[]

	for (const [i, entry] of entries.entries()) {
		if (!isObject(entry)) {
			fail(`$.identities.dataset[${i}]`, "must be an object")
		}

		refusePlaceholder((entry as Record<string, unknown>).id, `$.identities.dataset[${i}].id`)

		const sha256 = (entry as Record<string, unknown>).sha256

		if (!(typeof sha256 === "string" && /^[0-9a-f]{64}$/u.test(sha256))) {
			fail(`$.identities.dataset[${i}].sha256`, "must be the rows file's lowercase sha256 hex digest")
		}
	}

	collectionList(
		entries.map((entry) => (entry as Record<string, unknown>).id),
		"$.identities.dataset"
	)

	for (const which of EVALUATION_ROLES) {
		const evaluation = evaluations[which]

		if (!isObject(evaluation)) {
			fail(`$.evaluations.${which}`, "must be an object")
		}

		const role = evaluation as Record<string, unknown>

		if ("id" in role) {
			fail(`$.evaluations.${which}.id`, "is schema 3's single pin; schema 4 lists the role's collections under ids")
		}

		collectionList(role.ids, `$.evaluations.${which}.ids`)

		if (typeof role.description !== "string" || !role.description.trim()) {
			fail(`$.evaluations.${which}.description`, "must be a non-empty string")
		}
	}
}

/**
 * Throws, through `fail`, unless a requirement that omits its minimum is a
 * capability with a registered `maxLoss`.
 *
 * The loss bound is then that capability's only check.
 */
function assertLossOnly(
	req: Record<string, unknown>,
	path: string,
	fail: (path: string, problem: string) => never
): void {
	if (req.kind !== "capability") {
		fail(path, "must be present (null while unregistered)")
	}

	if (typeof req.maxLoss !== "number") {
		fail(path, "may be omitted only beside a registered maxLoss, which then judges the capability")
	}
}

/**
 * Validates a parsed specification and returns it typed, or throws naming the first malformed field.
 */
export function validateReleaseSpec(input: unknown, source = "release spec"): ReleaseRequirementSpec {
	assertReleaseSpec(input, source)

	return input
}

/**
 * Throws naming the first malformed field of a parsed specification.
 */
function assertReleaseSpec(input: unknown, source: string): asserts input is ReleaseRequirementSpec {
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
			if (key !== "kinds" && key !== "sources" && key !== "withoutTags" && !(countries && key === "countries")) {
				fail(`${path}.${key}`, "is unknown")
			}
		}

		if (sel.withoutTags !== undefined) {
			stringList(sel.withoutTags, `${path}.withoutTags`, COMPONENT_TAGS)
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

		if (req.kind === "geocode") {
			if ("minimum" in req) {
				fail(`${path}.minimum`, "is not a geocode check's: it bounds a loss and registers no minimum")
			}

			string(req.task, `${path}.task`)

			if (req.metric !== "geocode_outcome") {
				fail(`${path}.metric`, "must be geocode_outcome")
			}

			stringList(req.countries, `${path}.countries`)

			if (!(req.countries as unknown[]).length) {
				fail(`${path}.countries`, "must name at least one country")
			}

			selector(req.select, `${path}.select`, false)

			if (!("maxLoss" in req)) {
				fail(`${path}.maxLoss`, "must be present (null while unregistered)")
			}

			finite(req.maxLoss, `${path}.maxLoss`, 0, 1, true)
			string(req.maxLossReason, `${path}.maxLossReason`)
			stringList(req.sameModelAdmitted, `${path}.sameModelAdmitted`, HELDOUT_PROVENANCE_CLASSES)

			if ((req.sameModelAdmitted as string[]).includes("unknown")) {
				fail(`${path}.sameModelAdmitted`, "admits unknown, whose rows carry no recorded history")
			}

			continue
		}

		if ("minimum" in req) {
			finite(req.minimum, `${path}.minimum`, 0, 1, true)
		} else {
			assertLossOnly(req, `${path}.minimum`, fail)
		}

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
			fail(`${path}.kind`, "must be country, capability or geocode")
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

	assertCollectionPins(identities.dataset, object(root.evaluations, "$.evaluations"), fail)

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

	if (typeof statistics.rowsIndependent !== "boolean") {
		fail("$.statistics.rowsIndependent", "must be present as true or false; it has no default")
	}

	string(statistics.groupingAssumption, "$.statistics.groupingAssumption")

	for (const retired of ["resamples", "seed"]) {
		if (retired in statistics) {
			fail(`$.statistics.${retired}`, "is retired in schema 2: bounds are analytic and draw no resamples")
		}
	}

	if (!("requiredPrecision" in statistics)) {
		fail("$.statistics.requiredPrecision", "must be present")
	}

	finite(statistics.requiredPrecision, "$.statistics.requiredPrecision", 0, 1, true)

	const provenance = object(root.provenance, "$.provenance")

	if (Array.isArray(provenance.admitted)) {
		fail(
			"$.provenance.admitted",
			"is a single list, retired in schema 3: name { minimum: [...], comparative: [...] } so each check kind reads its own classes"
		)
	}

	const admitted = object(provenance.admitted, "$.provenance.admitted")

	for (const key of Object.keys(admitted)) {
		if (key !== "minimum" && key !== "comparative") {
			fail(`$.provenance.admitted.${key}`, "is unknown")
		}
	}

	stringList(admitted.minimum, "$.provenance.admitted.minimum", HELDOUT_PROVENANCE_CLASSES)
	stringList(admitted.comparative, "$.provenance.admitted.comparative", HELDOUT_PROVENANCE_CLASSES)

	for (const [i, cls] of (admitted.comparative as string[]).entries()) {
		if (cls === "unseen_by_candidate" || cls === "known_overlap" || cls === "unknown") {
			fail(
				`$.provenance.admitted.comparative[${i}]`,
				`admits ${cls}, whose rows are not established unseen by the published model`
			)
		}

		if (!(admitted.minimum as string[]).includes(cls)) {
			fail(`$.provenance.admitted.comparative[${i}]`, `admits ${cls}, which minimum checks do not admit`)
		}
	}

	if (root.vocabulary !== undefined) {
		const vocabulary = object(root.vocabulary, "$.vocabulary")
		const maximum = vocabulary.maximumUnreachableEdges

		if (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 0) {
			fail("$.vocabulary.maximumUnreachableEdges", "must be a non-negative integer")
		}

		string(vocabulary.reason, "$.vocabulary.reason")
	}
}

/**
 * Reads and validates a committed specification file.
 */
export async function readReleaseSpec(path: PathBuilderLike): Promise<ReleaseRequirementSpec> {
	return validateReleaseSpec(await readLocalJSONFile<unknown>(path), path.toString())
}
