/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath, weightsOverlayPath } from "@mailwoman/core/data-root"
import {
	pathExists,
	readLocalJSONFile,
	readLocalTextFile,
	statPath,
	readLocalBuffer,
	statLink,
} from "@mailwoman/core/fs/readers"
import {
	createSymbolicLink,
	makeDirectories,
	movePath,
	removePath,
	writeLocalTextFile,
} from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { parseJSONStrict } from "@mailwoman/core/json"
import { repoRootPath, repoRootPathBuilder, workspacePathBuilder } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { readReleaseConfig, repoCommittedSoftFeedSources } from "@mailwoman/core/release-config"
import type { PathBuilder, PathBuilderLike } from "path-ts"

import { $public } from "#env"
import { fstFreshnessWarning } from "#fst/freshness"
import { wofDatabasePath } from "#paths"

/**
 * Replaces `dest` with a symlink to `src` by renaming a temporary link over it.
 *
 * The rename is atomic, so concurrent test workers never see `dest` missing.
 */
export async function linkForce(src: PathBuilderLike, dest: PathBuilderLike): Promise<void> {
	const tmp = `${dest.toString()}.tmp-link`

	if (await pathExists(tmp)) {
		await removePath(tmp)
	}

	await createSymbolicLink(src, tmp)
	await movePath(tmp, dest)
}

/**
 * Removes a file or symlink at `dest` so that the runtime falls back to the base en-us weights.
 */
export async function removeIfPresent(dest: PathBuilder): Promise<void> {
	try {
		await statLink(dest)
	} catch {
		return
	}

	await removePath(dest)

	console.log(`removed stale local ${dest} (base fallback to en-us engages)`)
}

/**
 * Symlinks one optional soft-feed artifact into an overlay and returns whether the source existed.
 *
 * A missing source prints `consequenceIfMissing` and does not throw, because the
 * runtime has a fallback for every soft-feed artifact.
 */
export async function linkSoftFeedSibling(
	source: PathBuilderLike,
	destination: PathBuilder,
	consequenceIfMissing: string
): Promise<boolean> {
	if (!(await pathExists(source))) {
		console.error(`WARNING: missing ${source} — ${consequenceIfMissing}`)

		return false
	}

	await linkForce(source, destination)

	console.log(`linked ${destination} \u2190 ${source}`)

	return true
}

/**
 * The pair-index emission bias (δ) used by every shipped pair-index artifact.
 */
export const PAIR_INDEX_DELTA = 10

/**
 * The decoder transition-entry bonus (β).
 * Only locales that were calibrated with it pass it.
 */
export const PAIR_INDEX_TRANSITION_BETA = 5

/**
 * The whole-edge parent-bias magnitude.
 * Only locales that were calibrated with it pass it.
 *
 * Other locales omit the flag and do not inherit this value.
 */
export const PAIR_INDEX_PARENT_DELTA = 5

/**
 * Describes one locale's pair-index build.
 *
 * When `sources`, `inputs` and `extraArgs` are omitted, the build reads the shared WOF admin database.
 */
export interface PairIndexOverlay {
	/**
	 * The weights workspace directory name, such as `neural-weights-de-de`.
	 * The overlay locale is derived from it.
	 */
	packageDir: string

	/**
	 * The ISO country code passed to `--country` and used in `pair-index-<country>.bin`.
	 *
	 * It can differ from the locale tag.
	 * For example, `en-in` builds `pair-index-in.bin`.
	 */
	country: string

	/**
	 * The child bias magnitude.
	 *
	 * The build writes `delta`, `transitionBeta` and `parentDelta` into the PIX1 header,
	 * and the freshness check compares them.
	 * An absent `transitionBeta` or `parentDelta` leaves its key out of the header,
	 * and the freshness check treats an absent key as distinct from zero.
	 */
	delta: number
	transitionBeta?: number
	parentDelta?: number

	/**
	 * The source files whose MD5s the build records, in the order that `gazetteer pair-index` records them.
	 * The default is the WOF admin database.
	 *
	 * The freshness check compares each MD5 with the header.
	 * An empty list makes the check compare the magnitudes only.
	 */
	sources?: PathBuilder[]

	/**
	 * Files that must exist before a build runs.
	 *
	 * The default is `sources`.
	 * A missing file prints a warning and skips the build.
	 */
	inputs?: PathBuilder[]

	/**
	 * Extra CLI arguments that pass the build's sources.
	 * The default is `--borough-db <admin db>`.
	 */
	extraArgs?: PathBuilderLike[]

	/**
	 * The byte size below which an existing artifact is rebuilt.
	 *
	 * A build from the wrong source can have matching header magnitudes but a smaller size.
	 */
	minimumPlausibleBytes?: number
}

/**
 * The pair-index header fields that the dev-weights freshness check reads.
 */
export interface PairIndexHeaderFields {
	delta: number
	transitionBeta: number | undefined
	parentDelta: number | undefined
	schemaVersion: number

	/**
	 * One MD5 per source the build read, in recorded order.
	 * The list is empty when the header has none.
	 */
	sourceMD5s: string[]
}

/**
 * Reads the calibration fields from a PIX1 pair-index header without depending on `@mailwoman/neural`.
 *
 * The parse must match the reader in `neural/lib/pair/index/resolver.ts`.
 */
export async function peekPairIndexHeaderFields(path: PathBuilderLike): Promise<PairIndexHeaderFields> {
	const bytes = await readLocalBuffer(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	const MAGIC = 0x31_58_49_50

	if (view.getUint32(0, true) !== MAGIC) {
		throw new Error(`pair index: bad magic reading ${path}`)
	}

	const headerLen = view.getUint32(4, true)

	const header = parseJSONStrict<{
		delta: number
		transitionBeta?: number
		parentDelta?: number
		schemaVersion: number
		sourceMD5s?: string[]
	}>(Buffer.from(bytes.subarray(8, 8 + headerLen)).toString("utf8"))

	return {
		delta: header.delta,
		transitionBeta: header.transitionBeta,
		parentDelta: header.parentDelta,
		schemaVersion: header.schemaVersion,
		sourceMD5s: header.sourceMD5s ?? [],
	}
}

const MD5_HEX_LENGTH = 32

// repo-health-ignore export-name-affix -- This variant caches the hash in a sidecar, and `md5File` hashes every time.
/**
 * Returns the MD5 of `path`, cached in a `<path>.md5` sidecar in `md5sum` format.
 *
 * The sidecar is used only when it is at least as new as the source.
 */
export async function md5FileWithSidecar(path: PathBuilderLike): Promise<string> {
	const sidecarPath = `${path.toString()}.md5`
	const sourceStats = await statPath(path)

	if (await pathExists(sidecarPath)) {
		try {
			if ((await statPath(sidecarPath)).mtime >= sourceStats.mtime) {
				const [hash] = (await readLocalTextFile(sidecarPath)).trim().split(/\s+/)

				if (hash && hash.length === MD5_HEX_LENGTH) return hash
			}
		} catch {}
	}

	const hash = await md5File(path)
	const filename = path.split(/[/\\]/).pop() || path

	await writeLocalTextFile(`${hash}  ${filename}\n`, sidecarPath)

	return hash
}

/**
 * The calibrated magnitudes that a linker writes into its pair-index artifact.
 *
 * An `undefined` magnitude means the header has no such key.
 * It is distinct from zero.
 */
export interface PairIndexCalibration {
	delta: number
	transitionBeta?: number
	parentDelta?: number
}

/**
 * Returns why a pair-index header's schema or magnitudes differ from `expected`,
 * or `undefined` when they match.
 *
 * The caller checks the source MD5s because only the caller knows its sources.
 */
export function pairIndexStaleReason(
	header: PairIndexHeaderFields,
	expected: PairIndexCalibration
): string | undefined {
	if (header.schemaVersion !== REQUIRED_PAIR_INDEX_SCHEMA) {
		return `schemaVersion ${header.schemaVersion} → ${REQUIRED_PAIR_INDEX_SCHEMA}`
	}

	if (header.delta !== expected.delta) return `delta ${header.delta} → ${expected.delta}`

	if (header.transitionBeta !== expected.transitionBeta) {
		return `transitionBeta ${header.transitionBeta ?? "(absent)"} → ${expected.transitionBeta ?? "(absent)"}`
	}

	if (header.parentDelta !== expected.parentDelta) {
		return `parentDelta ${header.parentDelta ?? "(absent)"} → ${expected.parentDelta ?? "(absent)"}`
	}

	return undefined
}

/**
 * The PIX1 schema version the pair-index reader requires.
 *
 * It must equal `KNOWN_SCHEMA_VERSION` in `neural/lib/pair/index/resolver.ts`.
 * A mismatch makes dev checkouts rebuild on every run or link an artifact that the runtime refuses.
 */
export const REQUIRED_PAIR_INDEX_SCHEMA = 3

/**
 * Warns when a linked per-locale FST was built from a different admin database than the one on disk.
 *
 * It does not rebuild, because an FST rebuild writes to a staging directory
 * and an operator swaps it in after evaluation.
 */
export async function warnIfFSTStale(fstPath: PathBuilder, locale: string): Promise<void> {
	const warning = await fstFreshnessWarning({
		fstPath,
		sourceDBPath: wofDatabasePath("admin-global-priority.db"),
		rebuildCommand: `node packages/mailwoman/out/cli/index.js gazetteer build fst --locales ${locale}  (writes to a staging dir; swap is operator-conditional)`,
	})

	if (warning) {
		console.error(warning)
	}
}

/**
 * Symlinks the per-locale FST gazetteer `fst-<locale>.bin` into an overlay
 * and checks it with {@link warnIfFSTStale}.
 */
export async function linkLocaleFST(destDir: PathBuilder, locale: string): Promise<void> {
	const source = wofDatabasePath("fst-per-locale", `fst-${locale}.bin`)

	const linked = await linkSoftFeedSibling(
		source,
		destDir(`fst-${locale}.bin`),
		"the FST gazetteer default will resolve OFF for this locale."
	)

	if (linked) {
		await warnIfFSTStale(source, locale)
	}
}

/**
 * Symlinks the prebuilt street-morphology FST into an overlay so that the
 * street-context check does not rebuild it from dictionaries.
 */
export async function linkStreetMorphologyFST(destDir: PathBuilder): Promise<void> {
	await linkSoftFeedSibling(
		wofDatabasePath("fst-street-morphology.bin"),
		destDir("fst-street-morphology.bin"),
		"the street-context check falls back to the per-process dictionary build."
	)
}

async function pairIndexIsFresh(
	dest: PathBuilder,
	artifact: string,
	expected: PairIndexCalibration,
	sources: PathBuilder[],
	minimumPlausibleBytes: number | undefined
): Promise<boolean> {
	try {
		const header = await peekPairIndexHeaderFields(dest)
		const staleReason = pairIndexStaleReason(header, expected)

		if (staleReason) {
			console.log(`rebuilding ${artifact} — ${staleReason}`)

			return false
		}

		if (minimumPlausibleBytes !== undefined && (await statPath(dest)).size < minimumPlausibleBytes) {
			console.log(
				`rebuilding ${artifact} — ${(await statPath(dest)).size.toLocaleString()} bytes is implausibly small ` +
					`for this recipe (wrong-source clobber)`
			)

			return false
		}

		if (!sources.length) {
			console.log(`skipped ${artifact} build — ${dest} is current (magnitudes match; no file-hashable source)`)

			return true
		}

		for (const source of sources) {
			if (!(await pathExists(source))) {
				console.log(
					`skipped ${artifact} build — ${dest} has matching header magnitudes (${source} absent, md5 freshness unverifiable)`
				)

				return true
			}
		}

		if (header.sourceMD5s.length !== sources.length) {
			console.log(
				`rebuilding ${artifact} — header records ${header.sourceMD5s.length} source md5s ` +
					`[${header.sourceMD5s.join(", ") || "(none recorded)"}], but this build reads ${sources.length}`
			)

			return false
		}

		const currentMD5s: string[] = []

		for (const source of sources) {
			currentMD5s.push(await md5FileWithSidecar(source))
		}

		if (currentMD5s.every((md5, i) => md5 === header.sourceMD5s[i])) {
			console.log(
				`skipped ${artifact} build — ${dest} is current (magnitudes + all ${sources.length} source md5s match)`
			)

			return true
		}

		console.log(
			`rebuilding ${artifact} — header source md5s [${header.sourceMD5s.join(", ")}] != current [${currentMD5s.join(", ")}]`
		)

		return false
	} catch (error) {
		console.log(`rebuilding ${artifact} — freshness unverifiable (${(error as Error).message})`)

		return false
	}
}

/**
 * Builds `pair-index-<country>.bin` into the overlay unless the existing artifact
 * already matches these magnitudes and sources.
 *
 * A failed build exits the process.
 * A missing CLI or input only prints a warning, because a fresh clone has neither.
 */
export async function buildPairIndexOverlay(overlay: PairIndexOverlay): Promise<void> {
	const { packageDir, country, delta, transitionBeta, parentDelta } = overlay
	const CLI = workspacePathBuilder("mailwoman", "out", "cli", "index.js")
	const ARTIFACT = `pair-index-${country}.bin`

	const PKG_DIR = weightsOverlayPath(packageDir.replace(/^neural-weights-/, ""))
	const DEST = PKG_DIR(ARTIFACT)

	await makeDirectories(PKG_DIR)

	const WOF_ADMIN_DB = wofDatabasePath("admin-global-priority.db")
	const sources = overlay.sources ?? [WOF_ADMIN_DB]
	const inputs = overlay.inputs ?? sources
	const extraArgs = overlay.extraArgs ?? ["--borough-db", WOF_ADMIN_DB]

	if (!(await pathExists(CLI))) {
		console.error(`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run for ${ARTIFACT}.`)

		return
	}

	if (
		(await pathExists(DEST)) &&
		(await pairIndexIsFresh(
			DEST,
			ARTIFACT,
			{ delta, transitionBeta, parentDelta },
			sources,
			overlay.minimumPlausibleBytes
		))
	) {
		return
	}

	for (const input of inputs) {
		if (await pathExists(input)) continue

		console.error(
			`WARNING: missing ${input} — ${ARTIFACT} not built; the placetype-pair prior stays inert for ${country.toUpperCase()}.`
		)

		return
	}

	const result = spawnProcessSync(
		process.execPath,
		[
			CLI,
			"gazetteer",
			"pair-index",
			"--out",
			PKG_DIR,
			"--country",
			country,
			"--delta",
			String(delta),
			...(transitionBeta === undefined ? [] : ["--transition-beta", String(transitionBeta)]),
			...(parentDelta === undefined ? [] : ["--parent-delta", String(parentDelta)]),
			...extraArgs,
		],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !(await pathExists(DEST))) {
		console.error(`FAILED: gazetteer pair-index --country ${country} (exit ${result.status})`)

		process.exit(1)
	}

	console.log(`built ${ARTIFACT}`)
}

/**
 * A soft-feed artifact that an overlay links, with the warning to print when its source is missing.
 */
export interface SoftFeedLink {
	source: string
	name: string
	consequenceIfMissing: string
}

/**
 * Returns the committed soft-feed lexicons as links.
 *
 * The filenames come from `release.config.json` so that dev links match the release.
 */
export async function committedSoftFeedLinks(): Promise<{
	anchor: SoftFeedLink
	country: SoftFeedLink
	streetType?: SoftFeedLink
}> {
	const config = await readReleaseConfig()
	const sources = repoCommittedSoftFeedSources(repoRootPath(), config.softFeed ?? {})

	const link = (name: string, consequenceIfMissing: string): SoftFeedLink | undefined => {
		const source = sources.get(name)

		return source ? { source, name, consequenceIfMissing } : undefined
	}

	const anchor = link("anchor-lexicon-v1.json", "gazetteer channel will resolve OFF in this worktree.")
	const country = link("country-surface-lexicon-v1.json", "country channel will resolve OFF in this worktree.")

	if (!anchor || !country) {
		throw new Error(
			"release.config.json names no softFeed.gazetteerLexicon / softFeed.countryLexicon — the overlays cannot link them."
		)
	}

	const streetType = link("street-type-lexicon-v3.json", "the street_type channel will resolve OFF in this worktree.")

	return { anchor, country, ...(streetType ? { streetType } : {}) }
}

/**
 * The fields of a weights package's `model-card.json` that dev materialization reads.
 */
export interface WeightsCard {
	files_md5?: Record<string, string>
	requires?: Record<string, { lexicon?: string; span_mode?: string } | undefined>
}

/**
 * Declares what one locale's dev overlay contains. {@link materializeDevOverlay}
 * runs the steps in the order the fields are listed.
 */
export interface DevOverlayManifest {
	/**
	 * The overlay's lowercase locale tag.
	 * The workspace is `neural-weights-<locale>`.
	 *
	 * Artifacts go to the data root's `weights/<locale>/` overlay because the binaries are kept out of git.
	 */
	locale: string

	/**
	 * How the overlay gets its model files.
	 *
	 * When it is omitted, `link-weights-overlay.ts` in release-kit handles them.
	 *
	 * The `link` kind symlinks `model.onnx` and `tokenizer.model` from the
	 * `release.config.json` weights paths under the data root.
	 * The `$MAILWOMAN_DEV_MODEL` and `$MAILWOMAN_DEV_TOKENIZER` variables override those paths.
	 *
	 * With `digestCard`, the linked default files must match the `files_md5` of that workspace's card.
	 * An override skips this check.
	 *
	 * The `inherit` kind removes any local pair, because the package declares
	 * `mailwoman.baseWeights` and a local file would shadow the base.
	 *
	 * The `char` kind links the `charWeights.<family>` model, character vocabulary
	 * and model card, and removes any tokenizer.
	 */
	model?: { kind: "link"; digestCard?: string } | { kind: "inherit" } | { kind: "char"; family: string }

	/**
	 * Soft-feed siblings to link in order.
	 * A missing source prints a warning and the step continues.
	 */
	softFeed?: ReadonlyArray<SoftFeedLink>

	/**
	 * Whether to link the evidence lexicons listed under `requires.<channel>.lexicon`
	 * in the overlay's model card.
	 * A card update then changes the linked file too.
	 *
	 * The street-type lexicon comes from the repo's `data/gazetteer/`.
	 * The locality-surface lexicon comes from the data root.
	 */
	evidenceLexiconsFromCard?: boolean

	/**
	 * Builds `postcode-<country>.bin` from a WOF postcode extract with the compiled CLI.
	 * The step is skipped when the file already exists.
	 */
	postcodeBinary?: { country: string; database: PathBuilder }

	/**
	 * The placetype-pair index build.
	 * Its `packageDir` is derived from `locale`.
	 */
	pairIndex?: Omit<PairIndexOverlay, "packageDir">

	/**
	 * Whether to link `fst-<locale>.bin` and warn when it is stale.
	 */
	localeFST?: boolean

	/**
	 * Whether to link the shared street-morphology FST.
	 */
	streetMorphologyFST?: boolean
}

/**
 * The overlay directory, CLI path and model card that {@link materializeDevOverlay} returns.
 *
 * Callers use them for locale-specific steps that a manifest cannot express.
 */
export interface DevOverlay {
	destDir: PathBuilder
	cli: PathBuilder
	card: WeightsCard | undefined
}

const EVIDENCE_LEXICON_SOURCES: ReadonlyArray<{
	channel: "street_type" | "locality_surface"
	source: (name: string) => PathBuilder
}> = [
	{ channel: "street_type", source: (name) => repoRootPathBuilder("data", "gazetteer", name) },
	{ channel: "locality_surface", source: (name) => dataRootPath("gazetteer", name) },
]

async function readWeightsCard(workspace: string): Promise<WeightsCard | undefined> {
	const path = workspacePathBuilder(workspace, "model-card.json")

	if (!(await pathExists(path))) return undefined

	return readLocalJSONFile<WeightsCard>(path)
}

async function linkCharModel(destDir: PathBuilder, family: string): Promise<void> {
	const recipe = (await readReleaseConfig()).charWeights?.[family]

	if (!recipe) {
		throw new Error(`release.config.json declares no charWeights.${family} — nothing to link for the ${family} base`)
	}

	const dataRoot = dataRootPath()

	for (const [name, relative] of [
		["model.onnx", recipe.model],
		["char-vocab.json", recipe.charVocab],
	] as const) {
		const source = dataRoot(relative)

		if (!(await pathExists(source))) {
			throw new Error(`missing char-path source ${name} for ${family}: ${source}`)
		}

		await linkForce(source, destDir(name))

		console.log(`linked ${destDir(name)} ← ${source}`)
	}

	const card = workspacePathBuilder(`neural-weights-${family}`, "model-card.json")

	await linkForce(card, destDir("model-card.json"))
	await removeIfPresent(destDir("tokenizer.model"))
}

async function linkBaseModelPair(destDir: PathBuilder, digestCard: string | undefined): Promise<void> {
	const recipe = await readReleaseConfig()

	const dataRoot = dataRootPath()
	const digests = digestCard ? (await readWeightsCard(digestCard))?.files_md5 : undefined

	const pair = [
		{ label: "model", name: "model.onnx", override: $public.MAILWOMAN_DEV_MODEL, recipe: recipe.weights.model },
		{
			label: "tokenizer",
			name: "tokenizer.model",
			override: $public.MAILWOMAN_DEV_TOKENIZER,
			recipe: recipe.weights.tokenizer,
		},
	]

	for (const { label, name, override, recipe: recipePath } of pair) {
		const source = override || dataRoot(recipePath)

		if (!(await pathExists(source))) {
			throw new Error(`missing source ${label}: ${source} — set MAILWOMAN_DEV_${label.toUpperCase()} to override`)
		}

		const dest = destDir(name)

		await linkForce(source, dest)

		console.log(`linked ${dest} ← ${source}`)

		if (!digestCard) continue

		if (override) {
			console.error(`  (${label} override active — skipping the #397 default-digest check)`)

			continue
		}

		const expected = digests?.[name]

		if (!expected) {
			throw new Error(
				`#397 guard: ${digestCard}/model-card.json has no files_md5 entry for ${name} — cannot verify the dev pin.`
			)
		}

		const actual = await md5File(dest)

		if (actual !== expected) {
			throw new Error(
				`#397 guard: linked default ${label} md5 ${actual} != shipped ${expected} (${digestCard} model-card files_md5). ` +
					`The dev link has drifted from the shipped default: bump release.config.json weights.${label} and the card's ` +
					`files_md5 in lockstep.`
			)
		}

		console.log(`  ${name} digest ok`)
	}
}

async function buildPostcodeBinary(
	destDir: PathBuilder,
	cli: PathBuilder,
	{ country, database }: { country: string; database: PathBuilder }
): Promise<void> {
	const artifact = `postcode-${country.toLowerCase()}.bin`
	const dest = destDir(artifact)

	if (await pathExists(dest)) {
		console.log(`skipped ${artifact} build — ${dest} already present`)

		return
	}

	if (!(await pathExists(cli))) {
		console.error(
			`WARNING: ${cli} not built — run \`yarn compile\` first, then re-run this script to build ${artifact}.`
		)

		return
	}

	if (!(await pathExists(database))) {
		console.error(
			`WARNING: missing ${database} — ${artifact} not built; the anchor channel will resolve OFF for ${country.toUpperCase()}.`
		)

		return
	}

	const result = spawnProcessSync(
		process.execPath,
		[
			cli,
			"gazetteer",
			"postcode-binary",
			"--out",
			destDir,
			"--locale",
			`${country.toUpperCase()}:${database.toString()}`,
		],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !(await pathExists(dest))) {
		throw new Error(`failed to build ${dest} (exit ${result.status})`)
	}

	console.log(`built ${dest}`)
}

/**
 * Materializes one locale's dev weights overlay from its manifest.
 */
export async function materializeDevOverlay(manifest: DevOverlayManifest): Promise<DevOverlay> {
	const destDir = weightsOverlayPath(manifest.locale)
	const cli = workspacePathBuilder("mailwoman", "out", "cli", "index.js")
	const card = await readWeightsCard(`neural-weights-${manifest.locale}`)

	await makeDirectories(destDir)

	if (manifest.model?.kind === "inherit") {
		await removeIfPresent(destDir("model.onnx"))
		await removeIfPresent(destDir("tokenizer.model"))
	} else if (manifest.model?.kind === "link") {
		await linkBaseModelPair(destDir, manifest.model.digestCard)
	} else if (manifest.model?.kind === "char") {
		await linkCharModel(destDir, manifest.model.family)
	}

	for (const { source, name, consequenceIfMissing } of manifest.softFeed ?? []) {
		await linkSoftFeedSibling(source, destDir(name), consequenceIfMissing)
	}

	if (manifest.evidenceLexiconsFromCard) {
		for (const { channel, source } of EVIDENCE_LEXICON_SOURCES) {
			const declared = card?.requires?.[channel]?.lexicon

			if (!declared) {
				console.error(`WARNING: model-card declares no requires.${channel}.lexicon — the ${channel} channel stays OFF.`)

				continue
			}

			await linkSoftFeedSibling(
				source(declared),
				destDir(declared),
				`the ${channel} channel will resolve OFF in this worktree.`
			)
		}
	}

	if (manifest.postcodeBinary) {
		await buildPostcodeBinary(destDir, cli, manifest.postcodeBinary)
	}

	if (manifest.pairIndex) {
		await buildPairIndexOverlay({ packageDir: `neural-weights-${manifest.locale}`, ...manifest.pairIndex })
	}

	if (manifest.localeFST) {
		await linkLocaleFST(destDir, manifest.locale)
	}

	if (manifest.streetMorphologyFST) {
		await linkStreetMorphologyFST(destDir)
	}

	return { destDir, cli, card }
}
