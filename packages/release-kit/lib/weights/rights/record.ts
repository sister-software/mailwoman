/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the artifacts, license and source attribution of each weights package from its manifest and model card.
 *
 *   A license obligation comes from the package's own SPDX expression. A provenance obligation comes from an
 *   artifact's sources and survives redistribution under either license branch. The record keeps the two apart.
 *
 *   The record reports a gap as a gap. A card without attribution entries yields an empty list, a missing digest
 *   reads `unrecorded`, and an overlay's inherited attribution stays labeled as the base's. The cross-package pass
 *   also finds artifacts whose attribution sits in another package's card.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { literalFilesEntries } from "#pack/verify-tarball"

/**
 * The meaning of the `version` field in a package's `model-card.json`.
 *
 * A graph package's card version identifies the trained model, and
 * `mwops release verify-metadata` keys its checks on it.
 * An overlay's card version identifies the overlay's own artifacts.
 * Neither is the npm version, which every workspace shares.
 */
export const VersionSeries = {
	Model: "model",
	Overlay: "overlay",
} as const

/**
 * One value of {@link VersionSeries}.
 */
export type VersionSeries = (typeof VersionSeries)[keyof typeof VersionSeries]

/**
 * The kind of an artifact, which determines which sources it derives from.
 *
 * The files in one package have unrelated provenance.
 * `model.onnx` derives from the training corpus, `tokenizer.model` from the tokenizer text,
 * and a pair index or postcode binary from one named register.
 *
 * {@link roleForArtifact} derives the role from the file name.
 * An unrecognized name maps to `other`.
 */
export const ArtifactRole = {
	ModelGraph: "model-graph",
	Tokenizer: "tokenizer",
	CharacterVocabulary: "character-vocabulary",
	Lexicon: "lexicon",
	PlacetypePairIndex: "placetype-pair-index",
	PostcodeBinary: "postcode-binary",
	Gazetteer: "gazetteer-fst",
	Calibration: "calibration",
	Other: "other",
} as const

/**
 * One value of {@link ArtifactRole}.
 */
export type ArtifactRole = (typeof ArtifactRole)[keyof typeof ArtifactRole]

/**
 * Returns the role of a declared file name.
 */
export function roleForArtifact(path: string): ArtifactRole {
	const exact: Readonly<Record<string, ArtifactRole>> = {
		"model.onnx": ArtifactRole.ModelGraph,
		"tokenizer.model": ArtifactRole.Tokenizer,
		"char-vocab.json": ArtifactRole.CharacterVocabulary,
	}

	const byPrefix: ReadonlyArray<readonly [string, ArtifactRole]> = [
		["pair-index-", ArtifactRole.PlacetypePairIndex],
		["postcode-", ArtifactRole.PostcodeBinary],
		["fst-", ArtifactRole.Gazetteer],
		["calibration", ArtifactRole.Calibration],
	]

	const named = exact[path]

	if (named) return named

	for (const [prefix, role] of byPrefix) {
		if (path.startsWith(prefix)) return role
	}

	return path.includes("-lexicon-v") ? ArtifactRole.Lexicon : ArtifactRole.Other
}

/**
 * One declared artifact with its role and the digest that the card records for it.
 */
export interface ArtifactRecord {
	path: string
	role: ArtifactRole
	md5: string | null
	/**
	 * `recorded` when the card's `files_md5` lists this artifact, and `unrecorded` otherwise.
	 */
	digest: "recorded" | "unrecorded"
}

/**
 * The ways a source contributed, as its attribution entry states them.
 *
 * Some entries describe evaluation sets or tokenizer text instead of training rows.
 * One entry may state several uses.
 */
export const SourceUse = {
	Training: "training",
	Tokenizer: "tokenizer",
	Evaluation: "evaluation",
	/**
	 * The entry does not say how the source was used.
	 */
	Unstated: "unstated",
} as const

/**
 * One value of {@link SourceUse}.
 */
export type SourceUse = (typeof SourceUse)[keyof typeof SourceUse]

/**
 * Returns the uses that one attribution entry states in its prose.
 *
 * It returns `unstated` when no pattern matches.
 * It never defaults to `training`, because that default would claim the model
 * learned from every unrecognized source.
 */
export function usesStatedIn(entry: string): SourceUse[] {
	const uses: SourceUse[] = []
	const text = entry.toLowerCase()

	if (/tokenizer[- ](?:splice|training)/u.test(text)) {
		uses.push(SourceUse.Tokenizer)
	}

	if (/\beval\b|\beval set|evaluation|validation\b/u.test(text)) {
		uses.push(SourceUse.Evaluation)
	}

	if (/training extract|training rows|\btrained on\b|training corpus/u.test(text)) {
		uses.push(SourceUse.Training)
	}

	return uses.length ? uses : [SourceUse.Unstated]
}

/**
 * One attribution entry from a card, with the license and uses it states.
 */
export interface AttributionRecord {
	/**
	 * The verbatim entry.
	 *
	 * The record keeps the exact wording because a paraphrased rights statement is a different statement.
	 */
	text: string
	/**
	 * The license that the entry states in a parenthetical.
	 * It is `null` when the reader finds none.
	 */
	licenseNamed: string | null
	/**
	 * The uses that the entry states.
	 * It is `["unstated"]` when the entry states none.
	 */
	uses: SourceUse[]
}

/**
 * The attribution that an overlay inherits from the package that owns its model graph.
 *
 * The record repeats the base's attribution so a consumer of the overlay alone can read it.
 * The record labels it as the base's because the overlay's own artifacts did not contribute to that model.
 */
export interface InheritedLineage {
	package: string
	packageVersion: string
	modelCardVersion: string | null
	attribution: AttributionRecord[]
	/**
	 * The package names from this package to the graph package, in walk order.
	 */
	chain: string[]
	/**
	 * The reason the walk stopped early, such as a cycle or a base outside the set.
	 * It is `null` when the walk reached a graph package.
	 */
	unresolved: string | null
}

/**
 * An artifact that this package ships whose attribution appears in another package's card.
 */
export interface ForeignAttribution {
	artifact: string
	recordedIn: string
	text: string
}

/**
 * The rights record of one weights package.
 */
export interface WeightsRightsRecord {
	workspace: string
	packageName: string
	packageVersion: string
	/**
	 * The SPDX expression that the manifest declares.
	 *
	 * The `package-license` repository check keeps it equal to the root's.
	 */
	license: string
	/**
	 * The card's own version, or `null` when the package ships no card.
	 */
	modelCardVersion: string | null
	versionSeries: VersionSeries
	/**
	 * The package that owns the model graph this package uses, or `null` for a graph package.
	 */
	baseWeights: string | null
	artifacts: ArtifactRecord[]
	/**
	 * The card's attribution entries under either field spelling.
	 * It is empty when the card records none.
	 */
	attribution: AttributionRecord[]
	foreignAttribution: ForeignAttribution[]
	/**
	 * The lineage inherited from the base package's model graph, or `null` for a graph package.
	 */
	inherited: InheritedLineage | null
	/**
	 * The corpus version that the card states.
	 *
	 * It does not prove which records reached the model, because no frozen per-release corpus manifest exists.
	 */
	corpusVersion: string | null
	tokenizerVersion: string | null
}

interface ModelCard {
	version?: unknown
	files_md5?: unknown
	/**
	 * The attribution field spelling that the `cjk` card uses.
	 */
	attribution?: unknown
	training?: {
		/**
		 * The attribution field spelling that the `en-us` card uses.
		 */
		data_attribution?: unknown
		corpus_version?: unknown
		tokenizer_version?: unknown
	}
}

/**
 * Returns a card's attribution entries from `training.data_attribution` or a top-level `attribution`.
 *
 * Published cards use both spellings, and published cards cannot change, so the reader accepts both.
 */
function attributionEntries(card: ModelCard | null): string[] {
	const candidates = [card?.training?.data_attribution, card?.attribution]

	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue

		const entries = candidate.filter((entry): entry is string => typeof entry === "string")

		if (entries.length) return entries
	}

	return []
}

/**
 * Returns the license that an attribution entry states in a parenthetical.
 *
 * For example, `LINZ-derived OpenAddresses NZ (CC-BY 4.0): …` yields `CC-BY 4.0`.
 *
 * It returns `null` when no parenthetical holds a license.
 * Some entries state their terms outside a parenthetical, so `null` describes what this reader found.
 * The verbatim entry text stays beside it.
 */
export function licenseNamedIn(entry: string): string | null {
	// An entry often opens with a parenthetical in the dataset's own name,
	// so the reader checks every parenthetical.
	for (const match of entry.matchAll(/\(([^()]{1,120})\)/gu)) {
		const inner = match[1]!.trim()

		// A parenthetical holds a license when it contains a version number,
		// a known license family, or a spelling of the word "license".
		const namesLicense =
			/\d/u.test(inner) ||
			/\b(?:CC0|CC-BY|CC|ODbL|PDDL|OGL|OGDL|KOGL|CDLA|Etalab|MIT|Apache|Licence|License|Lizenz)\b/iu.test(inner)

		if (namesLicense) return inner
	}

	return null
}

/**
 * The documentation files that a weights package declares.
 *
 * The record excludes them from the artifact list because they carry no data with provenance.
 */
const DOCUMENTATION_FILES: ReadonlySet<string> = new Set([
	"README.md",
	"LICENSE.md",
	"LICENSE",
	"PROVENANCE.json",
	"model-card.json",
])

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length ? value : null
}

/**
 * Reads the rights record of one weights workspace.
 *
 * @throws When the manifest is unreadable or lacks `name`, `version` or `license`.
 * An empty record would wrongly report that the package ships no weights.
 */
export async function readWeightsRightsRecord(
	repoRoot: PathBuilderLike,
	workspace: string
): Promise<WeightsRightsRecord> {
	const manifest = await readPackageJSON(resolvePath(repoRoot, workspace, "package.json"))
	const cardPath = resolvePath(repoRoot, workspace, "model-card.json")
	const card = (await pathExists(cardPath)) ? await readLocalJSONFile<ModelCard>(cardPath) : null

	const packageName = stringOrNull(manifest.name)
	const packageVersion = stringOrNull(manifest.version)
	const license = stringOrNull(manifest.license)

	if (!packageName || !packageVersion || !license) {
		throw new Error(`${workspace}/package.json is missing one of "name", "version" or "license"`)
	}

	const baseWeights = stringOrNull(manifest.mailwoman?.baseWeights)
	const digests = (card?.files_md5 ?? {}) as Record<string, unknown>

	const artifacts: ArtifactRecord[] = literalFilesEntries(manifest.files)
		.filter((path) => !DOCUMENTATION_FILES.has(path))
		.map((path) => {
			const md5 = stringOrNull(digests[path])

			return { path, role: roleForArtifact(path), md5, digest: md5 ? "recorded" : "unrecorded" }
		})

	const attribution = attributionEntries(card)

	return {
		workspace,
		packageName,
		packageVersion,
		license,
		modelCardVersion: stringOrNull(card?.version),
		versionSeries: baseWeights ? VersionSeries.Overlay : VersionSeries.Model,
		baseWeights,
		artifacts,
		attribution: attribution.map((text) => ({
			text,
			licenseNamed: licenseNamedIn(text),
			uses: usesStatedIn(text),
		})),
		foreignAttribution: [],
		// `readWeightsRightsRecords` fills `foreignAttribution` and `inherited` because both depend on the whole set.
		inherited: null,
		corpusVersion: stringOrNull(card?.training?.corpus_version),
		tokenizerVersion: stringOrNull(card?.training?.tokenizer_version),
	}
}

/**
 * Reads the rights record of every listed weights workspace, then fills each record's
 * {@link WeightsRightsRecord.foreignAttribution} and {@link WeightsRightsRecord.inherited}.
 *
 * An artifact's attribution is foreign when its file name appears in another package's attribution entry.
 */
export async function readWeightsRightsRecords(
	repoRoot: PathBuilderLike,
	workspaces: readonly string[]
): Promise<WeightsRightsRecord[]> {
	const records: WeightsRightsRecord[] = []

	for (const workspace of workspaces) {
		records.push(await readWeightsRightsRecord(repoRoot, workspace))
	}

	for (const record of records) {
		for (const artifact of record.artifacts) {
			for (const other of records) {
				if (other.workspace === record.workspace) continue

				for (const entry of other.attribution) {
					if (!entry.text.includes(artifact.path)) continue

					record.foreignAttribution.push({
						artifact: artifact.path,
						recordedIn: other.packageName,
						text: entry.text,
					})
				}
			}
		}
	}

	const byName = new Map(records.map((record) => [record.packageName, record]))

	for (const record of records) {
		record.inherited = resolveInherited(record, byName)
	}

	return records
}

/**
 * Follows `mailwoman.baseWeights` from an overlay to the package that owns the
 * model graph and returns that package's attribution.
 *
 * The walk follows every hop because a base may declare its own base.
 * A cycle or a base outside the set stops the walk and sets `unresolved`,
 * which keeps an unresolved lineage distinct from an empty one.
 */
function resolveInherited(
	record: WeightsRightsRecord,
	byName: ReadonlyMap<string, WeightsRightsRecord>
): InheritedLineage | null {
	if (!record.baseWeights) return null

	const chain: string[] = [record.packageName]
	const seen = new Set<string>([record.packageName])
	let current = record.baseWeights

	for (;;) {
		if (seen.has(current)) {
			return {
				package: current,
				packageVersion: "",
				modelCardVersion: null,
				attribution: [],
				chain: [...chain, current],
				unresolved: `the base chain returns to ${current}, so no package in it owns a model graph`,
			}
		}

		const base = byName.get(current)

		if (!base) {
			return {
				package: current,
				packageVersion: "",
				modelCardVersion: null,
				attribution: [],
				chain: [...chain, current],
				unresolved: `${current} is not among the packages read, so its lineage could not be resolved here`,
			}
		}

		seen.add(current)
		chain.push(current)

		if (!base.baseWeights) {
			return {
				package: base.packageName,
				packageVersion: base.packageVersion,
				modelCardVersion: base.modelCardVersion,
				attribution: base.attribution,
				chain,
				unresolved: null,
			}
		}

		current = base.baseWeights
	}
}
