/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The storage class of each corpus source directory, and where `mailwoman corpus fetch` writes each class.
 *
 * A current source is mutable, and fetching it again brings it up to date: a git clone, or a file the
 * publisher serves under an undated name that a refetch replaces. It lives under
 * `$MAILWOMAN_CACHE_ROOT/sources/<source>/`, which a customer can clear at the cost of a refetch.
 *
 * A snapshot is one dated vintage, read-only once written, with a newer vintage beside it. It lives under
 * `$MAILWOMAN_DATA_ROOT/snapshots/<source>/<vintage>/`, and `writeSnapshot` from
 * `@mailwoman/core/fs/snapshot` refuses to replace a vintage unless the caller states it with
 * `--vintage` and passes `--force`.
 *
 * The table lives here rather than in each fetcher because the command reads it before it imports the
 * fetcher it runs, and because one table lets a test check that every fetch source declares a class.
 */

import { assertVintage, currentSourcesRoot, snapshotSourcesRoot } from "@mailwoman/core/data-root"
import { type SnapshotWriteOptions, writeSnapshot } from "@mailwoman/core/fs/snapshot"
import { PathBuilder } from "path-ts"

import type { FetchSourceID } from "#tools/fetch"
import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"

/**
 * The two storage classes a downloaded source can take.
 */
export const StorageClass = {
	/**
	 * Mutable, and brought up to date by fetching again.
	 */
	current: "current",
	/**
	 * A dated vintage, read-only once written.
	 */
	snapshot: "snapshot",
} as const

export type StorageClass = (typeof StorageClass)[keyof typeof StorageClass]

/**
 * A source directory whose fetch writes both classes: a current download and the snapshot made from it.
 * Each field describes the files of that class.
 */
export interface MixedStorage {
	readonly current: string
	readonly snapshot: string
}

/**
 * The storage class of each corpus source directory, keyed by the directory's slug.
 *
 * Every directory a fetch source writes appears here, along with the snapshot sources that have no fetcher.
 * `cn-units` is absent: it holds recipe splits, a built artifact that stays under the data root.
 *
 * Geofabrik extracts are absent too: they're a snapshot source, but `corpus fetch` doesn't reach them.
 * `packages/osm/tools/fetch/extract.ts` writes them, one series of vintages per region, under
 * `snapshots/geofabrik/<region>/`, so they have no single source directory for this table to key.
 */
export const SOURCE_STORAGE_CLASSES = {
	"acra-sg": StorageClass.current,
	ads: StorageClass.current,
	ban: StorageClass.current,
	"bd-adresses": StorageClass.current,
	brussels: StorageClass.current,
	cordis: StorageClass.current,
	"cz-cuzk": StorageClass.current,
	"dk-inspire": StorageClass.current,
	emuia: StorageClass.current,
	"es-bizkaia": StorageClass.current,
	"es-catastro": StorageClass.current,
	"es-gipuzkoa": StorageClass.current,
	"es-navarra": StorageClass.current,
	"fr-annuaire-education-overseas": StorageClass.current,
	// `etalab-cs1100502-stock-YYYYMMDD-HHMM.csv`: each extract's file name states its extraction date.
	"fr-finess-overseas": StorageClass.snapshot,
	"gb-os-open": StorageClass.current,
	"gcis-tw": StorageClass.current,
	"geonames-dump": StorageClass.current,
	"geonames-postal": StorageClass.current,
	// The fetcher deletes older golden copies, so one copy is kept, and a refetch replaces it.
	gleif: StorageClass.current,
	// `00_zenkoku_all_YYYYMMDD.zip`, the file name the download's attachment header states.
	"houjin-jp": StorageClass.snapshot,
	"it-anac": StorageClass.current,
	// `YYYYMMALLMTCHG00.zip` and `RN_ENG_YYMM.zip`: one month's register.
	"juso-kr": StorageClass.snapshot,
	"localdata-kr": StorageClass.current,
	"lv-varis": StorageClass.current,
	matrikkelen: StorageClass.current,
	"nl-kadaster": StorageClass.current,
	openaddresses: StorageClass.current,
	ourairports: StorageClass.current,
	"ro-retea-scolara": StorageClass.current,
	ryhti: StorageClass.current,
	"sk-inspire": StorageClass.current,
	"state-de-notaries": StorageClass.current,
	"state-hi-lobbyists": StorageClass.current,
	"state-hi-schools": StorageClass.current,
	"state-ia-contractors": StorageClass.current,
	"state-ny-notaries": StorageClass.current,
	"state-or-notaries": StorageClass.current,
	"state-tx-notaries": StorageClass.current,
	"state-wa-health-providers": StorageClass.current,
	// The `tl_2024` files of one yearly TIGER release.
	tiger: StorageClass.snapshot,
	"usgov-hrsa-fqhc": StorageClass.current,
	// `pls_fy2023_csv.zip`, a pinned survey year.
	"usgov-imls-pls": StorageClass.snapshot,
	"usgov-nad": {
		current: "bulk/nad.zip, the release archive DOT serves at an undated link",
		snapshot: "<release>/TXT_NAD_<release>.parquet, converted from the archive's text member",
	},
	// `NPPES_Data_Dissemination_<Month>_<Year>.zip`: one month's full replacement file.
	"usgov-nppes": StorageClass.snapshot,
	vlaanderen: StorageClass.current,
	wallonie: StorageClass.current,
	"wikidata-subvenue": StorageClass.current,
	"wikidata-vital-places": StorageClass.current,

	// No fetcher in the repository reproduces these, so a cleared copy couldn't be fetched again.
	// Each one's vintage is in UNFETCHED_SNAPSHOT_VINTAGES.
	"adressur-fo": StorageClass.snapshot,
	"bsp-gu": StorageClass.snapshot,
	"gb-companies-house": StorageClass.snapshot,
	"gbpa-bs": StorageClass.snapshot,
	"ide-uy": StorageClass.snapshot,
	"landregistry-im": StorageClass.snapshot,
	"llv-li": StorageClass.snapshot,
	"opendata-az": StorageClass.snapshot,
} as const satisfies Record<string, StorageClass | MixedStorage>

/**
 * A source directory slug in {@link SOURCE_STORAGE_CLASSES}.
 */
export type SourceSlug = keyof typeof SOURCE_STORAGE_CLASSES

/**
 * The vintage of each snapshot source that has no fetcher: the retrieval date
 * that `data/corpus-source-inputs.json` records in its `reads` text, or,
 * where it records none, the date in the file's name.
 */
export const UNFETCHED_SNAPSHOT_VINTAGES = {
	// "read whole on 2026-10-18"
	"adressur-fo": "2026-10-18",
	// "read whole on 2026-10-18"
	"bsp-gu": "2026-10-18",
	// `BasicCompanyDataAsOneFile-2026-10-01.zip`; the input table records no retrieval.
	"gb-companies-house": "2026-10-01",
	// "retrieved 2026-10-18"
	"gbpa-bs": "2026-10-18",
	// "the 19 department CSVs retrieved 2026-10-17"
	"ide-uy": "2026-10-17",
	// `landtransactionsjan2025.csv`, "from the Internet Archive's 2025-02-23 capture"
	"landregistry-im": "2025-02-23",
	// "retrieved 2026-10-18"
	"llv-li": "2026-10-18",
	// "retrieved 2026-10-18"
	"opendata-az": "2026-10-18",
} as const satisfies Partial<Record<SourceSlug, string>>

/**
 * The source directories each `mailwoman corpus fetch` source writes.
 *
 * The mapped type makes the compiler refuse a fetch source with no entry here.
 */
export const FETCH_SOURCE_DIRECTORIES = {
	"acra-sg": ["acra-sg"],
	"ads-ee": ["ads"],
	ban: ["ban"],
	"bd-adresses": ["bd-adresses"],
	brussels: ["brussels"],
	cordis: ["cordis"],
	"cz-cuzk": ["cz-cuzk"],
	"dk-inspire": ["dk-inspire"],
	"emuia-pl": ["emuia"],
	"es-bizkaia": ["es-bizkaia"],
	"es-catastro": ["es-catastro"],
	"es-gipuzkoa": ["es-gipuzkoa"],
	"es-navarra": ["es-navarra"],
	"fr-annuaire-education-overseas": ["fr-annuaire-education-overseas"],
	"fr-finess-overseas": ["fr-finess-overseas"],
	"gb-os-open": ["gb-os-open"],
	"gcis-tw": ["gcis-tw"],
	"geonames-dump": ["geonames-dump"],
	"geonames-postal": ["geonames-postal"],
	gleif: ["gleif"],
	hrsa: ["usgov-hrsa-fqhc"],
	"houjin-jp": ["houjin-jp"],
	"imls-pls": ["usgov-imls-pls"],
	"it-anac": ["it-anac"],
	"juso-kr": ["juso-kr"],
	"localdata-kr": ["localdata-kr"],
	"lv-varis": ["lv-varis"],
	matrikkelen: ["matrikkelen"],
	nad: ["usgov-nad"],
	"nl-kadaster": ["nl-kadaster"],
	nppes: ["usgov-nppes"],
	openaddresses: ["openaddresses"],
	ourairports: ["ourairports"],
	"ro-retea-scolara": ["ro-retea-scolara"],
	ryhti: ["ryhti"],
	"sk-inspire": ["sk-inspire"],
	"state-hi-schools": ["state-hi-schools"],
	"state-sources": [
		"state-de-notaries",
		"state-hi-lobbyists",
		"state-ia-contractors",
		"state-ny-notaries",
		"state-or-notaries",
		"state-tx-notaries",
		"state-wa-health-providers",
	],
	"tiger-full": ["tiger"],
	vlaanderen: ["vlaanderen"],
	wallonie: ["wallonie"],
	"wikidata-subvenue": ["wikidata-subvenue"],
	"wikidata-vital-places": ["wikidata-vital-places"],
} as const satisfies Readonly<Record<FetchSourceID, readonly SourceSlug[]>>

/**
 * Whether any directory `source` writes holds a snapshot, as a snapshot source
 * or beside a current download.
 */
export function writesSnapshot(source: FetchSourceID): boolean {
	return FETCH_SOURCE_DIRECTORIES[source].some((slug: SourceSlug) => {
		const storage: StorageClass | MixedStorage = SOURCE_STORAGE_CLASSES[slug]

		return storage !== StorageClass.current
	})
}

/**
 * Where a snapshot fetch writes, and how it may treat a vintage already on disk.
 */
export interface SnapshotDestination {
	/**
	 * The root every snapshot source sits under, so one vintage is `root(<source>, <vintage>)`.
	 *
	 * @defaultValue `snapshotSourcesRoot()`, `$MAILWOMAN_DATA_ROOT/snapshots/`
	 */
	root: PathBuilder
	/**
	 * The vintage the caller stated with `--vintage`, or `null` when the fetcher resolves it.
	 */
	vintage: string | null
	/**
	 * Whether the caller passed `--force`.
	 * It replaces a vintage only together with a stated one.
	 */
	force: boolean
}

/**
 * The option base of a fetcher whose source is a snapshot.
 */
export interface SnapshotFetchOptions extends Omit<BaseFetchOptions, "outRoot"> {
	snapshots: SnapshotDestination
}

/**
 * The roots one `mailwoman corpus fetch` run writes under.
 */
export interface FetchDestinations {
	/**
	 * The root each current source writes `<outRoot>/<source>/` under.
	 */
	outRoot: PathBuilder
	snapshots: SnapshotDestination
}

/**
 * The `mailwoman corpus fetch` options that decide where a source is written.
 */
export interface FetchDestinationOptions {
	/**
	 * `--out-root`: one root for both classes, so a current source writes `<out-root>/<source>/`
	 * and a snapshot writes `<out-root>/<source>/<vintage>/`.
	 */
	outRoot?: string | null
	/**
	 * `--vintage`
	 */
	vintage?: string | null
	/**
	 * `--force`
	 */
	force?: boolean
}

/**
 * Resolve the command's options for `source` into the roots its fetcher writes under.
 *
 * @throws When `--vintage` or `--force` is given for a source that writes no snapshot,
 * or when `--vintage` isn't one path segment a vintage can take.
 */
export function resolveFetchDestinations(source: FetchSourceID, options: FetchDestinationOptions): FetchDestinations {
	const vintage = options.vintage || null
	const force = options.force ?? false

	if ((vintage != null || force) && !writesSnapshot(source)) {
		throw new Error(
			`${source} is a current source, which a fetch brings up to date in place; --vintage and --force apply only to a snapshot source`
		)
	}

	if (vintage != null) {
		assertVintage(vintage)
	}

	const override = options.outRoot ? PathBuilder.from(options.outRoot) : null

	return {
		outRoot: override ?? currentSourcesRoot(),
		snapshots: { root: override ?? snapshotSourcesRoot(), vintage, force },
	}
}

/**
 * The directory of one vintage of `slug` under `destination`.
 *
 * @param resolved The vintage the fetcher found at the publisher, such as the date in a file's name.
 * @throws When the caller stated another vintage than the one the publisher serves,
 * because writing one month's file under another month's name would misdate it.
 */
export function snapshotVintagePath(destination: SnapshotDestination, slug: SourceSlug, resolved: string): PathBuilder {
	if (destination.vintage != null && destination.vintage !== resolved) {
		throw new Error(`${slug}: the publisher serves vintage ${resolved}, not the --vintage ${destination.vintage} given`)
	}

	assertVintage(resolved)

	return destination.root(slug, resolved)
}

/**
 * The options `writeSnapshot` takes for a write to `destination`.
 */
export function snapshotWriteOptions(destination: SnapshotDestination): SnapshotWriteOptions {
	return { vintageFromCaller: destination.vintage != null, force: destination.force }
}

/**
 * Thrown inside a snapshot fill whose fetch reported a failure, so `writeSnapshot`
 * discards the staging directory.
 */
class IncompleteSnapshotError extends Error {
	public readonly summary: FetchSummary

	constructor(summary: FetchSummary) {
		super(`the fetch failed for ${summary.failedCodes.join(", ") || "an unnamed file"}`)

		this.name = "IncompleteSnapshotError"
		this.summary = summary
	}
}

/**
 * Write vintage `vintage` of `slug` through `fill`, which fetches into the directory it is given.
 *
 * The fetched directory moves into the vintage only once `fill` finishes with no failure.
 * A fetch that reports a failure leaves any existing vintage as it was, writes no partial
 * vintage, and its summary is returned so the command exits non-zero.
 *
 * @throws {SnapshotExistsError} When the vintage exists and the caller didn't
 * both state it and pass `--force`.
 */
export async function fetchSnapshot(
	destination: SnapshotDestination,
	slug: SourceSlug,
	vintage: string,
	fill: (directory: PathBuilder) => Promise<FetchSummary>,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const target = snapshotVintagePath(destination, slug, vintage)
	const written: { summary?: FetchSummary } = {}

	report?.(`  vintage ${vintage} → ${target}`)

	try {
		await writeSnapshot(target, snapshotWriteOptions(destination), async (staging) => {
			const filled = await fill(PathBuilder.from(staging))

			if (filled.failed > 0) throw new IncompleteSnapshotError(filled)

			written.summary = filled
		})
	} catch (error) {
		if (!(error instanceof IncompleteSnapshotError)) throw error

		report?.(`  ✗ ${error.message}; vintage ${vintage} was not written`)

		return error.summary
	}

	return written.summary!
}
