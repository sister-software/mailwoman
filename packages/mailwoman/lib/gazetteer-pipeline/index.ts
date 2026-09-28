/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The candidate-gazetteer build → promote → publish pipeline, as reusable functions the `mailwoman
 * gazetteer` commands compose.
 *
 * `fold` and `build` reuse the canonical package functions so the CLI, the standalone scripts, and a
 * future `build-unified-wof --geonames-countries` all share one implementation. `publish` uses the
 * same TypeScript R2 publisher as the standalone release tool and bumps the demo's
 * `ADMIN_GAZETTEER_VERSION`; the demo resource file is the only repo-coupled path, so callers pass
 * it in.
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
import { refusalsForPublication } from "@mailwoman/core/layers"
import { repoRootPath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { CommandError } from "@mailwoman/core/scripting/command"
import { isoDate } from "@mailwoman/core/utils"
// resolver-wof-sqlite's runtime modules are imported inside the functions that use them,
// because `mailwoman --help` imports every command and a module-level value import
// would evaluate the resolver's module graph on that path.
import type { GeonamesIngestProgress } from "@mailwoman/resolver-wof-sqlite"
import type { BuildCandidateResult } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import type { CapitalPoint } from "@mailwoman/resolver-wof-sqlite/capitals"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"

import { probeManifest } from "#data/inventory"
import {
	candidateLayerManifest,
	type FoldTerms,
	foldsRefusingPublication,
	readFoldTerms,
} from "#gazetteer-pipeline/candidate-manifest"
import { emitCoverageManifest } from "#gazetteer-pipeline/coverage-manifest"
import {
	DEFAULT_FOLD_COUNTRIES,
	DEFAULT_IMPORTANCE_DB,
	DEFAULT_WOF_PRIORITY_COUNTRIES,
	geonamesAdminGapCountries,
} from "#gazetteer-pipeline/defaults"
import { buildSHA, stampLayerManifest } from "#gazetteer-pipeline/stamp-manifest"
import { publishDemoAssets } from "#release-tools/publish/demo-assets"

/**
 * The canonical postcode-database set (filenames under `<data-root>/db/wof/`);
 * missing databases are skipped rather than fatal.
 *
 * Every member is spelled `postalcode-` because that is a routing interface: `deriveSchemaName`
 * turns the filename into the attached SQL schema name and `pickExtractsForPlacetype`
 * tests it against the placetype, so a database named `postcode-<cc>.db` builds fine
 * and is then unreachable to `findPlace({ placetype: "postalcode" })`.
 * The `postcode-locality-<cc>.db` family holds a `postcode_locality` relation table
 * and no `spr`, so it is never routed as a place database.
 *
 * `postalcode-ni-osm.db` is ODbL and is never published, so on every machine but the one
 * that built it the `pathExists` filter in {@link resolvePostcodeDatabases} removes it.
 */
export const DEFAULT_POSTCODE_DATABASES = [
	"postalcode-us.db",
	"postalcode-intl.db",
	"postalcode-geonames-intl.db",
	// GB via OS Code-Point Open under OGL v3, covering England, Scotland and Wales only.
	// Northern Ireland is excluded from every permissive UK grant.
	"postalcode-gb-codepoint.db",
	// Northern Ireland (BT), the hole Code-Point Open leaves.
	// A miss on a BT code means not attested in OSM rather than that the code does not exist.
	// ODbL 1.0 is share-alike, so this artifact is never published and folds
	// only under `includeBuildLocalFolds`.
	"postalcode-ni-osm.db",
	// Japan's 7-digit codes from WOF. 48,216 carry the 0,0 unlocated sentinel,
	// which the candidate fold skips by construction.
	"postalcode-jp.db",
	// The GeoNames-postal tail database: ten countries in ingest order.
	"postalcode-geonames-tail.db",
	"postalcode-ca-overture.db",
	...["at", "be", "ch", "cz", "dk", "es", "fi", "hr", "lt", "lu", "lv", "no", "pl", "pt", "si", "sk"].map(
		(cc) => `postalcode-${cc}-overture.db`
	),
	// Singapore: a six-digit postcode names one building, so the per-postcode
	// Overture centroid answers at rooftop grade.
	"postalcode-sg-overture.db",
]

/**
 * `<data-root>/geonames`, the per-country GeoNames dump dir.
 */
export function geonamesDir(dataRoot: PathBuilderLike = dataRootPath()): string {
	return resolvePath(dataRoot, "geonames")
}

/**
 * `<data-root>/geonames-alternate`, the per-country alternateNamesV2 dump dir.
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
 * Locality databases folded into the candidate build by default, existence-filtered like the postcode set.
 * A machine without one builds without it.
 */
export const DEFAULT_LOCALITY_DATABASES: readonly string[] = [
	"localities-nz-linz.db",
	// The Prague municipal districts, the missing locality half of the CZ pair rung.
	"localities-cz-districts.db",
	// Taiwan's 鄉鎮市區 from the civil-affairs address register, each row carrying its 縣市's WOF
	// region as an `ancestors` row so the fold stamps the region scope. The admin artifact's own
	// copies of the tier are unusable for a Han query.
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
 * A deployment without the file must build a candidate DB with an empty
 * `importance` column rather than fail.
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
	 * The countries to also fold A-class admin (pcli + ADM1) for, linking the
	 * locality→region→country ancestry.
	 *
	 * Zero-coverage gap countries only, since a country that already has WOF admin would double up.
	 */
	adminForCountries?: ReadonlySet<string>
	/**
	 * Dir holding `<CC>.txt` alternateNamesV2 dumps (default {@link geonamesAlternateDir}),
	 * tagging alias rows with language / privateuse / `official`; countries without a file fold untagged.
	 */
	alternateDir?: PathBuilderLike
	/**
	 * Override to proceed even when `adminIn` already carries alias rows for countries this run does not list.
	 *
	 * The fold owns its whole id range and rewrites it wholesale, so those countries are dropped.
	 */
	allowCoverageLoss?: boolean
	onCountry?: (event: GeonamesIngestProgress) => void
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * How many dropped country codes the coverage-loss error names before eliding. a dozen
 * plus the count makes the shape of the mistake obvious on one terminal line.
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
 * Durable GeoNames upstream fold: copy the admin DB, fold the GeoNames places + Latin alt-names
 * into its canonical `spr`/`names`/`place_population`, then rebuild `place_search`/`place_bbox`.
 *
 * Build-on-copy — `adminIn` is never touched.
 * The fold owns the id range `[9e12, 9.5e12)` and rewrites it wholesale,
 * and the synthetic id is a position in the run, so folding a country set narrower
 * than what `adminIn` already carries drops the difference.
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
	// The admin source is sealed 0444 and `copyFileTo` stamps the source mode onto a fresh copy,
	// so remove any stale copy and restore the write bit: the writable copy is fold staging.
	// The sealed artifact keeps its 0444 mode.
	await removePathIfPresent(opts.adminOut)
	await copyFileTo(opts.adminIn, opts.adminOut)
	await changeMode(opts.adminOut, 0o644)

	using db = new DatabaseClient<WOFDatabase>(opts.adminOut)

	// The purge clears the A-class country/region nodes and the locality ancestry too,
	// so a fold that omits adminForCountries un-parents the zero-coverage localities.
	// Default to the gap set scoped to this run, and the caller opts out by passing an explicit set.
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
	 * Countries judged by the cross-source currency backfill
	 * (WOF localities resurrected only under a GeoNames attestation); default is
	 * the WOF-priority set, the only countries whose admin comes from WOF repos,
	 * and a country without a `<data-root>/geonames/<CC>.txt` dump is skipped loudly.
	 *
	 * Pass `false` to disable.
	 */
	currencyBackfillCountries?: readonly string[] | false
	/**
	 * Fold a database whose own tier permits no publication, for a gazetteer built for local use.
	 *
	 * Off by default, so a build that could reach a publish carries only folds whose tier allows it.
	 * The manifest records how many such folds were included, as `build-local-folds`.
	 */
	includeBuildLocalFolds?: boolean
	onProgress?: (phase: string, message: string) => void
}

/**
 * The message a build stops with when a fold's own tier permits no publication.
 */
function foldRefusalMessage(refusing: readonly FoldTerms[]): string {
	const lines = refusing.map(
		(fold) => `  ${fold.path} (${fold.name}) tier ${fold.tier}, recorded in ${fold.recordedIn}`
	)

	return (
		`buildCandidate: ${refusing.length} fold(s) record a tier that permits no publication:\n${lines.join("\n")}\n` +
		`Their rows would leave inside the candidate while the file itself stays behind. Pass includeBuildLocalFolds ` +
		`(mailwoman gazetteer build candidate --include-build-local) to build a gazetteer for local use, or leave ` +
		`them out of the fold list.`
	)
}

/**
 * Build the byte-range candidate gazetteer from an admin DB + postcode databases.
 *
 * The FTS5-trigram fuzzy index and the coverage manifest
 * (the artifact's own hard-filter coverage record + guard-B bboxes) are baked in before the seal.
 */
export async function buildCandidate(opts: BuildOptions): Promise<BuildCandidateResult> {
	const { buildCandidateTable } = await import("@mailwoman/resolver-wof-sqlite/build-candidate")

	// `undefined` means "use the convention"; `false` means "the caller chose an empty
	// column", and only the second may skip the resolve, so a missing artifact is not
	// indistinguishable from a deliberate opt-out in the build log.
	const importance = opts.importanceDB === false ? undefined : (opts.importanceDB ?? (await resolveImportanceDB()))

	const backfillCountries =
		opts.currencyBackfillCountries === false
			? undefined
			: (opts.currencyBackfillCountries ?? DEFAULT_WOF_PRIORITY_COUNTRIES)

	// Carry the committed capitals reference in-artifact so `capital_tier` works for npm
	// consumers who pulled candidate.db (published packages do not ship the repo file).
	const capitalsPath = repoRootPathBuilder("data", "gazetteer", "capitals-v1.json")

	const capitals = (await pathExists(capitalsPath))
		? (await readLocalJSONFile<{ entries?: CapitalPoint[] }>(capitalsPath)).entries
		: undefined

	const postcodeDatabases = [...(opts.postcodeDatabases ?? (await resolvePostcodeDatabases()))]
	const localityDatabases = [...(opts.localityDatabases ?? (await resolveLocalityDatabases()))]

	// Each fold's own tier decides whether its rows may enter a gazetteer that could be published.
	// A fold that states no tier is reported rather than refused, and its undeclared
	// grant refuses publication of the whole.
	const foldTerms = await Promise.all([...postcodeDatabases, ...localityDatabases].map((path) => readFoldTerms(path)))
	const refusing = foldsRefusingPublication(foldTerms)
	const unstated = foldTerms.filter((fold) => fold.tier === null)

	if (unstated.length) {
		opts.onProgress?.(
			"fold-terms",
			`${unstated.length} of ${foldTerms.length} folds state no tier: ${unstated.map((fold) => fold.name).join(", ")}`
		)
	}

	if (refusing.length) {
		if (!opts.includeBuildLocalFolds) {
			throw new CommandError(foldRefusalMessage(refusing))
		}

		opts.onProgress?.(
			"fold-terms",
			`folding ${refusing.length} database(s) whose tier permits no publication, as asked: ` +
				refusing.map((fold) => `${fold.name} (${fold.tier})`).join(", ")
		)
	}

	const result = await buildCandidateTable({
		input: opts.adminDB,
		output: opts.out,
		postcodes: postcodeDatabases,
		localities: localityDatabases,
		...(importance ? { importance } : {}),
		...(backfillCountries ? { currencyBackfill: { geonamesDir: geonamesDir(), countries: backfillCountries } } : {}),
		...(capitals?.length ? { capitals } : {}),
		onProgress: opts.onProgress,
	})

	// Facts about the artifact live IN the artifact: bake the measured hard-filter coverage
	// record and guard-B bboxes pre-seal, because a shipped DB is never patched.
	opts.onProgress?.("coverage-manifest", "baking country coverage + bbox manifest")
	await emitCoverageManifest({ dbPath: opts.out })

	// The layer manifest names its ancestor rather than restating the ancestor's sources,
	// because a derived layer's provenance has to be a chain.
	opts.onProgress?.("layer-manifest", "stamping provenance")
	const sha = buildSHA(repoRootPath())

	await stampLayerManifest(
		opts.out,
		await candidateLayerManifest({
			adminDBPath: opts.adminDB,
			contributingDatabases: { postcodes: postcodeDatabases, localities: localityDatabases },
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
	} catch {}

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
	/**
	 * Publish over every refusal the candidate's own `layer_manifest` raises, printing each one.
	 *
	 * Off by default, so a candidate whose tier or license permits no publication stops before a byte moves.
	 */
	overrideRefusals?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * Stop unless the candidate's own manifest permits publication, or the caller overrides.
 *
 * An absent or unreadable manifest refuses as well: an artifact that states no
 * tier cannot be said to permit publication.
 *
 * @throws When a refusal stands and `overrideRefusals` is not set.
 */
function assertCandidatePublishable(candidateDB: PathBuilderLike, key: string, overrideRefusals: boolean): void {
	const probed = probeManifest(candidateDB)

	if (probed.error) {
		throw new CommandError(
			`gazetteer publish: ${candidateDB} has no readable layer_manifest (${probed.error}), so it states no tier, ` +
				`and an artifact that states no tier cannot be said to permit publication.`
		)
	}

	if (!probed.manifest) {
		throw new CommandError(
			`gazetteer publish: ${candidateDB} carries no layer_manifest, so it states no tier, and an artifact that ` +
				`states no tier cannot be said to permit publication. Rebuild it with \`mailwoman gazetteer build candidate\`.`
		)
	}

	const refusals = refusalsForPublication([
		{
			name: probed.manifest.name,
			tier: probed.manifest.tier ?? "",
			license: probed.manifest.license ?? "",
			publishedAs: key,
		},
	])

	if (!refusals.length) return

	const lines = refusals.map((refusal) => `  ${refusal.field}: ${refusal.reason}`)

	if (!overrideRefusals) {
		throw new CommandError(
			`gazetteer publish: ${candidateDB} (layer ${probed.manifest.name}) may not be published as ${key}:\n` +
				`${lines.join("\n")}\n` +
				`Pass --override-refusals to publish it deliberately; the override prints each refusal it overrides.`
		)
	}

	console.error(
		`▸ publishing ${candidateDB} (layer ${probed.manifest.name}) as ${key} under --override-refusals, over ` +
			`${refusals.length} refusal(s):\n${lines.join("\n")}`
	)
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
 * Publishes the candidate gazetteer to R2 and updates the demo's pinned version.
 *
 * The TypeScript uploader uses multipart S3 requests.
 * It applies the cache metadata required by range requests.
 *
 * RCLONE_S3_PUBLIC_* credentials must be in the process environment.
 */
export async function publishGazetteer(opts: PublishOptions): Promise<PublishResult> {
	if (!(await pathExists(opts.candidateDB))) throw new Error(`candidate DB not found: ${opts.candidateDB}`)

	const prefix = opts.prefix ?? "mailwoman"
	const key = `${prefix}/gazetteer/${opts.version}/candidate.db`

	// The artifact's own manifest decides, before any staging or transfer.
	assertCandidatePublishable(opts.candidateDB, key, opts.overrideRefusals === true)

	const versionDir = resolvePathBuilder(opts.stageDir, "gazetteer", opts.version)
	await makeDirectories(versionDir)
	const staged = versionDir("candidate.db")

	try {
		await removePath(staged)
	} catch {}

	await createSymbolicLink(opts.candidateDB, staged)

	opts.onPhase?.("upload", `R2 ${key}${opts.dryRun ? " (dry-run)" : ""}`)

	await publishDemoAssets({
		src: resolvePath(opts.stageDir),
		bucket: opts.bucket,
		prefix,
		dryRun: opts.dryRun,
		onObject: console.error,
	})

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
 * A dated, immutable gazetteer version: `yyyy-MM-DD` plus a lowercase suffix letter,
 * e.g. `2026-06-27a`; pass a `Date`, as the module never reads the clock implicitly.
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
