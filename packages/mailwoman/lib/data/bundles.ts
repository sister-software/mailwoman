/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { databaseRootPath } from "@mailwoman/core/data-root"
import { summarizeLicense } from "@mailwoman/core/license/obligations"
import type { PathBuilderLike } from "path-ts"

import { US_INTERPOLATION_EXTRACT_VERSION } from "#browser-runtime/resources"
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
	 * Gives the object key relative to {@link PUBLIC_BUCKET_BASE_URL}.
	 */
	remotePath: string

	/**
	 * Gives the destination relative to the data root's `db/` directory.
	 * {@link bundleArtifactPath} resolves it. {@link resolveBundleArtifacts} rewrites
	 * a family-tagged path to its manifest-pinned version.
	 */
	localPath: string

	/**
	 * Reports whether the host publishes a `<remotePath>.md5` sidecar that `data pull` verifies against.
	 */
	md5Sidecar: boolean

	/**
	 * Records the surveyed size in bytes.
	 * Plans and progress output display it.
	 *
	 * `data status` without `--check-remote` compares the local file size against
	 * it exactly, so it must match the published file.
	 */
	approxBytes: number

	/**
	 * Names the release family of a per-state US database.
	 * The release manifest uses it to select the pinned version.
	 */
	family?: "address-points" | "interpolation"

	/**
	 * Gives the lowercase US state or territory slug, such as `ca`.
	 * The `--only` option can match this value.
	 */
	stateSlug?: string
}

/**
 * Optional schema for checking publisher provenance in artifact data.
 */
export interface BundleSourceCensus {
	/**
	 * Names the table whose publisher stamps are tallied.
	 *
	 * The value is the per-record `address_point` table or the one-row `layer_manifest` table.
	 */
	table: "address_point" | "layer_manifest"

	/**
	 * Names the column holding the publisher stamp.
	 * A null value tallies as `unstamped`.
	 */
	column: "source"

	/**
	 * Reports whether a tally counts records (`per-row`) or the single manifest
	 * row of each artifact (`manifest`).
	 */
	shape: "per-row" | "manifest"

	/**
	 * Selects the family to census when a bundle mixes families.
	 * Artifacts from other families count as out of scope.
	 */
	family?: BundleArtifact["family"]
}

/**
 * Describes a bundle's licensing.
 *
 * It records who published the data, its terms, user obligations and open rights questions.
 */
export interface BundleRights {
	publishers: readonly string[]

	/**
	 * The SPDX expression the bundle's artifacts record in their own `layer_manifest`.
	 *
	 * When an artifact records no expression, this registry assigns one from the publishers' stated terms.
	 *
	 * A `LicenseRef-` identifies a grant without a resolved identifier.
	 * It reads as unresolved.
	 *
	 * `mailwoman data pull --refuse` bases its decision on this field.
	 * Once the artifact is on disk, the command prints the artifact's own expression
	 * beside it so readers can see a disagreement.
	 */
	expression: string

	/**
	 * Lists the license terms.
	 * Sources with different terms receive separate entries.
	 */
	terms: readonly string[]

	/**
	 * Lists the obligations the operator must meet.
	 * They print as `you must:` lines.
	 */
	conditions: readonly string[]

	/**
	 * Lists open rights questions.
	 * They print as `unresolved:` lines.
	 */
	unresolved: readonly string[]
}

/**
 * Downloadable data bundle.
 */
export interface DataBundle {
	name: string
	description: string
	artifacts: BundleArtifact[]

	rights: BundleRights

	/**
	 * Gives the artifact field that contains publisher stamps.
	 *
	 * The property is absent when the artifact has no publisher column.
	 */
	sourceCensus?: BundleSourceCensus

	/**
	 * `licensed` for a paid artifact that `data pull` fetches through the license worker with a token.
	 *
	 * Absent for a free bundle on the public bucket.
	 * Every bundle today is free.
	 */
	access?: "licensed"

	/**
	 * The scope entry a token must admit for this bundle, such as `tier:gb-streets`,
	 * and the name the worker's catalog serves it under.
	 * Set on a licensed bundle.
	 */
	tier?: string

	/**
	 * The ISO 3166-1 alpha-2 codes of the countries the bundle resolves further than the base tier does.
	 * The precision-ceiling statement reads it.
	 */
	countries?: readonly string[]
}

const US_STREET_DATABASE_SIZES: Record<string, { situs: number; interp?: number }> = {
	ak: { situs: 78_602_240, interp: 27_258_880 },
	al: { situs: 660_025_344, interp: 260_829_184 },
	ar: { situs: 396_853_248, interp: 204_488_704 },
	az: { situs: 907_603_968, interp: 211_460_096 },
	ca: { situs: 3_471_339_520, interp: 794_341_376 },
	co: { situs: 716_697_600, interp: 220_385_280 },
	ct: { situs: 256_991_232, interp: 96_006_144 },
	dc: { situs: 119_889_920, interp: 7_565_312 },
	de: { situs: 125_595_648, interp: 29_622_272 },
	fl: { situs: 3_226_046_464, interp: 522_002_432 },
	ga: { situs: 173_764_608, interp: 371_814_400 },
	hi: { situs: 77_320_192, interp: 13_447_168 },
	ia: { situs: 358_260_736, interp: 197_267_456 },
	id: { situs: 93_683_712, interp: 84_283_392 },
	il: { situs: 1_134_772_224, interp: 380_829_696 },
	in: { situs: 767_078_400, interp: 307_281_920 },
	ks: { situs: 240_205_824, interp: 151_560_192 },
	ky: { situs: 545_275_904, interp: 296_521_728 },
	la: { situs: 63_488_000, interp: 168_333_312 },
	ma: { situs: 865_357_824, interp: 166_559_744 },
	md: { situs: 594_812_928, interp: 150_126_592 },
	me: { situs: 165_101_568, interp: 87_293_952 },
	mi: { situs: 229_376_000, interp: 312_545_280 },
	mn: { situs: 646_877_184, interp: 274_706_432 },
	mo: { situs: 399_859_712, interp: 311_136_256 },
	ms: { situs: 271_257_600, interp: 178_659_328 },
	mt: { situs: 146_735_104, interp: 89_899_008 },
	nc: { situs: 1_380_876_288, interp: 520_089_600 },
	nd: { situs: 103_890_944, interp: 78_532_608 },
	ne: { situs: 187_617_280, interp: 105_988_096 },
	nh: { situs: 20_480, interp: 58_322_944 },
	nj: { situs: 932_855_808, interp: 169_963_520 },
	nm: { situs: 249_671_680, interp: 85_282_816 },
	nv: { situs: 6_553_600, interp: 71_282_688 },
	ny: { situs: 1_440_923_648, interp: 323_432_448 },
	oh: { situs: 1_248_694_272, interp: 412_696_576 },
	ok: { situs: 354_828_288, interp: 166_379_520 },
	or: { situs: 1_034_625_024, interp: 176_451_584 },
	pa: { situs: 269_873_152, interp: 490_303_488 },
	ri: { situs: 79_159_296, interp: 29_446_144 },
	sc: { situs: 47_661_056, interp: 259_309_568 },
	sd: { situs: 21_811_200, interp: 73_175_040 },
	tn: { situs: 887_808_000, interp: 370_663_424 },
	tx: { situs: 2_568_024_064, interp: 736_587_776 },
	ut: { situs: 363_622_400, interp: 87_908_352 },
	va: { situs: 933_728_256, interp: 377_995_264 },
	vi: { situs: 618_496 },
	vt: { situs: 72_945_664, interp: 59_269_120 },
	wa: { situs: 735_141_888, interp: 272_322_560 },
	wi: { situs: 340_619_264, interp: 188_428_288 },
	wv: { situs: 227_700_736, interp: 121_982_976 },
	wy: { situs: 51_003_392, interp: 38_330_368 },
}

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
				remotePath: `street/us/${slug}/${US_INTERPOLATION_EXTRACT_VERSION}/interp.db`,
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
			"Global admin candidate gazetteer — population-first place resolution + postcode coverage across 244 countries.",
		artifacts: [
			{
				remotePath: "gazetteer/2026-08-25b/candidate.db",
				localPath: "wof/candidate.db",
				md5Sidecar: false,
				approxBytes: 2_880_921_600,
			},
		],
		rights: {
			publishers: [
				"Who's On First",
				"GeoNames",
				"Overture Maps Foundation, for its Divisions theme",
				"OpenStreetMap contributors, for the Northern Ireland postcode fold",
			],
			// The published artifact's own `layer_manifest.license`, read over HTTP range requests on 2026-09-27.
			expression: "ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0",
			terms: [
				"Who's On First: Creative Commons Zero covers the format and structure, in those words, and the dataset is also a modification of existing open data whose sources carry their own terms. The text as retrieved on 2026-09-21 is archived at packages/corpus/data/licenses/whosonfirst-licenses.md.",
				"GeoNames: Creative Commons Attribution 4.0, the version its export readme names. Its about page names the license without a version. Both as retrieved on 2026-09-21, archived at packages/corpus/data/licenses/geonames-publication.md.",
				"Overture Maps Divisions: the Open Database License. Overture's attribution page gives its Divisions theme `License for theme: ODbL`, read 2026-09-25. The published artifact's own layer_manifest records `license = ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0` and derives from admin-global-priority@2026-08-25, read over HTTP range requests on 2026-09-27. The admin gazetteer under that name folds Overture Divisions. On the lab host's 2026-09-15 chain, where each fold's synthetic id range makes the rows countable, Overture Divisions contributed 1,590,314 of 4,921,635 admin places, 32.31%, and all 1,590,314 reach that chain's candidate database as 18.25% of its 8,714,235 places.",
				"OpenStreetMap, for the Northern Ireland postcode fold: the Open Database License, with the credit `© OpenStreetMap contributors` and https://www.openstreetmap.org/copyright. The fold is an independent part of a collective database, so the license governs the fold and the rest of the file keeps its own terms. Read-only queries against the published artifact on 2026-10-17 found 9,514 fold rows for 4,757 places, ids 9800000000000 to 9800000004756, whose names, coordinates and bounding boxes equal the rows of postalcode-ni-osm-2026-08-05.db. They carry region 0, population 0 and no importance or name role. No row outside the fold shares a name key or a coordinate with them, and the fold has no row in candidate_ancestor or candidate_interval. The fold step runs after every pass over the admin rows and reads no other row. The fold is published by itself under the Open Database License, as the section 4.6 offer, at https://huggingface.co/datasets/sister-software/mailwoman-osm-ni-postcode-fold. The 22 Prague district rows from GeoNames share the ids 9800000000000 to 9800000000021 with the fold because both builders used one id base at the build revision 2b9894111, and they are excluded from that dataset by country and placetype.",
			],
			conditions: [
				"Link back to the Who's On First license. Its own text makes the link required and crediting the project recommended, which is the one place those two differ.",
				"Attribute GeoNames.",
				"Credit OpenStreetMap contributors for the Northern Ireland postcode fold, and keep the Open Database License on that fold and on any database derived from it.",
				"Read the Open Database License before redistributing this database or a database derived from it. Its share-alike term for the Overture Divisions rows is the first unresolved question below.",
			],
			unresolved: [
				"Whether the Open Database License's share-alike term reaches the rest of this database through the Overture Divisions rows. The expression on the artifact records ODbL-1.0, and what that requires of a redistributor depends on whether those rows form a Derivative Database with the others, an independent part of a Collective Database, or an extraction below the threshold the license sets. The Northern Ireland postcode fold is settled in the terms above.",
				"Whether the published 2026-08-25 artifact carries the same Overture share as the 2026-09-15 chain measured above, and which Overture Divisions release reached it. Its manifest names its admin source but not that source's own sources, and the 2026-08-25 admin gazetteer is not published, so answering either needs the 2.88 GB download.",
				"Which Overture record each of those places came from. `fold-overture` writes a concordance under `wd:id` alone and discards the GERS id, so no row here can be traced back to its Overture division. That bears on whether an alteration file is producible.",
				"Which upstream project each row's name came from. Who's On First records a geometry source per record and the corpus adapters read none of it — see docs/engineering/reference/artifact-rights-inventory.mdx.",
				"Whether the Ordnance Survey notice in Who's On First's source list reaches any row in this bundle. The list names Ordnance Survey of Northern Ireland under Open Government Licence v3.0 and Ordnance Survey Ireland under its own portal terms, and names Royal Mail nowhere.",
				"Which of the 102 sources the Who's On First list names contributed to a given record. The list was generated 2020-02-21 and the dataset has moved since, so it is evidence of what contributed up to that date.",
			],
		},
	},
	poi: {
		name: "poi",
		description: "Overture-places POI layer, covering the United States, Canada, Mexico and France.",
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
			// The artifact's own `layer_manifest.license`, measured on the lab host's copy 2026-09-27.
			expression: "CDLA-Permissive-2.0",
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
		description:
			"French national rooftop address-point database (BAN), with situs points only and no interpolation tier.",
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
			// Assigned from the elected half of BAN's dual grant.
			// The lab host's copy of the artifact has no `layer_manifest`, measured 2026-09-27.
			expression: "etalab-2.0",
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
			"US national street tier — per-state rooftop address-point (situs) and TIGER interpolation databases. " +
			"Use --only <slug> to pull a single state.",
		artifacts: usStreetArtifacts(),
		rights: {
			publishers: [
				"United States Department of Transportation, for the National Address Database, reaching these rows through the Overture Maps Foundation",
				"119 county and state bodies, for the rows OpenAddresses collected from them, likewise through Overture",
				"United States Census Bureau, for the TIGER/Line interpolation databases in this bundle",
			],
			// Assigned from the publishers' stated terms.
			// The lab host's per-state copies have no `layer_manifest`, measured 2026-09-27.
			// `LicenseRef-OpenAddresses-PerSource` stands for the 119 contributing bodies' own terms.
			// No one has resolved those per source, so the expression reads as unresolved.
			expression: "LicenseRef-USGov-Public-Domain AND LicenseRef-OpenAddresses-PerSource",
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
 * The obligations an SPDX expression implies, for a terminal line.
 */
function describeExpression(expression: string): string {
	const summary = summarizeLicense(expression)
	const obligations = summary.obligations.length ? summary.obligations.join(", ") : "none recorded"

	return summary.unrecognized.length
		? `${expression} — obligations: ${obligations}; ${summary.unrecognized.join(", ")} resolve(s) to no recorded obligations`
		: `${expression} — obligations: ${obligations}`
}

/**
 * Format publishers, terms, conditions, unresolved rights questions
 * and the recorded expression for terminal output.
 *
 * The prose contains publisher names and conditions no manifest holds.
 * The expression line states the implication of {@link BundleRights.expression}.
 *
 * A pull uses it to decide when the artifact is not yet on disk.
 */
export function describeBundleRights(bundle: DataBundle): string[] {
	const { rights } = bundle

	return [
		`published by ${rights.publishers.join("; ")}`,
		...rights.terms.map((line) => `terms: ${line}`),
		...rights.conditions.map((line) => `you must: ${line}`),
		...rights.unresolved.map((line) => `unresolved: ${line}`),
		`recorded expression: ${describeExpression(rights.expression)}`,
	]
}

/**
 * The license data found for one bundle artifact on this machine.
 */
export interface ArtifactTermsObservation {
	path: string
	/**
	 * `absent` means the file is not on disk.
	 *
	 * `unmanifested` means it has no `layer_manifest`.
	 * `unreadable` means opening it failed.
	 * `recorded` means the manifest was read.
	 */
	state: "absent" | "unmanifested" | "unreadable" | "recorded"
	tier?: string
	license?: string
	error?: string
}

/**
 * Format what the bundle's artifacts on disk record, beside what the registry records.
 *
 * Artifacts are grouped by their recorded values, so a bundle of a hundred files
 * prints a line per distinct answer rather than per file.
 * A difference between an artifact's expression and the registry's expression
 * is the finding this report prints.
 *
 * The artifact is authoritative for its expression.
 */
export function describeArtifactTerms(bundle: DataBundle, observations: readonly ArtifactTermsObservation[]): string[] {
	const groups = new Map<string, { count: number; example: ArtifactTermsObservation }>()

	for (const observation of observations) {
		const key = [observation.state, observation.tier ?? "", observation.license ?? "", observation.error ?? ""].join(
			"\0"
		)

		const group = groups.get(key)

		if (group) {
			group.count++
		} else {
			groups.set(key, { count: 1, example: observation })
		}
	}

	const lines: string[] = []

	for (const { count, example } of groups.values()) {
		const subject = count === 1 ? example.path : `${count} artifacts, such as ${example.path}`

		switch (example.state) {
			case "absent":
				lines.push(`not on disk: ${subject}; the recorded expression above is what a pull would take on`)

				break
			case "unmanifested":
				lines.push(`on disk: ${subject} carries no layer_manifest, so it states no terms of its own`)

				break
			case "unreadable":
				lines.push(`on disk: ${subject} could not be read: ${example.error}`)

				break
			case "recorded": {
				const license = example.license ?? ""

				lines.push(
					`on disk: ${subject} records tier ${example.tier ?? "absent"}, license ${describeExpression(license)}`
				)

				if (license !== bundle.rights.expression) {
					lines.push(
						`disagreement: the artifact records ${license || "no expression"} while this registry records ` +
							`${bundle.rights.expression}; the artifact is the authority for what it carries`
					)
				}
			}
		}
	}

	return lines
}

/**
 * Resolve an artifact URL against the public bucket or a compatible mirror.
 */
export function artifactURL(artifact: BundleArtifact, baseURL: string = PUBLIC_BUCKET_BASE_URL): string {
	const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`

	return `${base}${artifact.remotePath}`
}

/**
 * Rewrites family-tagged per-state artifacts to the local paths of the versions
 * pinned in `manifest`, leaving other artifacts unchanged.
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
 * Filters artifacts to those whose remote or local path contains `only` or whose state
 * slug equals it, case-insensitively, returning all artifacts when `only` is absent.
 */
export function filterArtifacts(artifacts: readonly BundleArtifact[], only: string | null): BundleArtifact[] {
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
 * Decides whether an artifact needs downloading.
 *
 * It compares MD5 when the remote has one and compares size otherwise.
 *
 * It returns `false` when neither can be compared, so callers should report
 * that the artifact was not verified.
 */
export function needsDownload(local: LocalArtifactState, remote: RemoteArtifactState): boolean {
	if (!local.exists) return true

	if (remote.md5) {
		return local.md5 !== remote.md5
	}

	if (remote.contentLength && local.sizeBytes) {
		return local.sizeBytes !== remote.contentLength
	}

	return false
}
