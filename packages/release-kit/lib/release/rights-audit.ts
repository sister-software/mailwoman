/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * One deterministic pass over everything the repository records about where its published artifacts came from, and
 * what it does not record.
 *
 * Seven repository checks already hold individual invariants: the notices agree, the rights documents name a
 * licensor, the generated files equal their writer's output, the register's digest matches its contents. None of
 * them answers the question a release asks, which is whether the chain from a source's terms to a published
 * tarball closes, and this pass says exactly where it does not.
 *
 * No part of this report asserts clearance, and a clean report is not one. A section that establishes no fact says
 * so, and the report separates what it observed from what it could not read. Reading this as permission is the
 * misreading the whole rights record was built to refuse.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import {
	auditTrainingManifest,
	ingestEligibilityProblems,
	readAddressSourceRegister,
	type TrainingManifest,
} from "@mailwoman/corpus/source-register"
import { dataBOMPath, LicenseBasis, type DataBOM } from "mailwoman/data/bom"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { LICENSE_FILE, PROVENANCE_FILE } from "#weights/rights/files"
import { SourceUse, type WeightsRightsRecord } from "#weights/rights/record"
import { weightsRightsRecords } from "#weights/rights/write"

/**
 * What the register admits, and what refuses the rest.
 */
export interface SourceRegisterAudit {
	sources: number
	/**
	 * Sources with no eligibility problem.
	 * Zero is a measurement rather than a placeholder.
	 */
	eligible: number
	/**
	 * Each distinct refusal, with how many sources it refuses.
	 *
	 * A source refused several ways counts under each.
	 */
	refusals: Array<{ because: string; sources: number }>
}

/**
 * A refusal message with each quoted identifier replaced, so refusals that differ only by
 * which license or source they name group together.
 *
 * Without this the license refusal never appears: every one of the 389 sources points
 * at its own license id, so the message is 389 distinct strings of one source each
 * and a report showing the largest refusals omits the blocker that covers every row.
 * `example` carries one message unaltered, so a reader still sees the real wording.
 */
function refusalShape(message: string): string {
	return message.replaceAll(/"[^"]*"/gu, "<id>")
}

/**
 * One published weights package's state, as the release path needs it.
 */
export interface PackageRightsAudit {
	package: string
	version: string
	versionSeries: string
	modelCardVersion: string | null
	artifacts: number
	/**
	 * Artifacts whose digest the card records.
	 *
	 * The remainder read `unrecorded`, which is a different answer from verified.
	 */
	digestsRecorded: number
	attributionEntries: number
	/**
	 * Entries whose text names no license this reader could find.
	 *
	 * The entry may still state terms outside a parenthetical, which is why this
	 * counts entries rather than declaring them unlicensed.
	 */
	entriesNamingNoLicense: number
	/**
	 * Entries stating a use that is evaluation or tokenizer text rather than training rows.
	 *
	 * These attribute data the model did not learn from.
	 */
	entriesNotTraining: number
	/**
	 * Entries stating no use at all.
	 *
	 * Whether the source trained the model is unrecorded, which is a different answer from recorded as
	 * not having trained it — counting the two together would report an absence as a measurement.
	 */
	entriesStatingNoUse: number
	/**
	 * Artifacts shipping here whose attribution sits in another package's card.
	 */
	foreignAttribution: number
	/**
	 * The chain to the package owning the model graph, for a data-only overlay.
	 *
	 * Empty for a graph package.
	 */
	lineage: string[]
	/**
	 * Why the lineage could not be resolved, when it could not.
	 */
	lineageUnresolved: string | null
	/**
	 * Whether the manifest's `files` array carries both generated rights filenames.
	 *
	 * A file committed and not listed never reaches a consumer.
	 */
	shipsRightsFiles: boolean
	openQuestions: number
}

/**
 * Which records trained a published model, per package.
 */
export interface TrainingRecordAudit {
	package: string
	/**
	 * The corpus the card names as prose, or `null`.
	 *
	 * It is not an identifier and cannot be joined to a manifest.
	 */
	corpusNamed: string | null
	/**
	 * The frozen manifest for that corpus, when the repository holds one.
	 */
	manifest: {
		corpusVersion: string
		profile: string
		sources: number
		totalRows: number
		problems: string[]
	} | null
	/**
	 * What stops this package's training inputs from being established.
	 */
	unresolved: string | null
}

/**
 * What the committed data bill of materials states about the artifacts a release can deliver.
 *
 * The register covers source terms, the weights records cover what a model shipped,
 * and the frozen manifests cover what trained it.
 * None of the three reaches a runtime database, so a release could publish a
 * bundle whose terms no audited record named.
 * This is that fourth input.
 */
export interface DataBOMAudit {
	/**
	 * Repository-relative path of the document this audit read, or `null`
	 * when none exists for the `mailwoman` version being released.
	 */
	path: string | null

	/**
	 * The `mailwoman` version the document is keyed by.
	 */
	version: string

	components: number

	/**
	 * Components whose expression came from the artifact's own `layer_manifest`.
	 */
	fromArtifactManifest: number

	/**
	 * Components whose expression is this repository's reading of the publishers' stated terms.
	 *
	 * The artifact's own `layer_manifest` could not be read for these, so the expression is
	 * this repository's assertion rather than a reading of the bytes a consumer downloads.
	 */
	fromBundleRegistry: number

	/**
	 * Components carrying `NOASSERTION`, which records a `layer_manifest` row holding no expression.
	 */
	withoutExpression: number

	/**
	 * Every distinct expression the document carries, with the component count under each.
	 */
	expressions: Array<{ expression: string; components: number }>
}

export interface RightsAudit {
	register: SourceRegisterAudit
	packages: PackageRightsAudit[]
	training: TrainingRecordAudit[]
	data: DataBOMAudit
	/**
	 * What the pass established, as sentences naming the measurement.
	 */
	established: string[]
	/**
	 * What it could not, each with why.
	 *
	 * A release decision reads this list rather than the absence of errors.
	 */
	unresolved: string[]
}

/**
 * Where a frozen training manifest would be read from, relative to the repository root.
 *
 * A corpus build writes it beside the corpus it produced, under the data root, which no release path reads.
 * The repository copy is the one a release can check, and none exists yet.
 */
const FROZEN_MANIFESTS_DIRECTORY = "packages/corpus/data/training-manifests"

/**
 * How many of the data document's license expressions the terminal report prints.
 *
 * The count under each is what a reader compares, and the tail is a long list of one-component expressions.
 * The full set is in the document the line above names.
 */
const EXPRESSIONS_SHOWN = 8

/**
 * The register's admissions and refusals.
 *
 * `readAddressSourceRegister` resolves the committed path itself and throws
 * when the register's digest or its own audit fails, so reaching the loop below means
 * the counts describe a register that was regenerated rather than hand-edited.
 * There is no field for that here because a failure never returns.
 */
async function auditRegister(): Promise<SourceRegisterAudit> {
	const register = await readAddressSourceRegister()
	const refusals = new Map<string, { example: string; sources: number }>()
	let eligible = 0

	for (const source of register.sources) {
		const problems = ingestEligibilityProblems(source, register)

		if (!problems.length) {
			eligible += 1

			continue
		}

		for (const problem of problems) {
			const shape = refusalShape(problem)
			const seen = refusals.get(shape)

			refusals.set(shape, { example: seen?.example ?? problem, sources: (seen?.sources ?? 0) + 1 })
		}
	}

	return {
		sources: register.sources.length,
		eligible,
		refusals: [...refusals.values()]
			.map(({ example, sources }) => ({ because: example, sources }))
			.toSorted((left, right) => right.sources - left.sources || left.because.localeCompare(right.because)),
	}
}

/**
 * Whether a workspace's `files` array lists both generated rights filenames.
 */
async function shipsRightsFiles(repoRoot: PathBuilderLike, workspace: string): Promise<boolean> {
	const manifest = await readPackageJSON(resolvePath(repoRoot, workspace, "package.json"))
	const files = Array.isArray(manifest.files) ? manifest.files : []

	return [LICENSE_FILE, PROVENANCE_FILE].every((name) => files.includes(name))
}

/**
 * One package's row.
 */
async function auditPackage(repoRoot: PathBuilderLike, record: WeightsRightsRecord): Promise<PackageRightsAudit> {
	const provenance = await readLocalJSONFile<{ unresolved?: unknown }>(
		resolvePath(repoRoot, record.workspace, PROVENANCE_FILE)
	)

	return {
		package: record.packageName,
		version: record.packageVersion,
		versionSeries: record.versionSeries,
		modelCardVersion: record.modelCardVersion,
		artifacts: record.artifacts.length,
		digestsRecorded: record.artifacts.filter((artifact) => artifact.digest !== "unrecorded").length,
		attributionEntries: record.attribution.length,
		entriesNamingNoLicense: record.attribution.filter((entry) => !entry.licenseNamed).length,
		entriesNotTraining: record.attribution.filter(
			(entry) => !entry.uses.includes(SourceUse.Training) && !entry.uses.includes(SourceUse.Unstated)
		).length,
		entriesStatingNoUse: record.attribution.filter((entry) => entry.uses.includes(SourceUse.Unstated)).length,
		foreignAttribution: record.foreignAttribution.length,
		lineage: record.inherited?.chain ?? [],
		lineageUnresolved: record.inherited?.unresolved ?? null,
		shipsRightsFiles: await shipsRightsFiles(repoRoot, record.workspace),
		openQuestions: Array.isArray(provenance.unresolved) ? provenance.unresolved.length : 0,
	}
}

/**
 * The frozen manifest for a corpus, or `null` when the repository holds none.
 *
 * A read that fails for any reason returns `null` and the caller records the corpus as unestablished.
 * It never reports zero sources, which would read as a corpus built from no source.
 */
async function readFrozenManifest(repoRoot: PathBuilderLike, corpusVersion: string): Promise<TrainingManifest | null> {
	try {
		return await readLocalJSONFile<TrainingManifest>(
			resolvePath(repoRoot, FROZEN_MANIFESTS_DIRECTORY, `${corpusVersion}.json`)
		)
	} catch {
		return null
	}
}

/**
 * What each package records about the records that trained it.
 */
async function auditTraining(
	repoRoot: PathBuilderLike,
	records: readonly WeightsRightsRecord[]
): Promise<TrainingRecordAudit[]> {
	const rows: TrainingRecordAudit[] = []

	for (const record of records) {
		const corpusNamed = record.corpusVersion

		if (!corpusNamed) {
			rows.push({
				package: record.packageName,
				corpusNamed: null,
				manifest: null,
				unresolved: record.inherited
					? `ships no model graph and its card names no corpus; what trained ${record.inherited.package}'s graph is that package's row`
					: "its model card names no corpus, so there is nothing to look a manifest up by",
			})

			continue
		}

		const manifest = await readFrozenManifest(repoRoot, corpusNamed)

		if (!manifest) {
			rows.push({
				package: record.packageName,
				corpusNamed,
				manifest: null,
				unresolved: `the card names corpus ${stringifyJSON(corpusNamed)} and no frozen manifest for it exists under ${FROZEN_MANIFESTS_DIRECTORY}, so which records reached this model is unrecorded`,
			})

			continue
		}

		const problems = auditTrainingManifest(manifest)

		rows.push({
			package: record.packageName,
			corpusNamed,
			manifest: {
				corpusVersion: manifest.corpusVersion,
				profile: manifest.profile,
				sources: manifest.sources.length,
				totalRows: manifest.totalRows,
				problems,
			},
			unresolved: problems.length ? `its frozen manifest fails its own audit: ${problems.join("; ")}` : null,
		})
	}

	return rows
}

/**
 * The whole pass.
 *
 * Reads the checkout and makes no change.
 */
export async function auditRights(repoRoot: PathBuilderLike): Promise<RightsAudit> {
	const records = await weightsRightsRecords(repoRoot)
	const register = await auditRegister()
	const packages: PackageRightsAudit[] = []

	for (const record of records) {
		packages.push(await auditPackage(repoRoot, record))
	}

	const training = await auditTraining(repoRoot, records)
	const data = await auditDataBOM(repoRoot)
	const established: string[] = []
	const unresolved: string[] = []

	established.push(
		`${packages.length} published weights packages carry a generated ${LICENSE_FILE} and ${PROVENANCE_FILE}, and ${packages.filter((entry) => entry.shipsRightsFiles).length} of them list both in the manifest files array that decides what npm ships.`
	)

	const artifacts = packages.reduce((total, entry) => total + entry.artifacts, 0)
	const digests = packages.reduce((total, entry) => total + entry.digestsRecorded, 0)

	established.push(
		`Those packages declare ${artifacts} data artifacts between them and record a digest for ${digests}, which is ${((digests / artifacts) * 100).toFixed(1)}%.`
	)

	established.push(
		`The source register parsed, its committed digest matched its contents, and it passed its own audit over ${register.sources} sources. The reader refuses it otherwise, so this pass would not have reached here.`
	)

	if (!register.eligible) {
		unresolved.push(
			`No source in the register is eligible for ingest. The largest refusal covers ${register.refusals[0]?.sources ?? 0} sources: ${register.refusals[0]?.because ?? "none recorded"}.`
		)
	}

	const withoutManifest = training.filter((row) => !row.manifest)

	if (withoutManifest.length) {
		unresolved.push(
			`${withoutManifest.length} of ${training.length} packages have no frozen training manifest, so which records trained the model each one ships or inherits is unrecorded.`
		)
	}

	const unlicensed = packages.reduce((total, entry) => total + entry.entriesNamingNoLicense, 0)

	if (unlicensed) {
		unresolved.push(
			`${unlicensed} attribution entries name no license this reader could find. An entry may state its terms outside a parenthetical, so each one needs reading rather than counting.`
		)
	}

	const unstated = packages.reduce((total, entry) => total + entry.entriesStatingNoUse, 0)

	if (unstated) {
		unresolved.push(
			`${unstated} attribution entries state no use, so whether the source trained the model that attributes it is unrecorded. Reading them as training overstates what a model saw and dropping them loses an attribution the source may require.`
		)
	}

	const foreign = packages.reduce((total, entry) => total + entry.foreignAttribution, 0)

	if (foreign) {
		unresolved.push(
			`${foreign} artifacts ship in one package with their attribution recorded in another's card. A consumer installing the shipping package alone receives the artifact without the attribution.`
		)
	}

	const brokenLineage = packages.filter((entry) => entry.lineageUnresolved)

	if (brokenLineage.length) {
		unresolved.push(
			`${brokenLineage.length} packages declare a base whose lineage could not be resolved: ${brokenLineage.map((entry) => `${entry.package} (${entry.lineageUnresolved})`).join("; ")}.`
		)
	}

	const unshipped = packages.filter((entry) => !entry.shipsRightsFiles)

	if (unshipped.length) {
		unresolved.push(
			`${unshipped.length} packages commit a rights file their manifest does not list, so it never reaches a consumer: ${unshipped.map((entry) => entry.package).join(", ")}.`
		)
	}

	if (!data.path) {
		unresolved.push(
			`No data bill of materials exists for mailwoman ${data.version}, so what governs the databases a release ` +
				`delivers is recorded only as bundle prose. Run \`mailwoman data bom\` to write ${dataBOMPath(data.version)}.`
		)
	} else {
		established.push(
			`${data.path} describes ${data.components} data artifacts. ${data.fromArtifactManifest} carry the ` +
				`expression their own layer_manifest records and ${data.fromBundleRegistry} carry the expression this ` +
				`repository assigns from the publishers' stated terms.`
		)

		if (data.fromBundleRegistry) {
			unresolved.push(
				`${data.fromBundleRegistry} of ${data.components} data artifacts state no expression of their own, so ` +
					`the document reports this repository's reading of their publishers' terms. A consumer downloading ` +
					`those files receives bytes that name no license.`
			)
		}

		if (data.withoutExpression) {
			unresolved.push(
				`${data.withoutExpression} data artifacts carry a layer_manifest row holding no expression, recorded as ` +
					`NOASSERTION. Their obligations are unrecorded rather than empty.`
			)
		}
	}

	return { register, packages, training, data, established, unresolved }
}

/**
 * Read the committed data bill of materials for the version being released.
 *
 * The document is generated rather than hand-written, so this audit reports
 * what it says instead of re-deriving it.
 * An absent document goes into `unresolved` as a missing record, which is
 * where a release decision reads it.
 */
async function auditDataBOM(repoRoot: PathBuilderLike): Promise<DataBOMAudit> {
	const manifest = await readPackageJSON(resolvePath(repoRoot, "packages", "mailwoman", "package.json"))

	if (!manifest.version) {
		throw new Error(`packages/mailwoman/package.json declares no version, so no data document can be named.`)
	}

	const version = manifest.version

	const path = dataBOMPath(version)

	const empty: DataBOMAudit = {
		path: null,
		version,
		components: 0,
		fromArtifactManifest: 0,
		fromBundleRegistry: 0,
		withoutExpression: 0,
		expressions: [],
	}

	let document: DataBOM

	try {
		document = await readLocalJSONFile<DataBOM>(resolvePath(repoRoot, path))
	} catch {
		return empty
	}

	const byExpression = new Map<string, number>()
	let fromArtifactManifest = 0
	let fromBundleRegistry = 0
	let withoutExpression = 0

	for (const component of document.components) {
		const expression = component.licenses?.[0]?.expression ?? "NOASSERTION"
		const basis = component.properties.find((property) => property.name === "mailwoman:licenseBasis")?.value

		byExpression.set(expression, (byExpression.get(expression) ?? 0) + 1)

		if (expression === "NOASSERTION") {
			withoutExpression++
		}

		if (basis === LicenseBasis.ArtifactManifest) {
			fromArtifactManifest++
		} else if (basis === LicenseBasis.BundleRegistry) {
			fromBundleRegistry++
		}
	}

	return {
		path,
		version,
		components: document.components.length,
		fromArtifactManifest,
		fromBundleRegistry,
		withoutExpression,
		expressions: [...byExpression.entries()]
			.map(([expression, components]) => ({ expression, components }))
			.toSorted((a, b) => b.components - a.components),
	}
}

/**
 * The audit as lines for a terminal.
 *
 * The unresolved section prints last and is never omitted.
 * A report ending on what it established would read as a verdict, and this pass reaches none.
 */
export function renderRightsAudit(audit: RightsAudit): string[] {
	const lines: string[] = [
		"Rights audit — what the repository records, and what it does not.",
		"",
		`Source register: ${audit.register.sources} sources, ${audit.register.eligible} eligible for ingest.`,
		...audit.register.refusals
			.slice(0, 5)
			.map((refusal) => `  ${String(refusal.sources).padStart(4)} refused because ${refusal.because}`),
		"",
		"Published weights packages:",
	]

	for (const entry of audit.packages) {
		lines.push(
			`  ${entry.package} ${entry.version} (${entry.versionSeries}, card ${entry.modelCardVersion ?? "none"})`,
			`    ${entry.digestsRecorded} of ${entry.artifacts} artifact digests recorded; ${entry.attributionEntries} attribution entries, ${entry.entriesNotTraining} describing data the model did not learn from and ${entry.entriesStatingNoUse} stating no use; ${entry.openQuestions} open questions`
		)

		// The chain starts with the package itself, so a reader following it sees where it began.
		// This line is about the base, and printing the package's own name twice on one line reads as a cycle.
		if (entry.lineage.length > 1) {
			lines.push(`    decodes through ${entry.lineage.slice(1).join(" → ")}`)
		}
	}

	lines.push("", "Training records:")

	for (const row of audit.training) {
		lines.push(
			row.manifest
				? `  ${row.package}: ${row.manifest.sources} sources, ${row.manifest.totalRows} rows, profile ${row.manifest.profile}`
				: `  ${row.package}: ${row.unresolved}`
		)
	}

	lines.push("", `Data artifacts (mailwoman ${audit.data.version}):`)

	if (audit.data.path) {
		lines.push(
			`  ${audit.data.path}: ${audit.data.components} components, ` +
				`${audit.data.fromArtifactManifest} from the artifact's own layer_manifest, ` +
				`${audit.data.fromBundleRegistry} from the bundle registry`
		)

		for (const row of audit.data.expressions.slice(0, EXPRESSIONS_SHOWN)) {
			lines.push(`    ${String(row.components).padStart(4)}  ${row.expression}`)
		}

		if (audit.data.expressions.length > EXPRESSIONS_SHOWN) {
			lines.push(`    … ${audit.data.expressions.length - EXPRESSIONS_SHOWN} further expressions`)
		}
	} else {
		lines.push(`  ${dataBOMPath(audit.data.version)} does not exist. Run \`mailwoman data bom\`.`)
	}

	lines.push("", "Established:")

	for (const line of audit.established) {
		lines.push(`  - ${line}`)
	}

	lines.push("", "Unresolved:")

	if (!audit.unresolved.length) {
		lines.push("  - Nothing in the sections above is unresolved. That is not a clearance finding.")
	}

	for (const line of audit.unresolved) {
		lines.push(`  - ${line}`)
	}

	return lines
}
