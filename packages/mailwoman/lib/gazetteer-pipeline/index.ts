/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate-gazetteer build → promote → publish pipeline, as reusable functions the `mailwoman
 *   gazetteer` commands compose. This is the codified version of the 2026-06-27 manual rebuild
 *   (releasing.md Step 5): the durable GeoNames-alias upstream fold, the candidate build with the
 *   FTS5-trigram fuzzy index baked in, the local convention-path promotion, and the R2 + demo
 *   publish — every decision that needed a question last time is a default here.
 *
 *   `fold` and `build` reuse the canonical package functions (`ingestGeonamesAliases`,
 *   `buildPlaceSearchFTS`, `buildCandidateTable`) so the CLI, the standalone scripts, and a future
 *   `build-unified-wof --geonames-countries` all share one implementation. `publish` shells out to
 *   the proven `docs/scripts/publish-demo-assets-to-r2.py` (boto3 + the R2 cache-control gotchas) and
 *   bumps the demo's `ADMIN_GAZETTEER_VERSION` — the only repo-coupled step, so its repo paths are
 *   passed in.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile, readLocalTextFile, statLink } from "@mailwoman/core/fs/readers"
import {
	changeMode,
	copyFileTo,
	createSymbolicLink,
	makeDirectories,
	removePath,
	removePathIfPresent,
	writeLocalFile,
} from "@mailwoman/core/fs/writers"
import { repoRootPath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { runFileSync } from "@mailwoman/core/process"
import { GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { isoDate } from "@mailwoman/core/utils"
// resolver-wof-sqlite's runtime modules are imported inside the functions that use them.
// `mailwoman --help` imports every command, and a module-level value import would
// evaluate the resolver's module graph on that path.
// Type-only imports are erased, and `@mailwoman/resolver-wof-sqlite/paths`
// imports only core's path builders.
import type { GeonamesIngestProgress } from "@mailwoman/resolver-wof-sqlite"
import type { BuildCandidateResult } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import type { CapitalPoint } from "@mailwoman/resolver-wof-sqlite/capitals"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"

import { candidateLayerManifest } from "#gazetteer-pipeline/candidate-manifest"
import { emitCoverageManifest } from "#gazetteer-pipeline/coverage-manifest"
import {
	DEFAULT_FOLD_COUNTRIES,
	DEFAULT_IMPORTANCE_DB,
	DEFAULT_WOF_PRIORITY_COUNTRIES,
	geonamesAdminGapCountries,
} from "#gazetteer-pipeline/defaults"
import { buildSHA, stampLayerManifest } from "#gazetteer-pipeline/stamp-manifest"

/**
 * The canonical postcode-database set (filenames under `<data-root>/db/wof/`):
 * US + the WOF intl database (NL/FR/DE/ES/IT)
 *
 * - The GeoNames intl database (PT/AU) + the OS Code-Point Open GB database + the OSM
 *   Northern Ireland database + the GeoNames-postal tail database (nine countries) +
 *   Overture postcode centroids (CA + the EU-coverage locales).
 *   Missing databases are skipped rather than fatal.
 *
 * That skip is not merely tolerant.
 * It is the **build-local tier's mechanism**.
 *
 * `postalcode-ni-osm.db` is ODbL and is never published, so on every machine but the one
 * that built it the `pathExists` filter in {@link resolvePostcodeDatabases} removes it
 * and the set degrades to the permissive databases alone.
 * Nothing else enforces the tier, and nothing else needs to.
 *
 * What is left out: the WOF **`postalcode-gb.db`** (2,719,772 rows, 694 MB —
 * superseded by Code-Point Open, the same underlying survey under a clean licence).
 *
 * Every member is spelled `postalcode-`, and that is a routing interface rather than a house style.
 * `deriveSchemaName` (`resolver-wof-sqlite/extracts.ts`) turns the filename into
 * the attached SQL schema name, and `pickExtractsForPlacetype` selects by testing
 * that name against the placetype, which is `postalcode`.
 *
 * A database added here as `postcode-<cc>.db` builds the candidate table
 * fine (the builders read `spr` directly) and is then unreachable to any
 * `findPlace({ placetype: "postalcode" })`, returning zero hits rather than an error.
 * The `postcode-locality-<cc>.db` family is the deliberate exception and is not a
 * member of this list: those hold a `postcode_locality` relation table and no `spr`,
 * so they are never routed as place databases at all.
 */
export const DEFAULT_POSTCODE_DATABASES = [
	"postalcode-us.db",
	"postalcode-intl.db",
	"postalcode-geonames-intl.db",
	// GB via OS Code-Point Open under OGL v3 (operator licence ruling 2026-08-05):
	// 1,746,976 unit postcodes, England+Scotland+Wales — no Northern Ireland
	// (excluded from every permissive UK grant. See the codepoint builder's NI note).
	// Replaces the GeoNames GB rows, which the 2026-08-05 parity check measured as the same
	// survey (max coordinate delta 6.6 m over 1.75M joined rows) under a muddled licence.
	// Rebuild: `mailwoman gazetteer build postcode-codepoint`.
	"postalcode-gb-codepoint.db",
	// Northern Ireland (BT), the hole Code-Point Open leaves — 4,757 of 50,032 live NI postcodes (9.5 %),
	// 250/886 sectors, 80/80 districts, from OpenStreetMap `addr:postcode` (2026-08-05 extract).
	// A miss on a BT code means not attested IN OSM rather than that the code does not exist.
	// Since #1480 an unknown postcode abstains, so the partial database is strictly additive.
	//
	// build-local tier — ODbL 1.0 is share-alike on a Derived Database, so this
	// artifact is never published to npm, R2 or the demo.
	// It is present only on a machine that built it, and the `pathExists` filter in
	// `resolvePostcodeDatabases` is that tier's mechanism: a deployment without the
	// file simply has no NI coverage, exactly as before.
	// Rebuild: `mailwoman gazetteer build postcode-ni-osm` (add `--offline` to rebuild from
	// the saved Overpass response rather than re-querying a volunteer endpoint).
	"postalcode-ni-osm.db",
	// Japan's 7-digit codes from WOF (142,604 rows. 48,216 carry the 0,0 unlocated sentinel,
	// which the candidate fold skips by construction).
	// The located 94,388 answer a 町域 centroid: on 637 postcode-containing JP board
	// rows the centroid sits 0.52 km (p50) / 2.31 km (p90) from the entrance point,
	// against the 15–19 km municipality centroid the admin walk otherwise reaches.
	// Every located row passes @15 km and 36 of 2,000 that failed on the municipality pass on the code.
	// The fold arrives with the next candidate rebuild.
	"postalcode-jp.db",
	// #920: the GeoNames-postal tail database. TEN countries in ingest order FI/CZ/SK/SI/DK/no/HR/PL/SE/be (57,221 rows. Belgium joined 2026-08-12 with 1,146 codes after the Overture Belgium parquet measured too thin — 203 codes, none of the eu-mixed panel's). GB rode in this database 2026-07-03 → 2026-08-05 and moved to Code-Point Open above. The swap is parity-conditional: the nine prior countries re-joined byte-identical (56,075 rows, worst coordinate delta 0). Rebuild: `mailwoman gazetteer build postcode-geonames --countries FI,CZ,SK,SI,DK,no,HR,PL,SE,be`.
	"postalcode-geonames-tail.db",
	"postalcode-ca-overture.db",
	...["at", "be", "ch", "cz", "dk", "es", "fi", "hr", "lt", "lu", "lv", "no", "pl", "pt", "si", "sk"].map(
		(cc) => `postalcode-${cc}-overture.db`
	),
	// Singapore: a six-digit postcode names one building, so the per-postcode centroid of the Overture
	// rows (123,883 codes from the OneMap / Singapore Land Authority register, Singapore Open Data
	// Licence 1.0 under Overture's cdla-Permissive-2.0) answers at rooftop grade with no training.
	// Rebuild: `mailwoman eval es-postcode-centroids --country SG --pc-len 0 --parquet <overture>/addresses-sg.parquet`.
	"postalcode-sg-overture.db",
]

/**
 * `<data-root>/geonames`, the per-country GeoNames dump dir.
 */
export function geonamesDir(dataRoot: PathBuilderLike = dataRootPath()): string {
	return resolvePath(dataRoot, "geonames")
}

/**
 * `<data-root>/geonames-alternate`, the per-country alternateNamesV2 dump dir (#936 language tags).
 */
export function geonamesAlternateDir(dataRoot: PathBuilderLike = dataRootPath()): string {
	return resolvePath(dataRoot, "geonames-alternate")
}

/**
 * Resolve the canonical postcode-database filenames to absolute paths, keeping only those present.
 */
export async function resolvePostcodeDatabases(
	databases: readonly string[] = DEFAULT_POSTCODE_DATABASES,
	dataRoot: PathBuilderLike = dataRootPath()
): Promise<string[]> {
	const paths: string[] = []

	for (const database of databases) {
		const path = wofDatabaseRoot(dataRoot)(database)

		if (await pathExists(path)) {
			paths.push(path.toString())
		}
	}

	return paths
}

/**
 * Locality databases folded into the candidate build by default, existence-filtered like the
 * postcode set — today the linz-derived NZ suburb database (#1564; `gazetteer build nz-localities`).
 *
 * A machine without the database builds without it, and the artifact's NZ locality
 * namespace stays exactly as thin as the sources that fed it.
 */
export const DEFAULT_LOCALITY_DATABASES: readonly string[] = [
	"localities-nz-linz.db",
	// The Prague municipal districts (`Praha 9` — the #42 pair rung's missing locality
	// half. 22 rows from GeoNames CZ, `gazetteer build cz-districts`).
	// Verified 2026-08-12: the Chabeřická panel row moved from a 6,733 km US answer to CZ at ~400 m.
	"localities-cz-districts.db",
	// Taiwan's 鄉鎮市區 from the civil-affairs address register (`gazetteer build tw-districts`),
	// each row carrying its 縣市's WOF region as an `ancestors` row so the fold stamps the region scope.
	// The admin artifact's own copies of the tier are unusable for a Han query:
	// the Han-keyed record has no parent, the parented one no Han name.
	"localities-tw-districts.db",
]

/**
 * Resolve the conventional locality databases present on this machine.
 */
export async function resolveLocalityDatabases(
	databases: readonly string[] = DEFAULT_LOCALITY_DATABASES,
	dataRoot: PathBuilderLike = dataRootPath()
): Promise<string[]> {
	const paths: string[] = []

	for (const database of databases) {
		const path = wofDatabaseRoot(dataRoot)(database)

		if (await pathExists(path)) {
			paths.push(path.toString())
		}
	}

	return paths
}

/**
 * Resolve the conventional score source, or `undefined` when this machine has none.
 *
 * Same tolerate-and-degrade shape as {@link resolvePostcodeDatabases}, and the same reason:
 * the scores are a build-local artifact on the machine that derived them, and a deployment
 * without the file must build a candidate DB with an empty `importance` column rather than fail.
 * Absent is unmeasured, which is what the consumer already handles.
 */
export async function resolveImportanceDB(
	filename: string = DEFAULT_IMPORTANCE_DB,
	dataRoot: PathBuilderLike = dataRootPath()
): Promise<string | undefined> {
	const path = wofDatabaseRoot(dataRoot)(filename)

	return (await pathExists(path)) ? path.toString() : undefined
}

export interface FoldOptions {
	/**
	 * Source admin (unified-WOF) DB.
	 * Read via the copy, never mutated.
	 */
	adminIn: PathBuilderLike
	/**
	 * Destination admin DB carrying the folded GeoNames names.
	 *
	 * Must differ from `adminIn`.
	 */
	adminOut: PathBuilderLike
	/**
	 * ISO 3166-1 alpha-2 codes whose GeoNames dumps to fold (default {@link DEFAULT_FOLD_COUNTRIES}).
	 */
	countries?: readonly string[]
	/**
	 * Dir holding `<CC>.txt` GeoNames dumps (default {@link geonamesDir}).
	 */
	geonamesDir?: PathBuilderLike
	/**
	 * #267: the countries to also fold A-class admin (pcli + ADM1) for, linking the locality→region→country ancestry.
	 * Zero-coverage gap countries only (the coverage-expansion targets).
	 *
	 * A country that already has WOF admin would double up, so the EU alias set is left off.
	 *
	 * Without it the gap localities are orphans and "Tbilisi, GE" can't resolve.
	 */
	adminForCountries?: ReadonlySet<string>
	/**
	 * #936: dir holding `<CC>.txt` alternateNamesV2 dumps (default {@link geonamesAlternateDir}) — tags alias rows with
	 * language / privateuse / `official`.
	 *
	 * Countries without a file fold untagged, exactly as before.
	 */
	alternateDir?: PathBuilderLike
	/**
	 * #1514 override: proceed even when `adminIn` already carries alias rows for countries this run does not list. The
	 * fold owns its whole id range and rewrites it wholesale, so those countries are dropped.
	 *
	 * Only pass this when shrinking the fold is the point.
	 */
	allowCoverageLoss?: boolean
	onCountry?: (event: GeonamesIngestProgress) => void
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * How many of the dropped country codes the coverage-loss error names before eliding.
 *
 * The realistic miss is the whole fold minus a handful (161 → 14 in the #1514 incident),
 * so the list is there to make the shape of the mistake obvious rather than to enumerate it.
 * A dozen codes plus the count does that on one terminal line.
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
 * Durable GeoNames upstream fold: copy the admin DB, fold the GeoNames places +
 * Latin alt-names into its canonical `spr`/`names`/`place_population`, then rebuild
 * `place_search`/`place_bbox` so the candidate build carries them.
 *
 * Build-on-copy — `adminIn` is never touched.
 *
 * #1514: the fold owns the id range `[9e12, 9.5e12)` and rewrites it wholesale. The synthetic id is a position in the
 * run, so a partial rewrite binds one run's names to another run's places.
 * Folding a country set narrower than what `adminIn` already carries therefore drops the
 * difference, and since `buildAdmin` bakes the full `DEFAULT_GEONAMES_COUNTRIES` fold into
 * every admin artifact it builds, that is the normal case here rather than an exotic one.
 *
 * The pre-flight below refuses it unless {@link FoldOptions.allowCoverageLoss} says otherwise.
 */
export async function foldGeonamesIntoAdmin(opts: FoldOptions): Promise<FoldResult> {
	if (opts.adminIn.toString() === opts.adminOut.toString()) {
		throw new Error("fold must write a distinct adminOut (build-on-copy, never in place)")
	}

	if (!(await pathExists(opts.adminIn))) throw new Error(`admin DB not found: ${opts.adminIn}`)

	const { ingestGeonamesAliases, buildPlaceSearchFTS } = await import("@mailwoman/resolver-wof-sqlite")

	const countries = [...(opts.countries ?? DEFAULT_FOLD_COUNTRIES)]

	// Pre-flight on the source, before the copy: what does it already carry in the fold's range?
	opts.onPhase?.("preflight", "reading the source's existing alias-fold coverage")
	using source = new DatabaseClient<WOFDatabase>(opts.adminIn, { readOnly: true })

	const refoldedCountries = (
		source
			.prepare(`SELECT DISTINCT country FROM spr WHERE id >= ? AND id < ? ORDER BY country`)
			.all(GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE) as Array<{ country: string }>
	)

		.map((r) => r.country)

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
	// The admin source is sealed 0444 (sealDatabase is every builder's last step), and copyFileTo stamps
	// the source mode onto a fresh copy, or writes through an existing destination keeping its mode.
	// Remove any stale copy, then restore the write bit: the copy is fold staging rather than the
	// sealed artifact (2026-08-04: first candidate build against a sealed admin died on this).
	await removePathIfPresent(opts.adminOut)
	await copyFileTo(opts.adminIn, opts.adminOut)
	await changeMode(opts.adminOut, 0o644)

	using db = new DatabaseClient<WOFDatabase>(opts.adminOut)

	// #1026 + #1514: the purge clears the A-class country/region nodes and the locality ancestry too, so a fold that does not pass adminForCountries un-parents the 95 zero-coverage locales' localities. Default it to the same gap set `buildAdmin` uses, scoped to this run — the caller opts OUT by passing an explicit set.
	const adminForCountries =
		opts.adminForCountries ?? new Set(geonamesAdminGapCountries().filter((cc) => requested.has(cc)))

	const ingested = await ingestGeonamesAliases(db, countries, opts.geonamesDir ?? geonamesDir(), opts.onCountry, {
		adminForCountries,
		alternateDir: opts.alternateDir ?? geonamesAlternateDir(),
	})

	opts.onPhase?.("place_search", "rebuilding place_search + place_bbox from the updated names")
	const res = buildPlaceSearchFTS(db, { drop: true, onProgress: (phase, detail) => opts.onPhase?.(phase, detail) })
	db.exec("ANALYZE")

	return { ingested, placeSearchRows: res.indexedRows, bboxRows: res.bboxIndexedRows, refoldedCountries }
}

export interface BuildOptions {
	/**
	 * Admin DB to build the candidate from (the folded one for the durable recipe).
	 */
	adminDB: PathBuilderLike
	/**
	 * Candidate-DB output path.
	 */
	out: PathBuilderLike
	/**
	 * Absolute postcode-database paths to fold in (default {@link resolvePostcodeDatabases}).
	 */
	postcodeDatabases?: readonly string[]
	/**
	 * Absolute locality-database paths to fold in (default {@link resolveLocalityDatabases} —
	 * today the linz-derived NZ suburb database, when the machine holds it).
	 *
	 * Same tolerate-and-degrade shape as the postcode databases.
	 */
	localityDatabases?: readonly string[]
	/**
	 * Score source for the `importance` column (default {@link resolveImportanceDB}).
	 *
	 * Pass `false` to build the column empty on purpose.
	 */
	importanceDB?: string | false
	/**
	 * Countries judged by the cross-source currency backfill (#1737 — deprecated-with-no-successor
	 * WOF localities resurrected only under a GeoNames attestation. See `resurrectCurrencyHoles`).
	 *
	 * Default: the WOF-priority set.
	 * The only countries whose admin comes from WOF repos, so the only ones that can carry this hole class.
	 *
	 * Countries without a `<data-root>/geonames/<CC>.txt` dump are skipped loudly by the pass.
	 *
	 * Pass `false` to disable.
	 */
	currencyBackfillCountries?: readonly string[] | false
	onProgress?: (phase: string, message: string) => void
}

/**
 * Build the byte-range candidate gazetteer from an admin DB + postcode databases.
 *
 * The FTS5-trigram fuzzy index is baked in by `buildCandidateTable`; the coverage manifest
 * (survey candidate #2 — the artifact's own hard-filter coverage record + guard-B bboxes,
 * see `coverage-manifest.ts`) is baked in before the seal.
 */
export async function buildCandidate(opts: BuildOptions): Promise<BuildCandidateResult> {
	const { buildCandidateTable } = await import("@mailwoman/resolver-wof-sqlite/build-candidate")

	// `undefined` means "use the convention"; `false` means "the caller chose an empty column".
	// Only the second may skip the resolve — collapsing them would make a missing artifact
	// indistinguishable from a deliberate opt-out in the build log.
	const importance = opts.importanceDB === false ? undefined : (opts.importanceDB ?? (await resolveImportanceDB()))

	const backfillCountries =
		opts.currencyBackfillCountries === false
			? undefined
			: (opts.currencyBackfillCountries ?? DEFAULT_WOF_PRIORITY_COUNTRIES)

	// #1880's distribution home: carry the committed capitals reference in-artifact so `capital_tier` works for npm consumers who pulled candidate.db (published packages do not ship the repo file). A dev checkout that predates the reference simply builds without the table — the session loader says which source it used.
	const capitalsPath = repoRootPathBuilder("data", "gazetteer", "capitals-v1.json")

	const capitals = (await pathExists(capitalsPath))
		? (await readLocalJSONFile<{ entries?: CapitalPoint[] }>(capitalsPath)).entries
		: undefined

	const result = await buildCandidateTable({
		input: opts.adminDB,
		output: opts.out,
		postcodes: [...(opts.postcodeDatabases ?? (await resolvePostcodeDatabases()))],
		localities: [...(opts.localityDatabases ?? (await resolveLocalityDatabases()))],
		...(importance ? { importance } : {}),
		...(backfillCountries ? { currencyBackfill: { geonamesDir: geonamesDir(), countries: backfillCountries } } : {}),
		...(capitals?.length ? { capitals } : {}),
		onProgress: opts.onProgress,
	})

	// Coverage manifest (survey candidate #2): facts about the artifact live IN the artifact —
	// bake the measured hard-filter coverage record + guard-B bboxes so consumers read
	// them at open instead of falling back to the code constants.
	// Must run pre-seal (a shipped DB is never patched — rebuild).
	opts.onProgress?.("coverage-manifest", "baking country coverage + bbox manifest")
	await emitCoverageManifest({ dbPath: opts.out })

	// The layer interface's manifest, alongside the coverage one and for the same reason:
	// facts about the artifact live IN the artifact.
	// It names its ancestor rather than restating the ancestor's sources.
	// See candidate-manifest.ts for why a derived layer's provenance has to be a chain.
	opts.onProgress?.("layer-manifest", "stamping provenance")
	const sha = buildSHA(repoRootPath())

	await stampLayerManifest(
		opts.out,
		await candidateLayerManifest({
			adminDBPath: opts.adminDB,
			databaseCounts: {
				postcodes: (opts.postcodeDatabases ?? (await resolvePostcodeDatabases())).length,
				localities: (opts.localityDatabases ?? (await resolveLocalityDatabases())).length,
			},
			importance: Boolean(importance),
			buildSHA: sha,
			version: isoDate(),
			createdAt: new Date().toISOString(),
		})
	)

	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	await sealDatabase(opts.out)

	return result
}

/**
 * Point the drop-in convention path `<data-root>/db/wof/candidate.db` at `candidateDB`
 * (a symlink — a pointer swap, never a DB mutation).
 *
 * The nominatim/photon CLIs auto-use this path.
 * Returns the link.
 */
export async function promoteCandidate(
	candidateDB: PathBuilderLike,
	dataRoot: PathBuilderLike = dataRootPath()
): Promise<string> {
	if (!(await pathExists(candidateDB))) throw new Error(`candidate DB not found: ${candidateDB}`)
	const linkPath = wofDatabaseRoot(dataRoot)("candidate.db")

	// Replace any existing pointer (symlink or stray file), never the build it points at.
	try {
		if (await statLink(linkPath)) {
			await removePath(linkPath)
		}
	} catch {
		// nothing there yet
	}

	await createSymbolicLink(candidateDB, linkPath)

	return linkPath.toString()
}

export interface PublishOptions {
	/**
	 * Candidate DB to publish.
	 */
	candidateDB: PathBuilderLike
	/**
	 * Dated, immutable gazetteer version, e.g. `2026-06-27a` (see {@link defaultGazetteerVersion}).
	 */
	version: string
	/**
	 * Path to `docs/scripts/publish-demo-assets-to-r2.py`.
	 */
	uploadScript: PathBuilderLike
	/**
	 * A staging dir.
	 *
	 * The candidate is symlinked under `<stageDir>/gazetteer/<version>/candidate.db`.
	 */
	stageDir: PathBuilderLike
	/**
	 * `packages/mailwoman/lib/browser-runtime/resources.ts` to bump `ADMIN_GAZETTEER_VERSION`;
	 * omit to skip the pin bump.
	 */
	resourcesFile?: PathBuilderLike
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
 * Publish the candidate gazetteer to R2 (the demo's byte-range source)
 * and bump the demo's `ADMIN_GAZETTEER_VERSION`.
 *
 * Shells out to the proven `publish-demo-assets-to-r2.py` (boto3 + R2 cache-control);
 * RCLONE_S3_PUBLIC_* creds must be in the process env (source `.env` first).
 */
export async function publishGazetteer(opts: PublishOptions): Promise<PublishResult> {
	if (!(await pathExists(opts.candidateDB))) throw new Error(`candidate DB not found: ${opts.candidateDB}`)

	if (!(await pathExists(opts.uploadScript))) throw new Error(`upload script not found: ${opts.uploadScript}`)

	const prefix = opts.prefix ?? "mailwoman"
	const versionDir = resolvePathBuilder(opts.stageDir, "gazetteer", opts.version)
	await makeDirectories(versionDir)
	const staged = versionDir("candidate.db")

	try {
		await removePath(staged)
	} catch {
		// fresh
	}

	await createSymbolicLink(opts.candidateDB, staged)

	const key = `${prefix}/gazetteer/${opts.version}/candidate.db`
	opts.onPhase?.("upload", `R2 ${key}${opts.dryRun ? " (dry-run)" : ""}`)
	const args: PathBuilderLike[] = [opts.uploadScript, "--src", resolvePath(opts.stageDir), "--prefix", prefix]

	if (opts.bucket) {
		args.push("--bucket", opts.bucket)
	}

	if (opts.dryRun) {
		args.push("--dry-run")
	}

	runFileSync("python3", args, { stdio: "inherit" })

	let bumped = false

	if (opts.resourcesFile && !opts.dryRun && (await pathExists(opts.resourcesFile))) {
		opts.onPhase?.("demo", `ADMIN_GAZETTEER_VERSION → ${opts.version}`)
		const src = await readLocalTextFile(opts.resourcesFile)
		const next = src.replace(/(ADMIN_GAZETTEER_VERSION = ")[^"]+(")/, `$1${opts.version}$2`)

		if (next !== src) {
			await writeLocalFile(next, opts.resourcesFile)
			bumped = true
		}
	}

	return { key, bumped }
}

/**
 * A dated, immutable gazetteer version: `yyyy-MM-DD` + a lowercase suffix letter, e.g. `2026-06-27a`.
 *
 * Pass a `Date` (the CLI does. The module never reads the clock implicitly).
 */
export function defaultGazetteerVersion(now: Date, suffix = "a"): string {
	const y = now.getUTCFullYear()
	const m = String(now.getUTCMonth() + 1).padStart(2, "0")
	const d = String(now.getUTCDate()).padStart(2, "0")

	return `${y}-${m}-${d}${suffix}`
}

export * from "#gazetteer-pipeline/coverage-manifest"
export * from "#gazetteer-pipeline/defaults"
export * from "#gazetteer-pipeline/fts"
export * from "#gazetteer-pipeline/verify/index"
export * from "#gazetteer-pipeline/admin/index"
export * from "#gazetteer-pipeline/postcode/index"
