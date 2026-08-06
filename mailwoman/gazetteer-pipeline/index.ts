/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate-gazetteer build → promote → publish pipeline, as reusable functions the `mailwoman
 *   gazetteer` commands compose. This is the codified version of the 2026-06-27 manual rebuild
 *   (RELEASING.md Step 5): the durable GeoNames-alias upstream fold, the candidate build with the
 *   FTS5-trigram fuzzy index baked in, the local convention-path promotion, and the R2 + demo
 *   publish — every decision that needed a question last time is a default here.
 *
 *   `fold` and `build` reuse the CANONICAL package functions (`ingestGeonamesAliases`,
 *   `buildPlaceSearchFTS`, `buildCandidateTable`) so the CLI, the standalone scripts, and a future
 *   `build-unified-wof --geonames-countries` all share ONE implementation. `publish` shells out to
 *   the proven `scripts/publish-demo-assets-to-r2.py` (boto3 + the R2 cache-control gotchas) and
 *   bumps the demo's `ADMIN_GAZETTEER_VERSION` — the only repo-coupled step, so its repo paths are
 *   passed in.
 */

import { execFileSync } from "node:child_process"
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { sealDatabase } from "@mailwoman/core/utils"
// resolver-wof-sqlite is an OPTIONAL peer dep of mailwoman (geocoding is opt-in) — import it
// DYNAMICALLY inside the functions (the geocode.tsx convention), NOT at module load, so that merely
// loading these commands (e.g. `mailwoman --help`, which eagerly imports every command) doesn't fault
// when the peer isn't installed. Types are erased, so type-only imports are safe at module level.
import type { GeonamesIngestProgress } from "@mailwoman/resolver-wof-sqlite"
import type { BuildCandidateResult } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import { resolvePath } from "path-ts"

import { mailwomanDataRoot } from "../resolver-backend.ts"
import { emitCoverageManifest } from "./coverage-manifest.ts"
import { DEFAULT_GEONAMES_COUNTRIES, geonamesAdminGapCountries } from "./defaults.ts"

/**
 * The country set a standalone fold re-derives — the SAME recipe `buildAdmin` bakes into the admin artifact
 * ({@link DEFAULT_GEONAMES_COUNTRIES}), because the fold rewrites its whole id range and any narrower list drops the
 * difference (#1514).
 *
 * It used to be the 14-country bilingual EU set this fold was born for (#743/#193 — FI hard-resolve 69.5 → 85.8 %),
 * from when the fold was a separate step run against an UNFOLDED admin. #1027 moved the fold inside `buildAdmin` and
 * widened it to 161 countries; the 14-country default outlived that and became the payload of the 2026-08-05 incident,
 * re-folding 212,993 places over the front of a 774,338-place range and leaving the rest of the world's names attached
 * to Austrian, Swiss and Lithuanian villages.
 */
export const DEFAULT_FOLD_COUNTRIES = DEFAULT_GEONAMES_COUNTRIES

/**
 * The canonical postcode-shard set (filenames under `<data-root>/wof/`): US + the WOF intl shard (NL/FR/DE/ES/IT) + the
 * GeoNames intl shard (PT/AU) + the OS Code-Point Open GB shard + the OSM Northern Ireland shard + the GeoNames-postal
 * tail shard (nine countries) + Overture postcode centroids (CA + the EU-coverage locales). Missing shards are skipped,
 * not fatal.
 *
 * That skip is not merely tolerant — it is the **build-local tier's mechanism**. `postalcode-ni-osm.db` is ODbL and is
 * never published, so on every machine but the one that built it the `existsSync` filter in
 * {@link resolvePostcodeShards} removes it and the set degrades to the permissive shards alone. Nothing else enforces
 * the tier, and nothing else needs to.
 *
 * What is left out: the WOF **`postalcode-gb.db`** (2,719,772 rows, 694 MB — superseded by Code-Point Open, the same
 * underlying survey under a clean licence) and **`postalcode-jp.db`** (142,604 rows, 37 MB).
 */
export const DEFAULT_POSTCODE_SHARDS = [
	"postalcode-us.db",
	"postalcode-intl.db",
	"postalcode-geonames-intl.db",
	// GB via OS Code-Point Open under OGL v3 (operator licence ruling 2026-08-05): 1,746,976 unit
	// postcodes, England+Scotland+Wales — NO Northern Ireland (excluded from every permissive UK
	// grant; see the codepoint builder's NI note). Replaces the GeoNames GB rows, which the
	// 2026-08-05 parity gate measured as the SAME survey (max coordinate delta 6.6 m over 1.75M
	// joined rows) under a muddled licence. Rebuild: `mailwoman gazetteer build postcode-codepoint`.
	"postalcode-gb-codepoint.db",
	// Northern Ireland (BT), the hole Code-Point Open leaves — 4,757 of 50,032 live NI postcodes (9.5 %),
	// 250/886 sectors, 80/80 districts, from OpenStreetMap `addr:postcode` (2026-08-05 cut). A miss on a
	// BT code means NOT ATTESTED IN OSM, not that the code does not exist; since #1480 an unknown postcode
	// abstains, so the partial shard is strictly additive.
	//
	// BUILD-LOCAL TIER — ODbL 1.0 is share-alike on a Derived Database, so this artifact is never
	// published to npm, R2 or the demo. It is present only on a machine that built it, and the
	// `existsSync` filter in `resolvePostcodeShards` IS that tier's mechanism: a deployment without the
	// file simply has no NI coverage, exactly as before.
	// Rebuild: `mailwoman gazetteer build postcode-ni-osm` (add `--offline` to rebuild from the saved
	// Overpass response rather than re-querying a volunteer endpoint).
	"postalcode-ni-osm.db",
	// #920: the GeoNames-postal tail shard — NINE countries in ingest order FI/CZ/SK/SI/DK/NO/HR/PL/SE
	// (56,075 rows). GB rode in this shard 2026-07-03 → 2026-08-05 and moved to Code-Point Open above.
	// Rebuild: `mailwoman gazetteer build postcode-geonames --countries FI,CZ,SK,SI,DK,NO,HR,PL,SE`.
	"postalcode-geonames-tail.db",
	"postcode-ca-overture.db",
	...["at", "be", "ch", "cz", "dk", "es", "fi", "hr", "lt", "lu", "lv", "no", "pl", "pt", "si", "sk"].map(
		(cc) => `postcode-${cc}-overture.db`
	),
]

/**
 * The conventional admin source the fold copies from.
 */
export const DEFAULT_ADMIN_DB = "admin-global-priority.db"
/**
 * The conventional candidate-build output.
 */
export const DEFAULT_CANDIDATE_OUT = "candidate-global.db"

/**
 * `<data-root>/wof`, where the admin DB, candidate DB, postcode shards, and the convention symlink live.
 *
 * This helper and its two siblings below compose with path-ts's `resolvePath`, not `node:path`'s `join` — the same
 * builder `wofShardPaths` (`core/utils/data-root.ts`) uses for the identical shape, a caller-supplied root plus a fixed
 * subdirectory. It also makes the return ABSOLUTE, which the docstrings above have always claimed: the default root is
 * absolute, so `join` only differed for a caller that passed a relative `--data-root`, and for that caller it silently
 * produced a cwd-relative path the sealed-artifact swap would then resolve somewhere else.
 */
export function wofDir(dataRoot: string = mailwomanDataRoot()): string {
	return resolvePath(dataRoot, "wof")
}

/**
 * `<data-root>/geonames`, the per-country GeoNames dump dir.
 */
export function geonamesDir(dataRoot: string = mailwomanDataRoot()): string {
	return resolvePath(dataRoot, "geonames")
}

/**
 * `<data-root>/geonames-alternate`, the per-country alternateNamesV2 dump dir (#936 language tags).
 */
export function geonamesAlternateDir(dataRoot: string = mailwomanDataRoot()): string {
	return resolvePath(dataRoot, "geonames-alternate")
}

/**
 * Resolve the canonical postcode-shard filenames to absolute paths, keeping only those present.
 */
export function resolvePostcodeShards(
	shards: readonly string[] = DEFAULT_POSTCODE_SHARDS,
	dataRoot: string = mailwomanDataRoot()
): string[] {
	return shards.map((s) => resolvePath(wofDir(dataRoot), s)).filter((p) => existsSync(p))
}

export interface FoldOptions {
	/**
	 * Source admin (unified-WOF) DB — read via the copy, never mutated.
	 */
	adminIn: string
	/**
	 * Destination admin DB carrying the folded GeoNames names. MUST differ from `adminIn`.
	 */
	adminOut: string
	/**
	 * ISO 3166-1 alpha-2 codes whose GeoNames dumps to fold (default {@link DEFAULT_FOLD_COUNTRIES}).
	 */
	countries?: readonly string[]
	/**
	 * Dir holding `<CC>.txt` GeoNames dumps (default {@link DEFAULT_FOLD_COUNTRIES}).
	 */
	geonamesDir?: string
	/**
	 * #267: the countries to ALSO fold A-class admin (PCLI + ADM1) for, linking the locality→region→country ancestry.
	 * ZERO-COVERAGE gap countries only (the coverage-expansion targets) — a country that already has WOF admin would
	 * double up, so the EU alias set is left off. Without it the gap localities are orphans and "Tbilisi, GE" can't
	 * resolve.
	 */
	adminForCountries?: ReadonlySet<string>
	/**
	 * #936: dir holding `<CC>.txt` alternateNamesV2 dumps (default {@link geonamesAlternateDir}) — tags alias rows with
	 * language / privateuse / `official`. Countries without a file fold untagged, exactly as before.
	 */
	alternateDir?: string
	/**
	 * #1514 escape hatch: proceed even when `adminIn` already carries alias rows for countries this run does NOT list.
	 * The fold owns its whole id range and rewrites it wholesale, so those countries are DROPPED. Only pass this when
	 * shrinking the fold is the point.
	 */
	allowCoverageLoss?: boolean
	onCountry?: (event: GeonamesIngestProgress) => void
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * How many of the dropped country codes the coverage-loss error names before eliding. The realistic miss is the whole
 * fold minus a handful (161 → 14 in the #1514 incident), so the list is there to make the SHAPE of the mistake obvious,
 * not to enumerate it — a dozen codes plus the count does that on one terminal line.
 */
const DROPPED_COUNTRIES_SHOWN = 12

export interface FoldResult {
	ingested: number
	placeSearchRows: number
	bboxRows: number
	/**
	 * Countries whose alias rows `adminIn` already carried — the fold re-derives every one of them.
	 */
	refoldedCountries: string[]
}

/**
 * Durable GeoNames upstream fold: copy the admin DB, fold the GeoNames places + Latin alt-names into its canonical
 * `spr`/`names`/`place_population`, then rebuild `place_search`/`place_bbox` so the candidate build carries them.
 * Build-on-copy — `adminIn` is never touched.
 *
 * #1514: the fold owns the id range `[9e12, 9.5e12)` and rewrites it WHOLESALE — the synthetic id is a position in the
 * run, so a partial rewrite binds one run's names to another run's places. Folding a country set narrower than what
 * `adminIn` already carries therefore DROPS the difference, and since `buildAdmin` bakes the full
 * `DEFAULT_GEONAMES_COUNTRIES` fold into every admin artifact it builds, that is the normal case here rather than an
 * exotic one. The pre-flight below refuses it unless {@link FoldOptions.allowCoverageLoss} says otherwise.
 */
export async function foldGeonamesIntoAdmin(opts: FoldOptions): Promise<FoldResult> {
	if (opts.adminIn === opts.adminOut) {
		throw new Error("fold must write a distinct adminOut (build-on-copy, never in place)")
	}

	if (!existsSync(opts.adminIn)) throw new Error(`admin DB not found: ${opts.adminIn}`)

	const { GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE, ingestGeonamesAliases, buildPlaceSearchFTS } =
		await import("@mailwoman/resolver-wof-sqlite")

	const countries = [...(opts.countries ?? DEFAULT_FOLD_COUNTRIES)]

	// Pre-flight on the SOURCE, before the copy: what does it already carry in the fold's range?
	opts.onPhase?.("preflight", "reading the source's existing alias-fold coverage")
	const source = new DatabaseSync(opts.adminIn, { readOnly: true })

	const refoldedCountries = (
		source
			.prepare(`SELECT DISTINCT country FROM spr WHERE id >= ? AND id < ? ORDER BY country`)
			.all(GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE) as Array<{ country: string }>
	)

		.map((r) => r.country)

	source.close()

	const requested = new Set(countries)
	const dropped = refoldedCountries.filter((cc) => !requested.has(cc))

	if (dropped.length && !opts.allowCoverageLoss) {
		throw new Error(
			`fold would DROP the GeoNames alias coverage ${opts.adminIn} already carries for ${dropped.length} ` +
				`countries (${dropped.slice(0, DROPPED_COUNTRIES_SHOWN).join(", ")}` +
				`${dropped.length > DROPPED_COUNTRIES_SHOWN ? ", …" : ""}). The fold rewrites ` +
				`its whole id range, so anything not in this run's country list disappears. ` +
				`\`mailwoman gazetteer build admin\` already folds ${refoldedCountries.length} countries into the admin ` +
				`artifact — build the candidate from it directly (--no-fold), pass --countries covering them, or set ` +
				`allowCoverageLoss when shrinking the fold is the point.`
		)
	}

	opts.onPhase?.("copy", `copying admin DB → ${opts.adminOut}`)
	// The admin source is sealed 0444 (sealDatabase is every builder's last step), and copyFileSync
	// stamps the source mode onto a fresh copy — or writes THROUGH an existing destination keeping
	// ITS mode. Remove any stale copy, then restore the write bit: the copy is fold staging, not the
	// sealed artifact (2026-08-04: first candidate build against a sealed admin died on this).
	rmSync(opts.adminOut, { force: true })
	copyFileSync(opts.adminIn, opts.adminOut)
	chmodSync(opts.adminOut, 0o644)

	const db = new DatabaseSync(opts.adminOut)

	// #1026 + #1514: the purge clears the A-class country/region nodes and the locality ancestry too, so a fold that
	// does not pass adminForCountries un-parents the 95 zero-coverage locales' localities. Default it to the same
	// gap set `buildAdmin` uses, scoped to this run — the caller opts OUT by passing an explicit set.
	const adminForCountries =
		opts.adminForCountries ?? new Set(geonamesAdminGapCountries().filter((cc) => requested.has(cc)))

	const ingested = await ingestGeonamesAliases(db, countries, opts.geonamesDir ?? geonamesDir(), opts.onCountry, {
		adminForCountries,
		alternateDir: opts.alternateDir ?? geonamesAlternateDir(),
	})

	opts.onPhase?.("place_search", "rebuilding place_search + place_bbox from the updated names")
	const res = buildPlaceSearchFTS(db, { drop: true, onProgress: (phase, detail) => opts.onPhase?.(phase, detail) })
	db.exec("ANALYZE")
	db.close()

	return { ingested, placeSearchRows: res.indexedRows, bboxRows: res.bboxIndexedRows, refoldedCountries }
}

export interface BuildOptions {
	/**
	 * Admin DB to build the candidate from (the folded one for the durable recipe).
	 */
	adminDb: string
	/**
	 * Candidate-DB output path.
	 */
	out: string
	/**
	 * Absolute postcode-shard paths to fold in (default {@link resolvePostcodeShards}).
	 */
	postcodeShards?: readonly string[]
	onProgress?: (phase: string, message: string) => void
}

/**
 * Build the byte-range candidate gazetteer from an admin DB + postcode shards. The FTS5-trigram fuzzy index is baked in
 * by `buildCandidateTable`; the coverage manifest (survey candidate #2 — the artifact's own hard-filter coverage record
 * + guard-B bboxes, see `coverage-manifest.ts`) is baked in before the seal.
 */
export async function buildCandidate(opts: BuildOptions): Promise<BuildCandidateResult> {
	const { buildCandidateTable } = await import("@mailwoman/resolver-wof-sqlite/build-candidate")

	const result = await buildCandidateTable({
		input: opts.adminDb,
		output: opts.out,
		postcodes: [...(opts.postcodeShards ?? resolvePostcodeShards())],
		onProgress: opts.onProgress,
	})

	// Coverage manifest (survey candidate #2): facts about the artifact live IN the artifact — bake the
	// measured hard-filter coverage record + guard-B bboxes so consumers read them at open instead of
	// falling back to the code constants. MUST run pre-seal (a shipped DB is never patched — rebuild).
	opts.onProgress?.("coverage-manifest", "baking country coverage + bbox manifest")
	await emitCoverageManifest({ dbPath: opts.out })
	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	sealDatabase(opts.out)

	return result
}

/**
 * Point the drop-in convention path `<data-root>/wof/candidate.db` at `candidateDb` (a symlink — a POINTER swap, never
 * a DB mutation). The nominatim/photon CLIs auto-use this path. Returns the link.
 */
export function promoteCandidate(candidateDb: string, dataRoot: string = mailwomanDataRoot()): string {
	if (!existsSync(candidateDb)) throw new Error(`candidate DB not found: ${candidateDb}`)
	const linkPath = join(wofDir(dataRoot), "candidate.db")

	// Replace any existing pointer (symlink or stray file) — never the build it points at.
	try {
		if (lstatSync(linkPath)) {
			rmSync(linkPath)
		}
	} catch {
		// nothing there yet
	}

	symlinkSync(candidateDb, linkPath)

	return linkPath
}

export interface PublishOptions {
	/**
	 * Candidate DB to publish.
	 */
	candidateDb: string
	/**
	 * Dated, immutable gazetteer version, e.g. `2026-06-27a` (see {@link defaultGazetteerVersion}).
	 */
	version: string
	/**
	 * Path to `scripts/publish-demo-assets-to-r2.py`.
	 */
	uploadScript: string
	/**
	 * A staging dir; the candidate is symlinked under `<stageDir>/gazetteer/<version>/candidate.db`.
	 */
	stageDir: string
	/**
	 * `docs/src/shared/resources.tsx` to bump `ADMIN_GAZETTEER_VERSION`; omit to skip the demo bump.
	 */
	resourcesFile?: string
	bucket?: string
	prefix?: string
	dryRun?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

export interface PublishResult {
	/**
	 * The R2 object key.
	 */
	key: string
	/**
	 * Whether `ADMIN_GAZETTEER_VERSION` was bumped in the resources file.
	 */
	bumped: boolean
}

/**
 * Publish the candidate gazetteer to R2 (the demo's byte-range source) and bump the demo's `ADMIN_GAZETTEER_VERSION`.
 * Shells out to the proven `publish-demo-assets-to-r2.py` (boto3 + R2 cache-control); RCLONE_S3_PUBLIC_* creds must be
 * in the process env (source `.env` first).
 */
export function publishGazetteer(opts: PublishOptions): PublishResult {
	if (!existsSync(opts.candidateDb)) throw new Error(`candidate DB not found: ${opts.candidateDb}`)

	if (!existsSync(opts.uploadScript)) throw new Error(`upload script not found: ${opts.uploadScript}`)

	const prefix = opts.prefix ?? "mailwoman"
	const versionDir = join(opts.stageDir, "gazetteer", opts.version)
	mkdirSync(versionDir, { recursive: true })
	const staged = join(versionDir, "candidate.db")

	try {
		rmSync(staged)
	} catch {
		// fresh
	}

	symlinkSync(opts.candidateDb, staged)

	const key = `${prefix}/gazetteer/${opts.version}/candidate.db`
	opts.onPhase?.("upload", `R2 ${key}${opts.dryRun ? " (dry-run)" : ""}`)
	const args = [opts.uploadScript, "--src", opts.stageDir, "--prefix", prefix]

	if (opts.bucket) {
		args.push("--bucket", opts.bucket)
	}

	if (opts.dryRun) {
		args.push("--dry-run")
	}

	execFileSync("python3", args, { stdio: "inherit" })

	let bumped = false

	if (opts.resourcesFile && !opts.dryRun && existsSync(opts.resourcesFile)) {
		opts.onPhase?.("demo", `ADMIN_GAZETTEER_VERSION → ${opts.version}`)
		const src = readFileSync(opts.resourcesFile, "utf8")
		const next = src.replace(/(ADMIN_GAZETTEER_VERSION = ")[^"]+(")/, `$1${opts.version}$2`)

		if (next !== src) {
			writeFileSync(opts.resourcesFile, next)
			bumped = true
		}
	}

	return { key, bumped }
}

/**
 * A dated, immutable gazetteer version: `YYYY-MM-DD` + a lowercase suffix letter, e.g. `2026-06-27a`. Pass a `Date`
 * (the CLI does; the module never reads the clock implicitly).
 */
export function defaultGazetteerVersion(now: Date, suffix = "a"): string {
	const y = now.getUTCFullYear()
	const m = String(now.getUTCMonth() + 1).padStart(2, "0")
	const d = String(now.getUTCDate()).padStart(2, "0")

	return `${y}-${m}-${d}${suffix}`
}

export * from "./coverage-manifest.ts"
export * from "./defaults.ts"
export * from "./fts.ts"
export * from "./verify.ts"
export * from "./admin/index.ts"
export * from "./postcode/index.ts"
