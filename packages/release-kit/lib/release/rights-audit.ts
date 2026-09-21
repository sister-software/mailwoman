/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One deterministic pass over everything the repository records about where its published artifacts came from, and
 *   what it does not record.
 *
 *   Seven repository checks already hold individual invariants: the notices agree, the rights documents name a
 *   licensor, the generated files equal their writer's output, the register's digest matches its contents. Each
 *   answers its own question and none of them answers the question a release asks, which is whether the chain from a
 *   source's terms to a published tarball closes.
 *
 *   It does not close today, and the value of this pass is saying exactly where. The register holds 389 candidate
 *   sources and admits none of them. No corpus build has written a frozen `TRAINING_SOURCES.json`, so which records
 *   trained a published model is unrecorded rather than recorded-and-unreviewed. Both are reported as what they are.
 *
 *   Nothing here asserts clearance, and a clean report is not one. A section that establishes nothing says so, and the
 *   report separates what it observed from what it could not read. Reading this as permission is the misreading the
 *   whole rights record was built to refuse.
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
import { resolvePath } from "path-ts"

import { LICENSE_FILE, PROVENANCE_FILE } from "#weights/rights/files"
import { SourceUse, type WeightsRightsRecord } from "#weights/rights/record"
import { weightsRightsRecords } from "#weights/rights/write"

/**
 * What the register admits, and what refuses the rest.
 */
export interface SourceRegisterAudit {
	sources: number
	/**
	 * Sources with no eligibility problem. Zero is the reading today and is a measurement
	 * rather than a placeholder.
	 */
	eligible: number
	/**
	 * Each distinct refusal, with how many sources it refuses.
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
	 * Artifacts whose digest the card records. The remainder read `unrecorded`,
	 * which is a different answer from verified.
	 */
	digestsRecorded: number
	attributionEntries: number
	/**
	 * Entries whose text names no license this reader could find.
	 * The entry may still state terms outside a parenthetical, which is why this
	 * counts entries rather than declaring them unlicensed.
	 */
	entriesNamingNoLicense: number
	/**
	 * Entries stating a use that is evaluation or tokenizer text rather than training rows.
	 * These attribute data the model did not learn from.
	 */
	entriesNotTraining: number
	/**
	 * Entries stating no use at all. Whether the source trained the model is unrecorded,
	 * which is a different answer from recorded as not having trained it —
	 * counting the two together would report an absence as a measurement.
	 */
	entriesStatingNoUse: number
	/**
	 * Artifacts shipping here whose attribution sits in another package's card.
	 */
	foreignAttribution: number
	/**
	 * The chain to the package owning the model graph, for a data-only overlay.
	 * Empty for a graph package.
	 */
	lineage: string[]
	/**
	 * Why the lineage could not be resolved, when it could not.
	 */
	lineageUnresolved: string | null
	/**
	 * Whether the manifest's `files` array carries both generated rights filenames.
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
	 * The corpus the card names as prose, or `null`. It is not an identifier
	 * and cannot be joined to a manifest.
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

export interface RightsAudit {
	register: SourceRegisterAudit
	packages: PackageRightsAudit[]
	training: TrainingRecordAudit[]
	/**
	 * What the pass established, as sentences naming the measurement.
	 */
	established: string[]
	/**
	 * What it could not, each with why. A release decision reads this list rather than the absence of errors.
	 */
	unresolved: string[]
}

/**
 * Where a frozen training manifest would be read from, relative to the repository root.
 *
 * A corpus build writes it beside the corpus it produced, under the data root, which no
 * release path reads. The repository copy is the one a release can check, and none exists yet.
 */
const FROZEN_MANIFESTS_DIRECTORY = "packages/corpus/data/training-manifests"

/**
 * The register's admissions and refusals.
 *
 * `readAddressSourceRegister` resolves the committed path itself and throws
 * when the register's digest or its own audit fails, so reaching the loop below
 * means the counts describe a register that was regenerated rather than hand-edited.
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
async function shipsRightsFiles(repoRoot: string, workspace: string): Promise<boolean> {
	const manifest = await readPackageJSON(String(resolvePath(repoRoot, workspace, "package.json")))
	const files = Array.isArray(manifest.files) ? manifest.files : []

	return [LICENSE_FILE, PROVENANCE_FILE].every((name) => files.includes(name))
}

/**
 * One package's row.
 */
async function auditPackage(repoRoot: string, record: WeightsRightsRecord): Promise<PackageRightsAudit> {
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
 * It never reports zero sources, which would read as a corpus built from nothing.
 */
async function readFrozenManifest(repoRoot: string, corpusVersion: string): Promise<TrainingManifest | null> {
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
	repoRoot: string,
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
 * The whole pass. Reads the checkout and changes nothing.
 */
export async function auditRights(repoRoot: string): Promise<RightsAudit> {
	const records = await weightsRightsRecords(repoRoot)
	const register = await auditRegister()
	const packages: PackageRightsAudit[] = []

	for (const record of records) {
		packages.push(await auditPackage(repoRoot, record))
	}

	const training = await auditTraining(repoRoot, records)
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

	return { register, packages, training, established, unresolved }
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
