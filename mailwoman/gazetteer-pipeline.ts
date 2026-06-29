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
 *   `buildPlaceSearchFts`, `buildCandidateTable`) so the CLI, the standalone scripts, and a future
 *   `build-unified-wof --geonames-countries` all share ONE implementation. `publish` shells out to
 *   the proven `scripts/publish-demo-assets-to-r2.py` (boto3 + the R2 cache-control gotchas) and
 *   bumps the demo's `ADMIN_GAZETTEER_VERSION` — the only repo-coupled step, so its repo paths are
 *   passed in.
 */

import { execFileSync } from "node:child_process"
import {
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

// resolver-wof-sqlite is an OPTIONAL peer dep of mailwoman (geocoding is opt-in) — import it
// DYNAMICALLY inside the functions (the geocode.tsx convention), NOT at module load, so that merely
// loading these commands (e.g. `mailwoman --help`, which eagerly imports every command) doesn't fault
// when the peer isn't installed. Types are erased, so type-only imports are safe at module level.
import type { GeonamesIngestProgress } from "@mailwoman/resolver-wof-sqlite"
import type { BuildCandidateResult } from "@mailwoman/resolver-wof-sqlite/build-candidate"

import { mailwomanDataRoot } from "./resolver-backend.js"

/**
 * The bilingual / alt-name EU set the GeoNames fold lifts (FI hard-resolve 69.5 → 85.8 %). GeoNames `<CC>.txt` dumps
 * from download.geonames.org/export/dump must be present under the geonames dir.
 */
export const DEFAULT_FOLD_COUNTRIES = [
	"FI",
	"PL",
	"NO",
	"CZ",
	"AT",
	"LT",
	"LV",
	"SI",
	"SK",
	"HR",
	"DK",
	"BE",
	"CH",
	"LU",
]

/**
 * The canonical postcode-shard set (filenames under `<data-root>/wof/`) that reproduces the shipped gazetteer's ~1.79 M
 * postcode coverage: US + the WOF intl shard (NL/FR/DE/ES/IT) + the GeoNames intl shard (PT/AU) + Overture postcode
 * centroids (CA + the EU-coverage locales). GB (2.6 M) and JP are left out for size. Missing shards are skipped, not
 * fatal.
 */
export const DEFAULT_POSTCODE_SHARDS = [
	"postalcode-us.db",
	"postalcode-intl.db",
	"postalcode-geonames-intl.db",
	"postcode-ca-overture.db",
	...["at", "be", "ch", "cz", "dk", "es", "fi", "hr", "lt", "lu", "lv", "no", "pl", "pt", "si", "sk"].map(
		(cc) => `postcode-${cc}-overture.db`
	),
]

/** The conventional admin source the fold copies from. */
export const DEFAULT_ADMIN_DB = "admin-global-priority.db"
/** The conventional candidate-build output. */
export const DEFAULT_CANDIDATE_OUT = "candidate-global.db"

/**
 * `<data-root>/wof`, where the admin DB, candidate DB, postcode shards, and the convention symlink live.
 */
export function wofDir(dataRoot: string = mailwomanDataRoot()): string {
	return join(dataRoot, "wof")
}

/** `<data-root>/geonames`, the per-country GeoNames dump dir. */
export function geonamesDir(dataRoot: string = mailwomanDataRoot()): string {
	return join(dataRoot, "geonames")
}

/** Resolve the canonical postcode-shard filenames to absolute paths, keeping only those present. */
export function resolvePostcodeShards(
	shards: readonly string[] = DEFAULT_POSTCODE_SHARDS,
	dataRoot: string = mailwomanDataRoot()
): string[] {
	return shards.map((s) => join(wofDir(dataRoot), s)).filter((p) => existsSync(p))
}

export interface FoldOptions {
	/** Source admin (unified-WOF) DB — read via the copy, never mutated. */
	adminIn: string
	/** Destination admin DB carrying the folded GeoNames names. MUST differ from `adminIn`. */
	adminOut: string
	/** ISO 3166-1 alpha-2 codes whose GeoNames dumps to fold (default {@link DEFAULT_FOLD_COUNTRIES}). */
	countries?: readonly string[]
	/** Dir holding `<CC>.txt` GeoNames dumps (default {@link DEFAULT_FOLD_COUNTRIES}). */
	geonamesDir?: string
	/**
	 * #267: the countries to ALSO fold A-class admin (PCLI + ADM1) for, linking the locality→region→country ancestry.
	 * ZERO-COVERAGE gap countries only (the coverage-expansion targets) — a country that already has WOF admin would
	 * double up, so the EU alias set is left off. Without it the gap localities are orphans and "Tbilisi, GE" can't
	 * resolve.
	 */
	adminForCountries?: ReadonlySet<string>
	onCountry?: (event: GeonamesIngestProgress) => void
	onPhase?: (phase: string, detail?: string) => void
}

export interface FoldResult {
	ingested: number
	placeSearchRows: number
	bboxRows: number
}

/**
 * Durable GeoNames upstream fold: copy the admin DB, fold the GeoNames places + Latin alt-names into its canonical
 * `spr`/`names`/`place_population`, then rebuild `place_search`/`place_bbox` so the candidate build carries them.
 * Build-on-copy — `adminIn` is never touched.
 */
export async function foldGeonamesIntoAdmin(opts: FoldOptions): Promise<FoldResult> {
	if (opts.adminIn === opts.adminOut) {
		throw new Error("fold must write a distinct adminOut (build-on-copy, never in place)")
	}

	if (!existsSync(opts.adminIn)) throw new Error(`admin DB not found: ${opts.adminIn}`)

	const { ingestGeonamesAliases, buildPlaceSearchFts } = await import("@mailwoman/resolver-wof-sqlite")

	opts.onPhase?.("copy", `copying admin DB → ${opts.adminOut}`)
	copyFileSync(opts.adminIn, opts.adminOut)

	const db = new DatabaseSync(opts.adminOut)
	const ingested = ingestGeonamesAliases(
		db,
		[...(opts.countries ?? DEFAULT_FOLD_COUNTRIES)],
		opts.geonamesDir ?? geonamesDir(),
		opts.onCountry,
		opts.adminForCountries ? { adminForCountries: opts.adminForCountries } : undefined
	)
	opts.onPhase?.("place_search", "rebuilding place_search + place_bbox from the updated names")
	const res = buildPlaceSearchFts(db, { drop: true, onProgress: (phase, detail) => opts.onPhase?.(phase, detail) })
	db.exec("ANALYZE")
	db.close()

	return { ingested, placeSearchRows: res.indexedRows, bboxRows: res.bboxIndexedRows }
}

export interface BuildOptions {
	/** Admin DB to build the candidate from (the folded one for the durable recipe). */
	adminDb: string
	/** Candidate-DB output path. */
	out: string
	/** Absolute postcode-shard paths to fold in (default {@link resolvePostcodeShards}). */
	postcodeShards?: readonly string[]
	onProgress?: (phase: string, message: string) => void
}

/**
 * Build the byte-range candidate gazetteer from an admin DB + postcode shards. The FTS5-trigram fuzzy index is baked in
 * by `buildCandidateTable`. Pure pass-through to the canonical builder.
 */
export async function buildCandidate(opts: BuildOptions): Promise<BuildCandidateResult> {
	const { buildCandidateTable } = await import("@mailwoman/resolver-wof-sqlite/build-candidate")

	return buildCandidateTable({
		input: opts.adminDb,
		output: opts.out,
		postcodes: [...(opts.postcodeShards ?? resolvePostcodeShards())],
		onProgress: opts.onProgress,
	})
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
		if (lstatSync(linkPath)) rmSync(linkPath)
	} catch {
		// nothing there yet
	}
	symlinkSync(candidateDb, linkPath)

	return linkPath
}

export interface PublishOptions {
	/** Candidate DB to publish. */
	candidateDb: string
	/** Dated, immutable gazetteer version, e.g. `2026-06-27a` (see {@link defaultGazetteerVersion}). */
	version: string
	/** Path to `scripts/publish-demo-assets-to-r2.py`. */
	uploadScript: string
	/** A staging dir; the candidate is symlinked under `<stageDir>/gazetteer/<version>/candidate.db`. */
	stageDir: string
	/** `docs/src/shared/resources.tsx` to bump `ADMIN_GAZETTEER_VERSION`; omit to skip the demo bump. */
	resourcesFile?: string
	bucket?: string
	prefix?: string
	dryRun?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

export interface PublishResult {
	/** The R2 object key. */
	key: string
	/** Whether `ADMIN_GAZETTEER_VERSION` was bumped in the resources file. */
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

	if (opts.bucket) args.push("--bucket", opts.bucket)

	if (opts.dryRun) args.push("--dry-run")
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
