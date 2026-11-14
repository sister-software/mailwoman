// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The candidate-gazetteer build → promote → publish pipeline, as reusable functions the `mailwoman
 * gazetteer` commands compose.
 *
 * `fold` and `build` reuse the canonical package functions.
 * The CLI and standalone scripts share one implementation.
 *
 * A future `build-unified-wof --geonames-countries` will use it too.
 * `publish` uses the same TypeScript R2 publisher as the standalone release tool
 * and bumps the demo's `ADMIN_GAZETTEER_VERSION`; the demo resource file is the
 * only repo-coupled path, so callers pass it in.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists, statLink } from "@mailwoman/core/fs/readers/stat"
import {
	createSymbolicLink,
	makeDirectories,
	removePath,
	removePathIfPresent,
	writeLocalFile,
} from "@mailwoman/core/fs/writers"
import { refusalsForPublication } from "@mailwoman/core/layers"
import { repoRootPath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { CommandError } from "@mailwoman/core/scripting/command"
import { createPhaseClock, isoDate, type PhaseTiming } from "@mailwoman/core/utils"
// resolver-wof-sqlite's runtime modules are imported inside the functions that use them,
// because `mailwoman --help` imports every command and a module-level value import
// would evaluate the resolver's module graph on that path.
import type { BuildCandidateResult } from "@mailwoman/resolver-wof-sqlite/build/candidate"
import type { CapitalPoint } from "@mailwoman/resolver-wof-sqlite/capitals"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { recoverInterruptedBuilds, sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { probeManifest } from "mailwoman/data/inventory"
import { resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"

import {
	candidateLayerManifest,
	censusFolds,
	type FoldTerms,
	foldsRefusingPublication,
	readFoldTerms,
} from "#tools/pipeline/candidate-manifest"
import { emitCoverageManifest } from "#tools/pipeline/coverage-manifest"
import { DEFAULT_IMPORTANCE_DB } from "#tools/pipeline/defaults"
import { buildSHA, stampLayerManifest } from "#tools/pipeline/stamp-manifest"
import { publishToPublicBucket } from "#tools/publish/public-bucket"

/**
 * The canonical postcode-database set (filenames under `<data-root>/db/wof/`);
 * missing databases are skipped rather than fatal.
 *
 * Every member is spelled `postalcode-` because that's a routing interface: `deriveSchemaName`
 * turns the filename into the attached SQL schema name and `pickExtractsForPlacetype`
 * tests it against the placetype, so a database stored as `postcode-<cc>.db` builds fine
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
	// A miss on a BT code means not attested in OSM rather than that the code doesn't exist.
	// ODbL 1.0 is share-alike, so this artifact is never published and folds
	// only under `includeBuildLocalFolds`.
	"postalcode-ni-osm.db",
	// Japan's 7-digit codes from WOF.
	// The candidate fold skips the 48,216 rows whose coordinates equal the 0,0 unlocated sentinel.
	"postalcode-jp.db",
	// The GeoNames-postal tail database: ten countries in ingest order.
	"postalcode-geonames-tail.db",
	"postalcode-ca-overture.db",
	...["at", "be", "ch", "cz", "dk", "es", "fi", "hr", "lt", "lu", "lv", "no", "pl", "pt", "si", "sk"].map(
		(cc) => `postalcode-${cc}-overture.db`
	),
	// Singapore: a six-digit postcode identifies one building, so the per-postcode
	// Overture centroid answers at rooftop grade.
	"postalcode-sg-overture.db",
]

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
 * Resolve the conventional score source, or `null` when this machine has none.
 *
 * A deployment without the file must build a candidate DB with an empty
 * `importance` column rather than fail.
 */
export async function resolveImportanceDB(
	filename: string = DEFAULT_IMPORTANCE_DB,
	dataRoot: PathBuilderLike = dataRootPath()
): Promise<string | null> {
	const path = wofDatabaseRoot(dataRoot)(filename)

	return (await pathExists(path)) ? path.toString() : null
}

export interface BuildOptions {
	/**
	 * Admin DB to build the candidate from.
	 * The admin build already folds GeoNames into it.
	 */
	adminDB: PathBuilderLike
	/**
	 * Candidate-DB output path.
	 */
	out: PathBuilderLike
	/**
	 * Absolute postcode-database paths to fold in.
	 *
	 * @defaultValue {@link resolvePostcodeDatabases}
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
	 * Score source for the `importance` column.
	 *
	 * Pass `false` to build the column empty on purpose.
	 *
	 * @defaultValue {@link resolveImportanceDB}
	 */
	importanceDB?: string | false
	/**
	 * Fold a database whose own tier permits no publication, for a gazetteer built for local use.
	 *
	 * Off by default, so a build that could reach a publish includes only folds whose tier allows it.
	 * The manifest records the number of such folds included, as `build-local-folds`.
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
export async function buildCandidate(
	options: BuildOptions
): Promise<BuildCandidateResult & { phaseSeconds: PhaseTiming[] }> {
	const { buildCandidateTable } = await import("@mailwoman/resolver-wof-sqlite/build/candidate")
	const clock = createPhaseClock()

	// Every progress line also marks its phase on the clock.
	// The result reports each phase's time.
	const opts: BuildOptions = {
		...options,
		onProgress: (phase, message) => {
			clock.mark(phase)
			options.onProgress?.(phase, message)
		},
	}

	// `undefined` means "use the convention"; `false` means "the caller chose an empty column".
	// Only the second may skip the resolve, so a missing artifact isn't indistinguishable
	// from a deliberate opt-out in the build log.
	const importance = opts.importanceDB === false ? undefined : (opts.importanceDB ?? (await resolveImportanceDB()))

	// Include the committed capitals reference in the artifact so `capital_tier` works for
	// npm consumers who pulled candidate.db (published packages do not ship the repo file).
	const capitalsPath = repoRootPathBuilder("data", "gazetteer", "capitals-v1.json")

	const capitals = (await pathExists(capitalsPath))
		? (await readLocalJSONFile<{ entries?: CapitalPoint[] }>(capitalsPath)).entries
		: null

	const postcodeDatabases = [...(opts.postcodeDatabases ?? (await resolvePostcodeDatabases()))]
	const localityDatabases = [...(opts.localityDatabases ?? (await resolveLocalityDatabases()))]

	// Each fold's own tier decides whether its rows may enter a gazetteer that could be published.
	// A fold that states no tier is reported rather than refused.
	// Its undeclared grant refuses publication of the whole.
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

	// The build writes a temporary file and swaps it in once sealed.
	// `candidate.db` links to the output, so a reader never opens a half-built gazetteer,
	// and a failed build leaves the previous one in place.
	const tmp = `${opts.out}.tmp-${process.pid}`

	await recoverInterruptedBuilds(opts.out)

	try {
		const result = await buildCandidateTable({
			input: opts.adminDB,
			output: tmp,
			postcodes: postcodeDatabases,
			localities: localityDatabases,
			...(importance ? { importance } : {}),
			...(capitals?.length ? { capitals } : {}),
			onProgress: opts.onProgress,
		})

		// Facts about the artifact live IN the artifact: bake the measured hard-filter coverage
		// record and guard-B bboxes pre-seal, because a shipped DB is never patched.
		opts.onProgress?.("coverage-manifest", "baking country coverage + bbox manifest")
		await emitCoverageManifest({ dbPath: tmp })

		// The layer manifest identifies its ancestor rather than restating the ancestor's
		// sources, because a derived layer's provenance has to be a chain.
		opts.onProgress?.("layer-manifest", "stamping provenance")
		const sha = buildSHA(repoRootPath())

		// Counted before the seal, because an upstream release is pruned from its bucket
		// and a fold's share of the published artifact is then unrecoverable from anything
		// but the artifact's own manifest.
		const foldCensus = censusFolds(tmp)

		opts.onProgress?.(
			"layer-manifest",
			`folds: ${foldCensus.map((fold) => `${fold.fold} ${fold.rows} rows / ${fold.places} places`).join(", ")}`
		)

		await stampLayerManifest(
			tmp,
			await candidateLayerManifest({
				adminDBPath: opts.adminDB,
				contributingDatabases: { postcodes: postcodeDatabases, localities: localityDatabases },
				importance: Boolean(importance),
				buildSHA: sha,
				version: isoDate(),
				createdAt: new Date().toISOString(),
				foldCensus,
			})
		)

		// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
		clock.mark("seal")
		await sealDatabase(tmp)
		await swapDatabaseIntoPlace(tmp, opts.out)

		return { ...result, phaseSeconds: clock.finish() }
	} catch (error) {
		await removePathIfPresent(tmp)

		throw error
	}
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
 * @throws When a refusal stands and `overrideRefusals` isn't set.
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
			`gazetteer publish: ${candidateDB} carries no layer_manifest, so it states no tier. An artifact that ` +
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

	await publishToPublicBucket({
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

export * from "#tools/pipeline/coverage-manifest"
export * from "#tools/pipeline/defaults"
export * from "#tools/pipeline/fts"
export * from "#tools/pipeline/verify"
export * from "#tools/pipeline/admin"
export * from "#tools/pipeline/admin/enrich"
export * from "#tools/pipeline/admin/fold/geonames"
export * from "#tools/pipeline/admin/fold/overture"
export * from "#tools/pipeline/admin/freeze"
export * from "#tools/pipeline/admin/ingest-wof"
export * from "#tools/pipeline/postcode"
export * from "#tools/pipeline/postcode/binary"
export * from "#tools/pipeline/postcode/centroid-fills"
export * from "#tools/pipeline/postcode/zcta-centroids"
export { DEFAULT_GEONAMES_TAIL_COUNTRIES } from "#tools/pipeline/defaults"

export {
	geonamesTailTerms,
	type DatabaseMetaDatabase,
	createDatabaseMetaTable,
	writeMetaRows,
	type GeonamesPostalSourceFact,
	type BuildPostcodeGeonamesTailOptions,
	type BuildPostcodeGeonamesTailResult,
	buildPostcodeGeonamesTail,
} from "#tools/pipeline/postcode/geonames/tail"
