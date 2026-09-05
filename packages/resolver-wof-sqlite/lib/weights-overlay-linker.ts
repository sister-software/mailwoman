/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * Shared development tooling for weights overlays: the symlink primitives every overlay linker uses, the
 * placetype-pair index build, and the manifest form ({@link materializeDevOverlay}) each locale's
 * `scripts/link-dev-weights.ts` declares itself in.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { $public } from "@mailwoman/core/env"
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
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { readReleaseConfig, repoCommittedSoftFeedSources } from "@mailwoman/core/release-config"
import { weightsOverlayPath } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import { fstFreshnessWarning } from "#fst/freshness"

/**
 * Replicate `ln -sf SRC DEST` ATOMICALLY: symlink under a temp name, then rename over the destination. A plain
 * unlink-then-symlink leaves a no-file window that concurrent vitest workers can hit mid-suite — bit CI on 2026-07-24.
 * rename(2) replaces the destination atomically.
 */
export async function linkForce(src: string, dest: string): Promise<void> {
	const tmp = `${dest}.tmp-link`

	if (await pathExists(tmp)) {
		await removePath(tmp)
	}

	await createSymbolicLink(src, tmp)
	await movePath(tmp, dest)
}

/**
 * Remove a leftover local file/symlink so the #1179 base-weights fallback engages.
 */
export async function removeIfPresent(dest: string): Promise<void> {
	try {
		await statLink(dest)
	} catch {
		return
	}

	await removePath(dest)

	console.log(`removed stale local ${dest} (base fallback to en-us engages)`)
}

/**
 * Symlink one soft-feed sibling into an overlay, warning rather than failing when the source is absent.
 *
 * Every one of these artifacts is OPTIONAL by design — the runtime has a fallback for each, so a fresh worktree that
 * has not built the gazetteer still geocodes. That is why the miss prints the consequence instead of throwing: the
 * operator needs to know which channel just resolved OFF, not to have the link step abort.
 */
export async function linkSoftFeedSibling(
	source: string,
	destination: string,
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
 * The calibrated pair-index emission bias every shipped artifact is built at today — the R5/R6/R9/R10/R11 bars were all
 * measured at δ=10 (each linker's own docstring carries its locale's receipt).
 */
export const PAIR_INDEX_DELTA = 10

/**
 * The decoder transition-entry bonus (TRANSITION-BETA build, 2026-07-24 — operator-approved β=5 from the
 * transition-level probe). en-nz deliberately builds WITHOUT one (unmeasured there): the two magnitudes are calibrated
 * independently, and a locale earning one says nothing about the other.
 */
export const PAIR_INDEX_TRANSITION_BETA = 5

/**
 * The WHOLE-EDGE parent-bias magnitude (#46, default-on 2026-08-04) at the verdict's recommended δ=5 — see
 * `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`. Only the measured locales (us/gb/nz/fr) pass it; the
 * D-rule's answer to an unmeasured locale is a per-locale absence, not an inherited magnitude.
 */
export const PAIR_INDEX_PARENT_DELTA = 5

/**
 * What one pair-index build has to say about itself. Everything else is shared.
 */
export interface PairIndexOverlay {
	/**
	 * Workspace directory name, e.g. `neural-weights-de-de`.
	 */
	packageDir: string
	/**
	 * ISO country code passed to `gazetteer pair-index --country`, and the suffix of the built artifact (`de` →
	 * `pair-index-de.bin`). NOT the locale tag: `en-in` builds `pair-index-in.bin`.
	 */
	country: string
	/**
	 * Calibrated magnitudes the locale's bars were measured at. Baked into the artifact's PIX1 header, which is how the
	 * freshness check notices a change to any of them. An ABSENT `transitionBeta`/`parentDelta` means the flag is not
	 * passed and the header carries no such key — a real state, distinct from zero (see `PairIndexHeader.parentDelta`).
	 * The whole calibration feeds both the build FLAGS and the staleness EXPECTATION, so the two cannot disagree.
	 */
	delta: number
	transitionBeta?: number
	parentDelta?: number
	/**
	 * Source FILES whose md5s the build records, in the order `gazetteer pair-index` records them. The freshness guard
	 * compares EVERY one against the existing header (#1734): a partial comparison leaves the guard blind to the rest,
	 * and a stale artifact then keeps reporting itself fresh while the data it was built from has moved. Empty means the
	 * build's source cannot be file-hashed (fr's BAN directory) and freshness rests on the magnitudes alone. Default: the
	 * WOF admin DB.
	 */
	sources?: string[]
	/**
	 * Inputs that must exist before a build is attempted — a missing one warns and returns, because a fresh clone has no
	 * data root and `yarn test` invokes the linkers to verify auto-resolve. Default: `sources`.
	 */
	inputs?: string[]
	/**
	 * Extra CLI args naming the build's sources (`--source`, `--borough-db`, `--pairs-jsonl`, `--ban-dir`). Default:
	 * `--borough-db <admin db>`.
	 */
	extraArgs?: string[]
	/**
	 * Refuse to trust an existing artifact smaller than this. fr-fr's guard: a pair index built from the WRONG source can
	 * carry matching magnitudes, and size is the one signal the header cannot fake.
	 */
	minimumPlausibleBytes?: number
}

/**
 * The header fields a dev-weights freshness guard reads.
 */
export interface PairIndexHeaderFields {
	delta: number
	transitionBeta: number | undefined
	parentDelta: number | undefined
	schemaVersion: number
	/**
	 * One md5 per source the build read, in fold order. Empty on a header that recorded none.
	 */
	sourceMD5s: string[]
}

/**
 * Minimal PIX1 header reader — magic + header only, reimplemented so a data-only weights package gains no dependency on
 * `@mailwoman/neural` (which pulls onnxruntime-node) to read a few fields. `neural/pair-index-resolver.ts`'s own header
 * parse is the source of truth this must follow.
 *
 * Shared by the overlay build below AND by the four hand-written base linkers
 * (`neural-weights-{en-us,en-gb,en-nz,fr-fr}/scripts/link-dev-weights.ts`), which each carried their own near-copy
 * before 2026-08-04 — the ×5 clone the taste audit named, and the reason three of them were schema-blind while this one
 * was not.
 */
export async function peekPairIndexHeaderFields(path: string): Promise<PairIndexHeaderFields> {
	const bytes = await readLocalBuffer(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// "PIX1" little-endian.
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

/**
 * Hex characters in an md5 digest.
 */
const MD5_HEX_LENGTH = 32

/**
 * Md5 of `path`, cached in a standard `md5sum`-format sidecar (`<hash> <filename>`) beside it so a multi-gigabyte
 * source is hashed once per change rather than once per linker run. The sidecar is trusted only when at least as new as
 * the source; a missing or stale sidecar recomputes and rewrites, so the cache self-heals.
 *
 * The shared home for the copies the base linkers (`en-us`, `en-gb`, `en-nz`) each carry — new callers import this one.
 */
export async function md5FileWithSidecar(path: string): Promise<string> {
	const sidecarPath = `${path}.md5`
	const sourceStats = await statPath(path)

	if (await pathExists(sidecarPath)) {
		try {
			if ((await statPath(sidecarPath)).mtime >= sourceStats.mtime) {
				const [hash] = (await readLocalTextFile(sidecarPath)).trim().split(/\s+/)

				if (hash && hash.length === MD5_HEX_LENGTH) return hash
			}
		} catch {
			// Unreadable sidecar — recompute below.
		}
	}

	const hash = await md5File(path)
	const filename = path.split(/[/\\]/).pop() || path

	await writeLocalTextFile(`${hash}  ${filename}\n`, sidecarPath)

	return hash
}

/**
 * The calibrated magnitudes a linker bakes into its artifact. `undefined` means the flag is NOT passed and the header
 * carries no such key — a real state, distinct from zero (see `PairIndexHeader.parentDelta`), so the comparison below
 * is `!==` against `undefined` rather than a truthiness test.
 */
export interface PairIndexCalibration {
	delta: number
	transitionBeta?: number
	parentDelta?: number
}

/**
 * Why an existing `pair-index-*.bin` is stale against `expected`, or `undefined` when its header matches. Covers the
 * FORMAT (schemaVersion) and every calibrated magnitude; source-md5 freshness stays with the caller, because each base
 * linker passes a different set of sources and only it knows what they are.
 *
 * One place so a magnitude added to the header cannot be checked by some linkers and not others — which is exactly how
 * three of the four base linkers ended up unable to notice a schema bump.
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
 * The PIX1 schema this tree's reader requires. MUST equal `KNOWN_SCHEMA_VERSION` in `neural/pair-index-resolver.ts` —
 * they are two ends of one fact, and this copy exists only because a data-only overlay must not gain a dependency on
 * `@mailwoman/neural` (onnxruntime-node) to read one header field. Bump BOTH in the same commit; a schema bump that
 * leaves this behind makes every dev checkout rebuild-loop or serve an artifact the runtime refuses.
 *
 * The freshness guard must compare it: a guard that checks only delta + source md5 reads a format-obsolete binary as
 * "current" and leaves every dev checkout with artifacts the runtime refuses — the R5 freshness-guard lesson, format
 * edition. Also compared by the four hand-written base linkers (`neural-weights-{en-us,en-gb,en-nz,fr-fr}`), which
 * import this constant rather than re-typing the number.
 */
export const REQUIRED_PAIR_INDEX_SCHEMA = 3

/**
 * Warn when the per-locale FST a linker just symlinked was built from a DIFFERENT admin database than the one on disk
 * now.
 *
 * WHY IT WARNS RATHER THAN REBUILDS, unlike its pair-index sibling above. A pair index is seconds of work and the
 * linker owns its whole recipe. A locale FST is a multi-minute build whose output goes to a STAGING dir on purpose —
 * the swap into `fst-per-locale/` is operator-approved after the battery, because an FST changes decoder behaviour and
 * the D-rule does not let that land unmeasured. So the guard's job is to make the drift impossible to miss, and to name
 * the command that starts fixing it. It is also why a stale FST is never fatal: the artifact is a decode-time bias
 * list, and a dev tree must still run.
 *
 * The source-side half of the comparison lives here rather than in `fst-freshness.ts` for the same reason
 * `pairIndexStaleReason` splits: only the caller knows which database it built against. All three FST-linking base
 * packages build against the same one, so they share this rather than each pinning it.
 */
export async function warnIfFSTStale(fstPath: string, locale: string): Promise<void> {
	const warning = await fstFreshnessWarning({
		fstPath,
		sourceDBPath: String(dataRootPath("wof", "admin-global-priority.db")),
		rebuildCommand: `node packages/mailwoman/out/cli.js gazetteer build fst --locales ${locale}  (writes to a staging dir; swap is operator-conditional)`,
	})

	if (warning) {
		console.error(warning)
	}
}

/**
 * Symlink the per-locale FST gazetteer (`fst-<locale>.bin`) from the shared build area
 * (`$MAILWOMAN_DATA_ROOT/wof/fst-per-locale/`) into an overlay so `resolveWeights` surfaces `fstPath` in dev and the
 * runtime pipeline can auto-wire the gazetteer + street-context check, then run {@link warnIfFSTStale} on the linked
 * artifact. The publish flow stages the real binary (release-sequenced).
 */
export async function linkLocaleFST(destDir: string, locale: string): Promise<void> {
	const source = String(dataRootPath("wof", "fst-per-locale", `fst-${locale}.bin`))

	const linked = await linkSoftFeedSibling(
		source,
		resolvePath(destDir, `fst-${locale}.bin`),
		"the FST gazetteer default will resolve OFF for this locale."
	)

	if (linked) {
		await warnIfFSTStale(source, locale)
	}
}

/**
 * Symlink the sealed locale-general street-morphology FST (`$MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin`,
 * `mailwoman gazetteer build street-morphology`) into an overlay so `resolveWeights` surfaces `streetMorphologyPath` in
 * dev and the street-context check (#1315) deserializes the artifact instead of rebuilding from the libpostal
 * dictionaries per process. Missing is non-fatal — the runtime loader's dictionary-build fallback covers it.
 */
export async function linkStreetMorphologyFST(destDir: string): Promise<void> {
	await linkSoftFeedSibling(
		String(dataRootPath("wof", "fst-street-morphology.bin")),
		resolvePath(destDir, "fst-street-morphology.bin"),
		"the street-context check falls back to the per-process dictionary build."
	)
}

/**
 * Why an existing artifact may be TRUSTED without a rebuild, or `undefined` when it must be rebuilt (with the reason
 * already printed). The skip requires both halves (#1734): the header magnitudes + format (`pairIndexStaleReason`) AND
 * the header's `sourceMD5s` against the current sources' md5s. Magnitudes alone read a source change as "current"
 * whenever pair counts happen not to move the calibrated numbers — the R5 freshness-guard lesson, which resurfaced in
 * the 2026-08-18 admin swap. A source that is not on disk to re-hash leaves the magnitudes as the best available answer
 * (the "missing source, can't build" branch below would fire anyway if a rebuild were needed).
 */
async function pairIndexIsFresh(
	dest: string,
	artifact: string,
	expected: PairIndexCalibration,
	sources: string[],
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
 * Build `pair-index-<country>.bin` into the overlay, skipping the work when the artifact on disk was already built at
 * these magnitudes FROM the sources on disk (see {@link pairIndexIsFresh}). The calibration object drives both the
 * staleness expectation and the CLI flags, so a magnitude cannot be checked by the guard and dropped from the build.
 *
 * Exits non-zero on a failed build. Missing INPUTS (an unbuilt CLI, an absent source) warn and return instead: a fresh
 * clone has neither, and `yarn test` invokes this to verify auto-resolve, so a hard failure there would be a failure to
 * have run a build yet rather than a real fault.
 */
export async function buildPairIndexOverlay(overlay: PairIndexOverlay): Promise<void> {
	const { packageDir, country, delta, transitionBeta, parentDelta } = overlay
	const CLI = String(workspacePath("mailwoman", "out", "cli.js"))
	const ARTIFACT = `pair-index-${country}.bin`
	// Built into the data-root OVERLAY, not into the tracked package. The locale is recovered from the
	// workspace name (`neural-weights-en-gb` → `en-gb`) so callers keep passing the one identifier they
	// already had.
	const PKG_DIR = String(weightsOverlayPath(packageDir.replace(/^neural-weights-/, "")))
	const DEST = resolvePath(PKG_DIR, ARTIFACT)

	await makeDirectories(PKG_DIR)

	/**
	 * Checked-in WOF-derived admin pairs — the default source, and the whole source list for the small overlays.
	 */
	const WOF_ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))
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

// --- the manifest form ----------------------------------------------------------------------------------------------

/**
 * A soft-feed sibling an overlay links: where it comes from, the name it takes in the overlay, and the consequence line
 * printed when the source is missing (the link is warn-and-continue; the channel resolves OFF).
 */
export interface SoftFeedLink {
	source: string
	name: string
	consequenceIfMissing: string
}

/**
 * The committed soft-feed lexicons as links, by channel, read from `release.config.json` so the filename a manifest
 * links is the one the release ships. `streetType` is offered for completeness; the manifests link the evidence
 * lexicons by the generation their CARD names instead (`evidenceLexiconsFromCard`).
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
 * The slice of a weights package's committed `model-card.json` the dev materialization reads: the shipped digests the
 * release re-verifies against the published tarball, and the channel requirements that name evidence lexicons.
 */
export interface WeightsCard {
	files_md5?: Record<string, string>
	requires?: Record<string, { lexicon?: string; span_mode?: string } | undefined>
}

/**
 * What one locale's `scripts/link-dev-weights.ts` declares, so an overlay is a manifest plus a call rather than a
 * script cloned from a sibling. Every step is optional and runs only when named, in a fixed order: model pair,
 * soft-feed siblings, card-named evidence lexicons, postcode binary, pair index, FSTs.
 */
export interface DevOverlayManifest {
	/**
	 * The overlay's locale tag, lower-case. The workspace is `neural-weights-<locale>` and the artifacts land in
	 * `$MAILWOMAN_DATA_ROOT/weights/<locale>/`, never in the tracked package: the binaries are not in git, so
	 * materializing them there made a fresh worktree unable to geocode, made `yarn test` mutate a tracked directory, and
	 * put a symlink into a publish tarball (`YN0035`).
	 */
	locale: string
	/**
	 * What happens to `model.onnx` + `tokenizer.model`. `link`: the pair is symlinked from the paths
	 * `release.config.json`'s `weights` block names under the data root (`$MAILWOMAN_DEV_MODEL` /
	 * `$MAILWOMAN_DEV_TOKENIZER` override them), and when `digestCard` names a workspace the linked default bytes must
	 * match that workspace's card `files_md5` — the #397 drift guard, which fails loud instead of grading the wrong
	 * model; an override skips the check and says so. `inherit`: the package declares `mailwoman.baseWeights`, so any
	 * local pair is REMOVED — a stale local file shadows the base fallback and silently serves outdated bytes. Omitted:
	 * the pair is left to `packages/release-kit/lib/weights/link-weights-overlay.ts`, the recipe writer.
	 */
	model?: { kind: "link"; digestCard?: string } | { kind: "inherit" }
	/**
	 * Soft-feed siblings linked warn-and-continue, in order.
	 */
	softFeed?: ReadonlyArray<SoftFeedLink>
	/**
	 * Link the evidence lexicons the overlay's own card names under `requires.<channel>.lexicon`, so the generation comes
	 * from the card the loader reads and a card bump moves the artifact with it. `street-type-lexicon-v*.json` is
	 * committed under `data/gazetteer/`; `locality-surface-lexicon-v*.json` is 7–13 MB and lives in the data root.
	 */
	evidenceLexiconsFromCard?: boolean
	/**
	 * Build `postcode-<country>.bin` from a WOF postcode extract through the compiled `gazetteer postcode-binary` CLI,
	 * skipped when already present (it rebuilds in seconds, and the extract is versionless on disk).
	 */
	postcodeBinary?: { country: string; database: string }
	/**
	 * The placetype-pair index build, minus `packageDir`, which follows from `locale`.
	 */
	pairIndex?: Omit<PairIndexOverlay, "packageDir">
	/**
	 * Link `fst-<locale>.bin` with its freshness warning.
	 */
	localeFST?: boolean
	/**
	 * Link the shared street-morphology FST.
	 */
	streetMorphologyFST?: boolean
}

/**
 * What a materialized overlay hands back for the locale-specific step a manifest cannot express (en-gb's
 * card-conditional postcode binary is the one that exists).
 */
export interface DevOverlay {
	destDir: string
	cli: string
	card: WeightsCard | undefined
}

/**
 * Where each evidence channel's lexicon is found, by the name the card declares.
 */
const EVIDENCE_LEXICON_SOURCES: ReadonlyArray<{
	channel: "street_type" | "locality_surface"
	source: (name: string) => string
}> = [
	{ channel: "street_type", source: (name) => String(repoRootPath("data", "gazetteer", name)) },
	{ channel: "locality_surface", source: (name) => String(dataRootPath("gazetteer", name)) },
]

/**
 * Read a weights workspace's committed card, or `undefined` when the workspace carries none.
 */
async function readWeightsCard(workspace: string): Promise<WeightsCard | undefined> {
	const path = resolvePath(String(workspacePath(workspace)), "model-card.json")

	if (!(await pathExists(path))) return undefined

	return readLocalJSONFile<WeightsCard>(path)
}

/**
 * Link the base model pair from the release recipe and, when a digest card is named, hold the linked default bytes to
 * that card's `files_md5`. The recipe and the card are the two registers a ship bumps in lockstep; a path bumped
 * without the card, or the reverse, fails here rather than after an eval shift graded against the wrong weights.
 */
async function linkBaseModelPair(destDir: string, digestCard: string | undefined): Promise<void> {
	const recipe = await readReleaseConfig()

	const dataRoot = String(dataRootPath())
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
		const source = override || resolvePath(dataRoot, recipePath)

		if (!(await pathExists(source))) {
			throw new Error(`missing source ${label}: ${source} — set MAILWOMAN_DEV_${label.toUpperCase()} to override`)
		}

		const dest = resolvePath(destDir, name)

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

/**
 * Build a postcode binary from a WOF postcode extract, skip-if-present. A missing CLI or extract is a warning (the
 * anchor channel resolves OFF for that country); a build that runs and fails is an error.
 */
async function buildPostcodeBinary(
	destDir: string,
	cli: string,
	{ country, database }: { country: string; database: string }
): Promise<void> {
	const artifact = `postcode-${country.toLowerCase()}.bin`
	const dest = resolvePath(destDir, artifact)

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
		[cli, "gazetteer", "postcode-binary", "--out", destDir, "--locale", `${country.toUpperCase()}:${database}`],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !(await pathExists(dest))) {
		throw new Error(`failed to build ${dest} (exit ${result.status})`)
	}

	console.log(`built ${dest}`)
}

/**
 * Materialize one locale's dev overlay from its manifest. The steps run in the order {@link DevOverlayManifest}
 * documents, each independent on disk, and the result carries what a locale-specific step needs afterwards.
 */
export async function materializeDevOverlay(manifest: DevOverlayManifest): Promise<DevOverlay> {
	const destDir = String(weightsOverlayPath(manifest.locale))
	const cli = String(workspacePath("mailwoman", "out", "cli.js"))
	const card = await readWeightsCard(`neural-weights-${manifest.locale}`)

	await makeDirectories(destDir)

	if (manifest.model?.kind === "inherit") {
		await removeIfPresent(resolvePath(destDir, "model.onnx"))
		await removeIfPresent(resolvePath(destDir, "tokenizer.model"))
	} else if (manifest.model?.kind === "link") {
		await linkBaseModelPair(destDir, manifest.model.digestCard)
	}

	for (const { source, name, consequenceIfMissing } of manifest.softFeed ?? []) {
		await linkSoftFeedSibling(source, resolvePath(destDir, name), consequenceIfMissing)
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
				resolvePath(destDir, declared),
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
