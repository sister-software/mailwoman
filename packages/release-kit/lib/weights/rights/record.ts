/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What one weights package ships, which rights govern it, and which of those questions the repository cannot answer
 *   — read from the package manifest and the model card, with every gap recorded as a gap.
 *
 *   The record separates two things that a single `data_attribution` list runs together. A license obligation follows
 *   from the terms a distributor grants: this package is `AGPL-3.0-only OR LicenseRef-Commercial`, and that expression
 *   states what a consumer may do with the artifacts. A provenance obligation follows from where an artifact's inputs
 *   came from: attribution and share-alike conditions attach to the source and survive redistribution, whichever branch
 *   of our own license a consumer takes. The two are rendered into separate files for that reason.
 *
 *   Three readings here would each be wrong in the same direction, so none of them is made. A package whose card
 *   records no training attribution is recorded as recording none, never as having none. A declared artifact with no
 *   digest is recorded `unrecorded`, never as verified. And an overlay does not inherit its base's attribution list as
 *   though it were its own: the base's record is named, and the overlay's own artifacts keep whatever attribution the
 *   repository actually holds for them.
 *
 *   The last part is what a per-package record adds over one list in one card. `pair-index-gb.bin` ships in
 *   `@mailwoman/neural-weights-en-gb`, and the entry attributing it to HM Land Registry Price Paid Data under OGL v3.0
 *   sits in `@mailwoman/neural-weights-en-us`'s card. A consumer who installs the overlay receives the artifact and no
 *   attribution. {@link readWeightsRightsRecords} finds that class by looking for each package's artifact filenames in
 *   every other package's attribution text.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolvePath } from "path-ts"

import { literalFilesEntries } from "#pack/verify-tarball"

/**
 * What a package's `version` field in `model-card.json` denotes.
 *
 * A graph package's card version names the trained model: `en-us` at 9.1.0 is the suffix-boundary model, and `mwops
 * release verify-metadata` keys the ledger and documentation checks off it rather than off the npm version. An
 * overlay's card version names that overlay's own artifacts, and the graph its rows decode through is whatever
 * `mailwoman.baseWeights` resolves to.
 *
 * Neither number is the npm version, which moves in lockstep across every workspace on every release. The two series
 * are described in `docs/records/site-2026-08/releases.mdx`.
 */
export const VersionSeries = {
	Model: "model",
	Overlay: "overlay",
} as const

export type VersionSeries = (typeof VersionSeries)[keyof typeof VersionSeries]

/**
 * A digest the card records for an artifact, or the reason there is none.
 */
export interface ArtifactRecord {
	path: string
	md5: string | null
	/**
	 * `recorded` when the card's `files_md5` names this artifact. `unrecorded` when it does not. An unrecorded digest is
	 * not a verified one, and a reader that treated `md5: null` as "nothing to check" would read the second as the
	 * first.
	 */
	digest: "recorded" | "unrecorded"
}

/**
 * One attribution entry as the card states it, plus whether it names a license.
 */
export interface AttributionRecord {
	/**
	 * The entry verbatim. Reproduced rather than summarized: the entry is the statement the repository has made, and a
	 * paraphrase of a rights statement is a different statement.
	 */
	text: string
	/**
	 * The license the entry names, when the entry names one in the parenthetical the cards use. `null` when it names
	 * none, which is a gap rather than a permissive reading.
	 */
	licenseNamed: string | null
}

/**
 * An artifact this package ships whose attribution another package's card carries.
 */
export interface ForeignAttribution {
	artifact: string
	recordedIn: string
	text: string
}

export interface WeightsRightsRecord {
	workspace: string
	packageName: string
	packageVersion: string
	/**
	 * The SPDX expression the manifest declares. The `package-license` repository check holds it equal to the root's.
	 */
	license: string
	/**
	 * The card's own version, or `null` when the package ships no card. `base-latn` is the one such package.
	 */
	modelCardVersion: string | null
	versionSeries: VersionSeries
	/**
	 * The package whose model graph this one decodes through, or `null` for a graph package.
	 */
	baseWeights: string | null
	artifacts: ArtifactRecord[]
	/**
	 * The card's `training.data_attribution` entries. An empty array means the card records none.
	 */
	attribution: AttributionRecord[]
	foreignAttribution: ForeignAttribution[]
	/**
	 * The corpus the card names, when it names one. Not evidence of which records reached the model: the corpus on the
	 * training volume moves, and no frozen per-release manifest exists to compare it against.
	 */
	corpusVersion: string | null
	tokenizerVersion: string | null
}

interface ModelCard {
	version?: unknown
	files_md5?: unknown
	training?: {
		data_attribution?: unknown
		corpus_version?: unknown
		tokenizer_version?: unknown
	}
}

/**
 * The license a card's attribution entry names, from the parenthetical the entries use — `LINZ-derived OpenAddresses NZ
 * (CC-BY 4.0): …` names `CC-BY 4.0`. `null` when the entry has no such parenthetical, which includes the OA PL entry
 * whose parenthetical reads `public, BDOT-derived` and names no license at all.
 */
export function licenseNamedIn(entry: string): string | null {
	const parenthetical = /\(([^()]{1,120})\)/u.exec(entry)

	if (!parenthetical) return null

	const inner = parenthetical[1]!.trim()

	// A license identifier carries a version, a `CC`/`OGL`/`CC0` family name, or the word `license`. `public,
	// BDOT-derived` carries none of the three and is a description of access rather than a grant.
	const namesLicense = /\d/u.test(inner) || /\b(?:CC0|CC-BY|CC|ODbL|OGL|MIT|Apache|Licence|License)\b/iu.test(inner)

	return namesLicense ? inner : null
}

/**
 * Files a weights package declares that document it rather than carry data.
 *
 * The same distinction `data-provenance` draws over a `data/` directory, for the same reason: a digest over a README
 * states nothing about an input's provenance, and listing one as an artifact with no digest reports a gap that is not
 * one. `model-card.json` joins them because it is the record the rest of this document is read from.
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
 * Read one weights workspace's record. Throws when the manifest is unreadable rather than returning an empty record: a
 * rights record nobody can read must not resolve to a package that ships nothing and owes nothing.
 */
export async function readWeightsRightsRecord(repoRoot: string, workspace: string): Promise<WeightsRightsRecord> {
	const manifest = await readPackageJSON(String(resolvePath(repoRoot, workspace, "package.json")))
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

			return { path, md5, digest: md5 ? "recorded" : "unrecorded" }
		})

	const attributionEntries = Array.isArray(card?.training?.data_attribution)
		? card.training.data_attribution.filter((entry): entry is string => typeof entry === "string")
		: []

	return {
		workspace,
		packageName,
		packageVersion,
		license,
		modelCardVersion: stringOrNull(card?.version),
		versionSeries: baseWeights ? VersionSeries.Overlay : VersionSeries.Model,
		baseWeights,
		artifacts,
		attribution: attributionEntries.map((text) => ({ text, licenseNamed: licenseNamedIn(text) })),
		foreignAttribution: [],
		corpusVersion: stringOrNull(card?.training?.corpus_version),
		tokenizerVersion: stringOrNull(card?.training?.tokenizer_version),
	}
}

/**
 * Every weights workspace's record, with {@link WeightsRightsRecord.foreignAttribution} filled in.
 *
 * The cross-package pass runs here rather than in the single-workspace reader because it is a question about the set:
 * an artifact's attribution is foreign only relative to the other packages that could have carried it, and reading one
 * package cannot establish that.
 */
export async function readWeightsRightsRecords(
	repoRoot: string,
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

	return records
}
