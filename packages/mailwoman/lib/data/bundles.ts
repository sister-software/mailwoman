/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Registry of downloadable public-data artifacts, local paths, and rights metadata. Data commands handle I/O.
 */

import { databaseRootPath } from "@mailwoman/core/data-root"
import type { PathBuilderLike } from "path-ts"

import type { DataReleaseManifest } from "#data/release"

/**
 * Public artifact host.
 */
export const PUBLIC_BUCKET_BASE_URL = "https://public.mailwoman.ai/mailwoman/"

/**
 * One downloadable file within a {@link DataBundle}.
 */
export interface BundleArtifact {
	/**
	 * Object key relative to {@link PUBLIC_BUCKET_BASE_URL}.
	 */
	remotePath: string
	/**
	 * Destination relative to the data root's `db/` directory.
	 *
	 * Resolve it with {@link bundleArtifactPath}.
	 * Family-tagged artifacts may use a manifest-pinned versioned path.
	 */
	localPath: string
	/**
	 * Whether an MD5 sidecar is available.
	 */
	md5Sidecar: boolean
	/**
	 * Approximate byte size for plans and status output; not an integrity check.
	 */
	approxBytes: number
	/**
	 * Release family for per-state US databases.
	 */
	family?: "address-points" | "interpolation"
	/**
	 * State or territory slug for this artifact.
	 */
	stateSlug?: string
}

/**
 * Publishers, terms, conditions, and unresolved rights questions for a bundle.
 */
/**
 * Optional schema for checking publisher provenance in artifact data.
 */
export interface BundleSourceCensus {
	/**
	 * Table containing per-record or layer-level provenance.
	 */
	table: "address_point" | "layer_manifest"
	/**
	 * Publisher column.
	 */
	column: "source"
	/**
	 * Whether the table has one row per record or one row per artifact.
	 */
	shape: "per-row" | "manifest"
	/**
	 * Artifact family when a bundle contains multiple families.
	 */
	family?: BundleArtifact["family"]
}

export interface BundleRights {
	/**
	 * Publisher names.
	 */
	publishers: readonly string[]
	/**
	 * Publisher terms, one entry per source where needed.
	 */
	terms: readonly string[]
	/**
	 * Operator obligations.
	 */
	conditions: readonly string[]
	/**
	 * Unresolved rights questions.
	 */
	unresolved: readonly string[]
}

/**
 * Named downloadable data bundle.
 */
export interface DataBundle {
	name: string
	description: string
	artifacts: BundleArtifact[]
	/**
	 * Required rights metadata.
	 */
	rights: BundleRights
	/**
	 * Optional publisher-provenance census schema.
	 */
	sourceCensus?: BundleSourceCensus
}

/**
 * Approximate sizes of hosted state street databases.
 * `vi` has no interpolation artifact.
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
 * Build US street-artifact entries from the size table.
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
 * Downloadable data bundles and their rights metadata.
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
 * Format publishers, terms, conditions, and unresolved rights questions for terminal output.
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
 * Resolve an artifact URL against the public bucket or a compatible mirror.
 */
export function artifactURL(artifact: BundleArtifact, baseURL: string = PUBLIC_BUCKET_BASE_URL): string {
	const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`

	return `${base}${artifact.remotePath}`
}

/**
 * Apply manifest-pinned versions to family-tagged artifact paths.
 *
 * Fixed-path artifacts and unpinned families are unchanged.
 * This function performs no filesystem checks.
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
 * Resolve an artifact's local path under the data root's `db/` directory.
 */
export function bundleArtifactPath(dataRoot: PathBuilderLike, artifact: BundleArtifact): string {
	return databaseRootPath(dataRoot)(artifact.localPath).toString()
}

/**
 * Filter artifacts by remote path, local path, or state slug.
 * An absent filter returns all artifacts.
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
 * Local artifact state used by the pure {@link needsDownload} check.
 */
export interface LocalArtifactState {
	exists: boolean
	sizeBytes?: number
	md5?: string
}

/**
 * Remote size and optional MD5 metadata.
 */
export interface RemoteArtifactState {
	contentLength?: number
	md5?: string
}

/**
 * Check whether an artifact needs downloading: prefer MD5 comparison, then size.
 *
 * If neither is available, assume it is current; callers should report that verification was unavailable.
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
