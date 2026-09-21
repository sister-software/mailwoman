/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Registry for downloadable public-data bundles. It defines remote artifacts, their local paths,
 *   and whether local state is current. the data commands own network and filesystem I/O.
 */

import type { DataReleaseManifest } from "#data/release"

/**
 * Public base URL for bundle artifacts.
 */
export const PUBLIC_BUCKET_BASE_URL = "https://public.mailwoman.ai/mailwoman/"

/**
 * One downloadable file within a {@link DataBundle}.
 */
export interface BundleArtifact {
	/**
	 * The R2 object key, relative to {@link PUBLIC_BUCKET_BASE_URL}
	 * (e.g. `"gazetteer/2026-07-07a/candidate.db"`).
	 */
	remotePath: string
	/**
	 * Where the artifact lands, relative to the data root (e.g. `"wof/candidate.db"`).
	 *
	 * For a `family`-tagged (`"us"` bundle) artifact this is the legacy unversioned path;
	 * {@link resolveBundleArtifacts} substitutes the manifest-pinned versioned name when one is configured.
	 */
	localPath: string
	/**
	 * Whether the bucket publishes a `<remotePath>.md5` sidecar to verify against.
	 *
	 * `false` for every artifact today (surveyed 2026-08-03 — see the module docstring);
	 * the field exists so a bundle that starts publishing one needs no shape change, only a flip.
	 */
	md5Sidecar: boolean
	/**
	 * Byte size at survey time, for the dry-run plan and `data status`'s human-readable sizes only.
	 *
	 * Not a integrity check target (a rebuild at the same dated path would be a bug,
	 * since these paths are meant to be immutable, but this field is not how a mismatch
	 * would be caught — the head `Content-Length` at pull time is).
	 */
	approxBytes: number
	/**
	 * The `data-release.ts` family this artifact belongs to (`"address-points"` | `"interpolation"`),
	 * for the `us` bundle's per-state databases only.
	 *
	 * Absent for every other bundle (candidate/poi/fr are single fixed-path artifacts
	 * with no local version-pinning story).
	 */
	family?: "address-points" | "interpolation"
	/**
	 * The 2-letter US state/territory slug this artifact belongs to, alongside {@link family}.
	 */
	stateSlug?: string
}

/**
 * What a bundle's rows came from and what using them obliges an operator to.
 *
 * A bundle is downloaded rather than installed with the package, so its terms reach
 * an operator through nothing the npm tarball carries.
 * `data --list` and `data pull` print these before the transfer, since the moment
 * to read terms is before taking a copy rather than after.
 *
 * `unresolved` is a field rather than an omission.
 * A bundle assembled from several upstream sources carries whatever is unestablished about them,
 * and leaving that blank would present a partially-read bundle as a fully-read one.
 */
/**
 * Where a bundle's artifacts carry the publisher of each row, so the record's
 * claim can be checked against the bytes.
 *
 * The `us` bundle's record named the Census Bureau and OpenAddresses while 68.2% of
 * its rows carried a stamp naming the National Address Database, and the record's own
 * open question asked for a list the databases already held on every row.
 * Prose about publishers drifts from the data it describes, and nothing read the data.
 *
 * Absent means the artifacts carry no per-row publisher.
 * That is a recorded fact rather than an omission: the `candidate` gazetteer's rows name no source,
 * so a census of it would report nothing and reporting nothing would read as a clean result.
 */
export interface BundleSourceCensus {
	/**
	 * The table holding one row per record, or one row describing the layer.
	 *
	 * A union rather than a string.
	 * A runtime table name has no schema to check a query against, which is what pushes a
	 * reader into casting through `never` and then validating the string by hand.
	 *
	 * A closed set is checkable by the compiler, and adding an artifact shape means
	 * adding a member here and to the census reader's schema together.
	 */
	table: "address_point" | "layer_manifest"
	/**
	 * The column naming the publisher of a row.
	 */
	column: "source"
	/**
	 * Whether {@link BundleSourceCensus.table} holds one row per record or one row for the whole artifact.
	 *
	 * A manifest row describes the layer, so its count is the number of manifest rows rather than a row count.
	 */
	shape: "per-row" | "manifest"
	/**
	 * The artifact family this census covers, when a bundle carries more than one.
	 *
	 * The `us` bundle ships address-point databases beside TIGER interpolation databases,
	 * and only the first carries an `address_point` table.
	 * Reading every artifact reported 51 interpolation databases as unreadable, which is
	 * the wrong description: a TIGER database is a different artifact whose publisher the
	 * record names separately, rather than an address-point database that failed to open.
	 *
	 * A census that names its family says what it covers.
	 */
	family?: BundleArtifact["family"]
}

export interface BundleRights {
	/**
	 * Who published the rows, as they name themselves.
	 */
	publishers: readonly string[]
	/**
	 * The terms as the publisher names them.
	 *
	 * Several entries where a bundle draws on several publications.
	 */
	terms: readonly string[]
	/**
	 * What an operator must do, stated as the obligation rather than as a license name.
	 */
	conditions: readonly string[]
	/**
	 * What nobody has established about this bundle's terms.
	 */
	unresolved: readonly string[]
}

/**
 * A named, downloadable subset of Mailwoman's public data.
 * What `mailwoman data pull <name>` fetches.
 */
export interface DataBundle {
	name: string
	description: string
	artifacts: BundleArtifact[]
	/**
	 * The terms this bundle's rows carry.
	 *
	 * Required, so a bundle added without one fails to compile rather than
	 * downloading with its obligations unstated.
	 */
	rights: BundleRights
	/**
	 * Where this bundle's artifacts name the publisher of a row, so `mailwoman data sources`
	 * can check the record above against the bytes.
	 *
	 * Absent when the artifacts carry no such column.
	 */
	sourceCensus?: BundleSourceCensus
}

/**
 * Per-state hosted street-tier sizes (bytes), from the 2026-08-03 bucket survey —
 * the source table {@link usStreetArtifacts} expands into `BundleArtifact` entries.
 *
 * `interp` is absent for `vi` (no tiger interpolation database hosted for the territory —
 * a real, confirmed gap rather than a table-entry someone forgot).
 */
const US_STREET_DATABASE_SIZES: Record<string, { situs: number; interp?: number }> = {
	ak: { situs: 78_602_240, interp: 26_771_456 },
	al: { situs: 660_025_344, interp: 256_548_864 },
	ar: { situs: 396_853_248, interp: 201_338_880 },
	az: { situs: 907_603_968, interp: 207_245_312 },
	ca: { situs: 3_471_339_520, interp: 779_272_192 },
	co: { situs: 716_697_600, interp: 216_334_336 },
	ct: { situs: 256_991_232, interp: 94_732_288 },
	dc: { situs: 119_889_920, interp: 7_426_048 },
	de: { situs: 125_595_648, interp: 29_114_368 },
	fl: { situs: 3_226_046_464, interp: 511_512_576 },
	ga: { situs: 173_764_608, interp: 365_641_728 },
	hi: { situs: 77_320_192, interp: 13_205_504 },
	ia: { situs: 358_260_736, interp: 193_032_192 },
	id: { situs: 93_683_712, interp: 82_628_608 },
	il: { situs: 1_134_772_224, interp: 373_002_240 },
	in: { situs: 767_078_400, interp: 301_297_664 },
	ks: { situs: 240_205_824, interp: 147_968_000 },
	ky: { situs: 545_275_904, interp: 292_974_592 },
	la: { situs: 63_488_000, interp: 165_015_552 },
	ma: { situs: 865_357_824, interp: 163_999_744 },
	md: { situs: 594_812_928, interp: 147_357_696 },
	me: { situs: 165_101_568, interp: 86_224_896 },
	mi: { situs: 229_376_000, interp: 305_459_200 },
	mn: { situs: 646_877_184, interp: 269_025_280 },
	mo: { situs: 399_859_712, interp: 305_311_744 },
	ms: { situs: 271_257_600, interp: 175_767_552 },
	mt: { situs: 146_735_104, interp: 88_612_864 },
	nc: { situs: 1_380_876_288, interp: 512_188_416 },
	nd: { situs: 103_890_944, interp: 76_918_784 },
	ne: { situs: 187_617_280, interp: 103_297_024 },
	nh: { situs: 20_480, interp: 57_618_432 },
	nj: { situs: 932_855_808, interp: 166_936_576 },
	nm: { situs: 249_671_680, interp: 83_804_160 },
	nv: { situs: 6_553_600, interp: 69_890_048 },
	ny: { situs: 1_440_923_648, interp: 317_833_216 },
	oh: { situs: 1_248_694_272, interp: 404_860_928 },
	ok: { situs: 354_828_288, interp: 162_582_528 },
	or: { situs: 1_034_625_024, interp: 173_268_992 },
	pa: { situs: 269_873_152, interp: 482_373_632 },
	ri: { situs: 79_159_296, interp: 28_938_240 },
	sc: { situs: 47_661_056, interp: 255_586_304 },
	sd: { situs: 21_811_200, interp: 71_929_856 },
	tn: { situs: 887_808_000, interp: 365_576_192 },
	tx: { situs: 2_568_024_064, interp: 721_600_512 },
	ut: { situs: 363_622_400, interp: 86_228_992 },
	va: { situs: 933_728_256, interp: 371_740_672 },
	vi: { situs: 618_496 },
	vt: { situs: 72_945_664, interp: 58_507_264 },
	wa: { situs: 735_141_888, interp: 267_419_648 },
	wi: { situs: 340_619_264, interp: 184_680_448 },
	wv: { situs: 227_700_736, interp: 120_385_536 },
	wy: { situs: 51_003_392, interp: 37_691_392 },
}

/**
 * Expand {@link US_STREET_DATABASE_SIZES} into the `us` bundle's artifact list: `remotePath` mirrors
 * the bucket's `street/us/<slug>/{situs,interp}.db` layout; `localPath` mirrors `geocode-core.ts`'s
 * `address-points-us-<slug>.db`/`interpolation-us-<slug>.db` legacy (unversioned) convention.
 */
function usStreetArtifacts(): BundleArtifact[] {
	const artifacts: BundleArtifact[] = []

	for (const [slug, sizes] of Object.entries(US_STREET_DATABASE_SIZES)) {
		artifacts.push({
			remotePath: `street/us/${slug}/situs.db`,
			localPath: `address-points/address-points-us-${slug}.db`,
			md5Sidecar: false,
			approxBytes: sizes.situs,
			family: "address-points",
			stateSlug: slug,
		})

		if (sizes.interp) {
			artifacts.push({
				remotePath: `street/us/${slug}/interp.db`,
				localPath: `interpolation/interpolation-us-${slug}.db`,
				md5Sidecar: false,
				approxBytes: sizes.interp,
				family: "interpolation",
				stateSlug: slug,
			})
		}
	}

	return artifacts
}

/**
 * The bundle registry.
 *
 * Every artifact here was checked against the live bucket on 2026-08-03
 * (see the module docstring) — no invented paths.
 * `timezone` (named in this task's brief as a candidate bundle) is absent on purpose:
 * nothing under `mailwoman/` in the bucket serves it.
 */
export const BUNDLES: Record<string, DataBundle> = {
	candidate: {
		name: "candidate",
		description:
			"Global admin candidate gazetteer — population-first place resolution + postcode coverage across 244 countries (~2.88 GB).",
		artifacts: [
			{
				remotePath: "gazetteer/2026-08-25b/candidate.db",
				localPath: "wof/candidate.db",
				md5Sidecar: false,
				approxBytes: 2_880_921_600,
			},
		],
		rights: {
			publishers: ["Who's On First", "GeoNames"],
			terms: [
				"Who's On First: Creative Commons Zero covers the format and structure, in those words, and the dataset is also a modification of existing open data whose sources carry their own terms. The text as retrieved on 2026-09-21 is archived at packages/corpus/data/licenses/whosonfirst-licenses.md.",
				"GeoNames: Creative Commons Attribution 4.0, the version its export readme names. Its about page names the license without a version. Both as retrieved on 2026-09-21, archived at packages/corpus/data/licenses/geonames-publication.md.",
			],
			conditions: [
				"Link back to the Who's On First license. Its own text makes the link required and crediting the project recommended, which is the one place those two differ.",
				"Attribute GeoNames.",
			],
			unresolved: [
				"Which upstream project each row's name came from. Who's On First records a geometry source per record and the corpus adapters read none of it — see docs/engineering/reference/artifact-rights-inventory.mdx.",
				"Whether the Ordnance Survey notice in Who's On First's source list reaches any row in this bundle. The list names Ordnance Survey of Northern Ireland under Open Government Licence v3.0 and Ordnance Survey Ireland under its own portal terms, and names Royal Mail nowhere.",
				"Which of the 102 sources the Who's On First list names contributed to a given record. The list was generated 2020-02-21 and the dataset has moved since, so it is evidence of what contributed up to that date.",
			],
		},
	},
	poi: {
		name: "poi",
		description: "Overture-places POI layer — 13.68M rows across US/CA/MX/FR (~3.89 GB).",
		artifacts: [
			{
				remotePath: "poi/2026-07-20a/poi.db",
				localPath: "poi/poi.db",
				md5Sidecar: false,
				approxBytes: 3_889_184_768,
			},
		],
		rights: {
			publishers: ["Overture Maps Foundation"],
			terms: [
				"Overture Places theme: CDLA-Permissive-2.0. The text as retrieved on 2026-09-21 is archived at packages/corpus/data/licenses/cdla-permissive-2.0.md.",
			],
			conditions: [
				"Supply the text of the agreement with the data if you share it. That is the condition §2.1 states on sharing, and it asks for the agreement rather than for a contributor's name.",
				"Nothing is required of a model trained on these rows. §3.1 states the agreement imposes no restriction or obligation on Results, and §5.4 defines Results to include machine learning models.",
			],
			unresolved: [
				"Which upstream projects the Overture Places theme drew each row from, and what each of those requires. §3.1 is a statement about this agreement and reaches no other source's terms.",
			],
		},
		sourceCensus: { table: "layer_manifest", column: "source", shape: "manifest" },
	},
	fr: {
		name: "fr",
		description: "French national rooftop address-point database (BAN) — situs-only, no interpolation tier (~6.95 GB).",
		artifacts: [
			{
				remotePath: "street/fr/2026-07-10/situs.db",
				localPath: "ban/address-points-fr.db",
				md5Sidecar: false,
				approxBytes: 6_952_509_440,
			},
		],
		rights: {
			publishers: ["DINUM and IGN, for Base Adresse Nationale"],
			terms: [
				"Licence Ouverte 2.0, the attribution-only half of BAN's dual grant. The text as retrieved on 2026-09-21 is archived at packages/corpus/data/licenses/licence-ouverte-2.0.md.",
			],
			conditions: [
				"Name the source, at minimum the licensor, and the date of the last update — the condition the license states in those words.",
				"Do not suggest the licensor endorses the use.",
			],
			unresolved: [
				"Whether the election of the attribution-only half binds a redistributor of this database, since BAN is dual-licensed and the other half carries share-alike.",
			],
		},
		sourceCensus: { table: "address_point", column: "source", shape: "per-row" },
	},
	us: {
		name: "us",
		description:
			"US national street tier — per-state rooftop address-point (situs) + TIGER interpolation databases, " +
			"50 states + DC + VI (103 files, ~41.3 GB total). Use --only <slug> to pull a single state.",
		artifacts: usStreetArtifacts(),
		rights: {
			publishers: [
				"United States Department of Transportation, for the National Address Database, reaching these rows through the Overture Maps Foundation",
				"119 county and state bodies, for the rows OpenAddresses collected from them, likewise through Overture",
				"United States Census Bureau, for the TIGER/Line interpolation databases in this bundle",
			],
			terms: [
				"National Address Database: a work of the federal government carrying no copyright under 17 U.S.C. § 105, and the same page states it is not intended for use as a mailing list and is subject to state statutes prohibiting that use. The text as retrieved on 2026-09-21 is archived at packages/corpus/data/licenses/national-address-database.md.",
				"OpenAddresses: per-source terms that differ, which THIRD_PARTY_NOTICES.md records as commonly requiring attribution and share-alike. Every row names its contributing body.",
				"TIGER/Line: a work of the United States Government, which carries no copyright under 17 U.S.C. § 105.",
			],
			conditions: [
				"Do not use these rows as a mailing list. That restriction is stated on the National Address Database's own page and arises from state statutes rather than from copyright, so no copyright status discharges it.",
				"Read the terms of the contributing body for the rows you use. The 119 OpenAddresses publishers are not one grant.",
			],
			unresolved: [
				"What each of the 119 contributing bodies requires. The rows name who published them and nothing here records what each one asks.",
				"Which state or local body supplied a given National Address Database row. Those rows read `overture:NAD` and go no further, and the database's own page states it is aggregated from state data which is aggregated from local data.",
				"Which state statutes the mailing-list restriction refers to, and whether any of them reaches a use other than a mailing list.",
			],
		},
		sourceCensus: { table: "address_point", column: "source", shape: "per-row", family: "address-points" },
	},
}

/**
 * One bundle's terms as lines for a terminal, publishers first, then terms,
 * conditions and what stays unresolved.
 *
 * The unresolved lines are printed rather than held back.
 * A bundle whose conditions are listed and whose gaps are not reads as fully established,
 * and an operator deciding whether to take a copy is the reader those gaps are for.
 */
export function describeBundleRights(bundle: DataBundle): string[] {
	const { rights } = bundle

	return [
		`published by ${rights.publishers.join("; ")}`,
		...rights.terms.map((line) => `terms: ${line}`),
		...rights.conditions.map((line) => `you must: ${line}`),
		...rights.unresolved.map((line) => `unresolved: ${line}`),
	]
}

/**
 * Resolve `${base}${artifact.remotePath}` — the one place that string gets built.
 *
 * `baseURL` defaults to the public bucket; `data pull --host` passes a mirror
 * or private registry serving the same object keys (the catalog schema is host-independent —
 * an air-gapped install mirrors the key space rather than a rewritten layout).
 * A missing trailing slash is repaired rather than concatenated into a mangled key.
 */
export function artifactURL(artifact: BundleArtifact, baseURL: string = PUBLIC_BUCKET_BASE_URL): string {
	const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`

	return `${base}${artifact.remotePath}`
}

/**
 * Map a bundle's artifacts against a (possibly `null`) local `releases.json` manifest,
 * resolving each `family`-tagged artifact's {@link BundleArtifact.localPath} to the versioned
 * filename (`resolveDatabasePath`'s naming convention: `<family>/<family>-us-<slug>-<version>.db`)
 * when the manifest pins that family to a version.
 *
 * So a download lands exactly where `resolveDatabasePath` (`data-release.ts`)
 * will find it on the next `mailwoman geocode` run.
 *
 * Artifacts with no `family` (candidate/poi/fr — single fixed-path downloads) pass through unchanged.
 * A family artifact with no matching manifest entry also passes through unchanged
 * (the legacy unversioned path, `resolveDatabasePath`'s fallback).
 *
 * Pure: no filesystem access.
 * This computes the intended destination path.
 *
 * Whether something already exists there (or at a differently-versioned path `resolveDatabasePath` would
 * also accept) is the caller's `existsSync`/ `resolveDatabasePath` check rather than this function's.
 */
export function resolveBundleArtifacts(bundle: DataBundle, manifest: DataReleaseManifest | null): BundleArtifact[] {
	return bundle.artifacts.map((artifact) => {
		if (!artifact.family || !artifact.stateSlug) return artifact

		const version = manifest?.[artifact.family]

		if (!version) return artifact

		return {
			...artifact,
			localPath: `${artifact.family}/${artifact.family}-us-${artifact.stateSlug}-${version}.db`,
		}
	})
}

/**
 * Filter a resolved artifact list to those whose `remotePath`, `localPath`,
 * or `stateSlug` contains `only` (case-insensitive).
 *
 * `undefined`/empty `only` returns `artifacts` unchanged.
 * Lets `data pull us --only nh` target one state instead of the whole 41 GB tier —
 * the CLI-facing complement to the bundle-level granularity above.
 */
export function filterArtifacts(artifacts: readonly BundleArtifact[], only: string | undefined): BundleArtifact[] {
	if (!only) return [...artifacts]

	const needle = only.toLowerCase()

	return artifacts.filter(
		(a) =>
			a.remotePath.toLowerCase().includes(needle) ||
			a.localPath.toLowerCase().includes(needle) ||
			a.stateSlug?.toLowerCase() === needle
	)
}

/**
 * What's on disk for one artifact, gathered by the caller (a `statSync` + optional `md5File`).
 *
 * Kept separate from the gathering itself so {@link needsDownload} stays pure
 * and unit-testable without a filesystem.
 */
export interface LocalArtifactState {
	exists: boolean
	sizeBytes?: number
	md5?: string
}

/**
 * What the remote object currently reports, gathered by the caller (an http head via `APIClient`,
 * and — when {@link BundleArtifact.md5Sidecar} is true — a fetch of the `.md5` sidecar text).
 */
export interface RemoteArtifactState {
	contentLength?: number
	md5?: string
}

/**
 * Decide whether an artifact needs downloading: absent locally → yes.
 *
 * An available md5 (sidecar present) is the authoritative signal once local exists —
 * mismatch → yes, match → no, checked before content-length so a bundle that publishes
 * a sidecar can't be short-circuited by a coincidentally-matching size.
 * With no md5 to compare, fall back to a `Content-Length` size comparison.
 *
 * With neither signal available, the artifact is treated as up to date (the caller is expected to
 * surface a "couldn't verify" warning in that case rather than force a redundant multi-GB re-fetch).
 */
export function needsDownload(local: LocalArtifactState, remote: RemoteArtifactState): boolean {
	if (!local.exists) return true

	if (remote.md5 !== undefined) {
		return local.md5 !== remote.md5
	}

	if (remote.contentLength !== undefined && local.sizeBytes !== undefined) {
		return local.sizeBytes !== remote.contentLength
	}

	return false
}
