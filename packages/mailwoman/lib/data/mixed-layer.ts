// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The sources inside a data layer whose license is a mixed expression, each with the terms its
 *   publisher's register row records.
 *
 *   A mixed layer's `layer_manifest` records one expression, such as `LicenseRef-US-Mixed`, for rows
 *   that come from thousands of publishers under their own terms. The layer's per-region
 *   `ATTRIBUTION.json` ledgers list those publishers' sources and record counts, and the address-source
 *   register records each publisher's decision. This module joins the two, so the data bill of materials,
 *   `mailwoman doctor` and the attribution notice report the same per-source reading.
 *
 *   A source the register doesn't cover is described as uncovered and kept, never dropped.
 *   Its obligations read `unknown`, because no record states what its publisher requires.
 */

import type { APIClient } from "@mailwoman/core/api"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { stringifyJSON } from "@mailwoman/core/json"
import type { TermsStatement } from "@mailwoman/core/license/decision"
import { licenseIdentifiers, LicenseObligation, summarizeLicense } from "@mailwoman/core/license/obligations"
import { mentionsShareAlike, readLicenseRecord } from "@mailwoman/core/license/record"
import type { ReleaseConfig } from "@mailwoman/core/release-config"
import { RegisterTermsBasis, type RegisterRowTerms } from "@mailwoman/corpus/source-register/terms"
import {
	readUSAddressSourceTerms,
	type USAddressSourceTermsReader,
} from "@mailwoman/corpus/us/address-records/source-terms"
import {
	ADDRESS_LAYER_ATTRIBUTION_FILE,
	type AddressLayerAttribution,
} from "@mailwoman/resolver-wof-sqlite/address/keys/attribution"
import type { AddressLayerCountryManifest } from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { PUBLIC_BUCKET_BASE_URL } from "#data/bundles"

/**
 * Whether a license expression contains a mixed identifier, `LicenseRef-<name>-Mixed`,
 * whose obligations are those of the sources inside the layer rather than of one license.
 */
export function isMixedLicenseExpression(expression: string): boolean {
	return licenseIdentifiers(expression).some((identifier) => /^LicenseRef-.+-Mixed$/u.test(identifier))
}

/**
 * How far one obligation of one source is established.
 */
const ObligationState = {
	/**
	 * The terms the register read impose it.
	 */
	Required: "required",
	/**
	 * OpenAddresses' summary of the publisher's terms records it, and the register's reading imposes `none`.
	 *
	 * That summary is a third party's, so the notice credits the publisher without
	 * the register asserting a duty.
	 */
	Recorded: "recorded",
	None: "none",
	/**
	 * The register records no reading of the publisher's terms for it,
	 * or the terms are in words no table reads.
	 */
	Unknown: "unknown",
} as const

export type ObligationState = (typeof ObligationState)[keyof typeof ObligationState]

/**
 * The obligation classes a mixed layer's sources are counted by, most demanding first.
 */
export const ObligationClass = {
	Unknown: "unknown",
	ShareAlike: "share-alike",
	Attribution: "attribution",
	AttributionRecorded: "attribution recorded by OpenAddresses",
	None: "none",
} as const

export type ObligationClass = (typeof ObligationClass)[keyof typeof ObligationClass]

/**
 * The terms an OpenAddresses source definition records, as the layer's ledger stores them.
 */
export interface OpenAddressesRecordedTerms {
	attribution: boolean | null
	attributionName: string | null
	shareAlike: boolean | null
}

/**
 * One source inside a mixed layer, summed over the regions that hold its rows.
 */
export interface MixedLayerSource {
	/**
	 * The wire source id, such as `usgov-nad` or `openaddresses:us/wi/statewide`.
	 */
	source: string
	records: number
	/**
	 * The regions holding the source's rows, in code-point order.
	 */
	regions: string[]
	/**
	 * The license `lookup.db`'s `source` table records for the source, or `null` when it records none.
	 */
	recordedLicense: string | null
	openAddresses: OpenAddressesRecordedTerms | null
	/**
	 * The register rows the source maps to, empty when the register doesn't cover it.
	 */
	rows: readonly RegisterRowTerms[]
	/**
	 * The publisher as the register spells it, else as OpenAddresses records its credit, else `null`.
	 */
	publisher: string | null
	/**
	 * The row that decides the source's reading: a row that refuses, is unread
	 * or is missing decides, and otherwise the publishing body's own row, the table's first.
	 *
	 * `null` when the register doesn't cover the source.
	 */
	deciding: RegisterRowTerms | null
	/**
	 * The ground the deciding row gives, `unregistered` for a source the register doesn't cover.
	 */
	basis: RegisterTermsBasis
	statement: TermsStatement | null
	termsURL: string | null
	spdx: string | null
	attribution: ObligationState
	shareAlike: ObligationState
	/**
	 * The credit a notice prints, or `null` when the source owes none.
	 */
	attributionText: string | null
	obligationClass: ObligationClass
}

/**
 * A mixed layer at one version, with every source its ledgers list.
 */
export interface MixedLayerDescription {
	/**
	 * The layer's id, such as `addresses-us`.
	 */
	id: string
	license: string
	country: string
	version: string
	/**
	 * The manifest's path relative to the layer root, such as `addresses/us/2026-11-13/manifest.json`.
	 */
	manifestPath: string
	/**
	 * Where the attribution notice sits beside the manifest, relative to the layer root.
	 */
	noticePath: string
	regions: number
	records: number
	sources: MixedLayerSource[]
}

/**
 * Reads a layer's files by their paths relative to a layer root: a data root's `db/`, or the public bucket.
 */
export interface LayerFileReader {
	/**
	 * The root as a document records it: `$MAILWOMAN_DATA_ROOT/db/` or the bucket's base URL.
	 */
	origin: string
	/**
	 * Parses one JSON file.
	 *
	 * @throws When the file is absent or unreadable, naming it.
	 */
	readJSON(relativePath: string): Promise<unknown>
	exists(relativePath: string): Promise<boolean>
}

/**
 * Reads a layer under a data root's `db/` directory.
 */
export function localLayerFileReader(root: PathBuilderLike): LayerFileReader {
	return {
		origin: "$MAILWOMAN_DATA_ROOT/db/",
		readJSON: (relativePath) => readLocalJSONFile<unknown>(resolvePath(root, relativePath)),
		exists: (relativePath) => pathExists(resolvePath(root, relativePath)),
	}
}

/**
 * The status the bucket answers for an object it doesn't hold.
 *
 * `exists` reads it as absent and throws every other refusal, such as the firewall's 403.
 */
const HTTP_NOT_FOUND = 404

/**
 * Reads a published layer from the public bucket.
 *
 * The client must send the CLI's `X-Mailwoman-Client` header.
 * The bucket's rule requires it of a layer request.
 */
export function bucketLayerFileReader(client: APIClient, base: string = PUBLIC_BUCKET_BASE_URL): LayerFileReader {
	return {
		origin: base,
		readJSON: async (relativePath) =>
			(await client.fetch<unknown>({ method: "get", url: `${base}${relativePath}` })).data,
		exists: async (relativePath) => {
			try {
				await client.fetch({ method: "head", url: `${base}${relativePath}` })

				return true
			} catch (error) {
				if ((error as { status?: number }).status === HTTP_NOT_FOUND) return false

				throw error
			}
		},
	}
}

/**
 * The mixed address layers a release serves, by the versions `release.config.json`'s `addressLayers` pins.
 *
 * A listable layer whose country the config pins no version for is returned with
 * `version: null`, so a caller records it as unread rather than leaving it out.
 */
export function servedMixedAddressLayers(
	config: Pick<ReleaseConfig, "addressLayers">
): Array<{ license: string; country: string; version: string | null }> {
	return listableMixedAddressLayers().map((layer) => ({
		...layer,
		version: config.addressLayers?.[layer.country] ?? null,
	}))
}

/**
 * Every mixed identifier whose address layer this module can list by source, with the layer's country.
 */
export function listableMixedAddressLayers(): Array<{ license: string; country: string }> {
	return Object.entries(MIXED_ADDRESS_LAYERS).map(([license, { country }]) => ({ license, country }))
}

/**
 * The name of the attribution notice beside a mixed layer's manifest.
 */
export const ATTRIBUTION_NOTICE_FILE = "NOTICE.txt"

/**
 * The mixed identifiers whose layers this module can list by source, with the country of
 * the address layer each one names and the reader that joins its sources to the register.
 */
const MIXED_ADDRESS_LAYERS: Readonly<
	Record<string, { country: string; readTerms: () => Promise<USAddressSourceTermsReader> }>
> = {
	"LicenseRef-US-Mixed": { country: "US", readTerms: () => readUSAddressSourceTerms() },
}

/**
 * The address layer a mixed identifier names, or `null` when no per-source reader exists for it.
 */
export function mixedAddressLayerOf(license: string): { license: string; country: string } | null {
	return Object.hasOwn(MIXED_ADDRESS_LAYERS, license)
		? { license, country: MIXED_ADDRESS_LAYERS[license]!.country }
		: null
}

const dirnameOf = (path: string): string => path.slice(0, path.lastIndexOf("/"))

function readOpenAddressesRecorded(recorded: unknown): OpenAddressesRecordedTerms | null {
	if (!recorded || typeof recorded !== "object") return null

	const fields = recorded as Record<string, unknown>
	const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null)
	const name = fields["attribution name"]

	return {
		attribution: flag(fields.attribution),
		attributionName: typeof name === "string" && name.trim() ? name.trim() : null,
		shareAlike: flag(fields["share-alike"]),
	}
}

const BLOCKING: ReadonlySet<RegisterTermsBasis> = new Set([
	RegisterTermsBasis.Refused,
	RegisterTermsBasis.Unregistered,
	RegisterTermsBasis.Unread,
])

/**
 * One register row's attribution and share-alike states.
 */
function rowObligations(row: RegisterRowTerms): { attribution: ObligationState; shareAlike: ObligationState } {
	switch (row.basis) {
		case RegisterTermsBasis.OpenLicense: {
			const summary = summarizeLicense(row.spdx!)

			if (!summary.recognized) return { attribution: ObligationState.Unknown, shareAlike: ObligationState.Unknown }

			const state = (obligation: LicenseObligation) =>
				summary.obligations.includes(obligation) ? ObligationState.Required : ObligationState.None

			return { attribution: state(LicenseObligation.Attribution), shareAlike: state(LicenseObligation.ShareAlike) }
		}

		case RegisterTermsBasis.NoRestrictingTerms:
			return { attribution: ObligationState.None, shareAlike: ObligationState.None }

		// A grant whose terms cite a share-alike license without its version, such as `CC-BY-SA`, owes
		// attribution and share-alike under every version, so those two obligations are known.
		case RegisterTermsBasis.PublisherGrant:
			return row.electedTerms && mentionsShareAlike(readLicenseRecord(row.electedTerms))
				? { attribution: ObligationState.Required, shareAlike: ObligationState.Required }
				: { attribution: ObligationState.Unknown, shareAlike: ObligationState.Unknown }

		default:
			return { attribution: ObligationState.Unknown, shareAlike: ObligationState.Unknown }
	}
}

/**
 * The class a source is counted under: an unknown obligation first, then share-alike, then attribution.
 */
export function obligationClassOf(source: Pick<MixedLayerSource, "attribution" | "shareAlike">): ObligationClass {
	if (source.attribution === ObligationState.Unknown || source.shareAlike === ObligationState.Unknown) {
		return ObligationClass.Unknown
	}

	if (source.shareAlike !== ObligationState.None) return ObligationClass.ShareAlike

	if (source.attribution === ObligationState.Required) return ObligationClass.Attribution

	if (source.attribution === ObligationState.Recorded) return ObligationClass.AttributionRecorded

	return ObligationClass.None
}

interface LedgerTally {
	records: number
	regions: Set<string>
	recordedLicense: string | null
	recorded: unknown
}

/**
 * Describes one source from its summed ledger entries and its register terms.
 */
function describeSource(source: string, tally: LedgerTally, terms: USAddressSourceTermsReader): MixedLayerSource {
	const { rows } = terms(source)
	const openAddresses = readOpenAddressesRecorded(tally.recorded)
	const deciding = rows.find((row) => BLOCKING.has(row.basis)) ?? rows[0]

	// The table lists the publishing body's row first and the aggregator the rows
	// reached the layer through after it.
	// OpenAddresses and Overture grant no license of their own over address rows:
	// each row holds its source's grant.
	// So the body's reading sets the obligations, and an aggregator's row decides only when it blocks.
	const states = deciding
		? rowObligations(deciding)
		: { attribution: ObligationState.Unknown, shareAlike: ObligationState.Unknown }

	let { attribution, shareAlike } = states

	if (attribution === ObligationState.None && openAddresses?.attribution) {
		attribution = ObligationState.Recorded
	}

	if (shareAlike === ObligationState.None && openAddresses?.shareAlike) {
		shareAlike = ObligationState.Recorded
	}

	const publisher =
		deciding?.publisher ?? rows.find((row) => row.publisher)?.publisher ?? openAddresses?.attributionName ?? null

	return {
		source,
		records: tally.records,
		regions: [...tally.regions].toSorted(),
		recordedLicense: tally.recordedLicense,
		openAddresses,
		rows,
		publisher,
		deciding: deciding ?? null,
		basis: deciding?.basis ?? RegisterTermsBasis.Unregistered,
		statement: deciding?.statement ?? null,
		termsURL: deciding?.termsURL ?? null,
		spdx: deciding?.spdx ?? null,
		attribution,
		shareAlike,
		attributionText:
			attribution === ObligationState.None ? null : (openAddresses?.attributionName ?? publisher ?? null),
		obligationClass: obligationClassOf({ attribution, shareAlike }),
	}
}

/**
 * Lists every source of one mixed address layer version, read through `read`.
 *
 * @param terms The register join for the layer's license, read once when absent.
 * @throws When the manifest or a region's ledger can't be read, or
 * when the license has no per-source reader.
 * A region whose ledger is missing would make the layer's sources look fewer than they are.
 */
export async function describeMixedAddressLayer(options: {
	license: string
	version: string
	read: LayerFileReader
	terms?: USAddressSourceTermsReader
}): Promise<MixedLayerDescription> {
	const layer = MIXED_ADDRESS_LAYERS[options.license]

	if (!layer) throw new Error(`no per-source reader exists for ${stringifyJSON(options.license)}`)

	const directory = `addresses/${layer.country.toLowerCase()}/${options.version}`
	const manifestPath = `${directory}/manifest.json`
	const manifest = (await options.read.readJSON(manifestPath)) as AddressLayerCountryManifest
	const terms = options.terms ?? (await layer.readTerms())
	const tallies = new Map<string, LedgerTally>()

	for (const region of manifest.regions) {
		const ledgerPath = `${dirnameOf(region.lookup.path)}/${ADDRESS_LAYER_ATTRIBUTION_FILE}`
		const entries = (await options.read.readJSON(ledgerPath)) as AddressLayerAttribution[]

		if (!Array.isArray(entries)) throw new Error(`${ledgerPath} is not a list of sources`)

		for (const entry of entries) {
			let tally = tallies.get(entry.source)

			if (!tally) {
				tally = { records: 0, regions: new Set(), recordedLicense: null, recorded: null }
				tallies.set(entry.source, tally)
			}

			tally.records += entry.records
			tally.regions.add(region.region)
			tally.recordedLicense ??= entry.license
			tally.recorded ??= entry.recorded
		}
	}

	const sources = [...tallies]
		.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([source, tally]) => describeSource(source, tally, terms))

	return {
		id: `addresses-${layer.country.toLowerCase()}`,
		license: options.license,
		country: layer.country,
		version: options.version,
		manifestPath,
		noticePath: `${directory}/${ATTRIBUTION_NOTICE_FILE}`,
		regions: manifest.regions.length,
		records: sources.reduce((sum, source) => sum + source.records, 0),
		sources,
	}
}

/**
 * The count of sources and of records in each obligation class, every class present, most demanding first.
 */
export function tallyObligationClasses(
	description: Pick<MixedLayerDescription, "sources">
): Array<{ obligationClass: ObligationClass; sources: number; records: number }> {
	return Object.values(ObligationClass).map((obligationClass) => {
		const members = description.sources.filter((source) => source.obligationClass === obligationClass)

		return {
			obligationClass,
			sources: members.length,
			records: members.reduce((sum, source) => sum + source.records, 0),
		}
	})
}

/**
 * The attribution notice for one mixed layer version: every credit its sources require or record,
 * and every source whose terms are unknown, so a customer serving the layer ships one text.
 *
 * The text is deterministic: sources are in source-id order and the notice holds no timestamp.
 */
export function renderAttributionNotice(description: MixedLayerDescription): string {
	const credited = description.sources.filter(
		(source) => source.attribution === ObligationState.Required || source.attribution === ObligationState.Recorded
	)

	const unknown = description.sources.filter((source) => source.obligationClass === ObligationClass.Unknown)

	const shareAlike = description.sources.filter(
		(source) => source.shareAlike === ObligationState.Required || source.shareAlike === ObligationState.Recorded
	)

	const line = (source: MixedLayerSource) =>
		`  ${source.attributionText ?? source.publisher ?? "(no publisher recorded)"} [${source.source}]` +
		(source.obligationClass === ObligationClass.Unknown && source.openAddresses?.attribution
			? " (its OpenAddresses definition records a credit)"
			: "")

	const lines = [
		`Attribution notice for the Mailwoman ${description.country} address layer, version ${description.version}`,
		`License: ${description.license}. The layer combines ${description.sources.length.toLocaleString("en-US")} sources ` +
			`under their publishers' own terms. Ship this notice with any copy or service of the layer's data.`,
		"",
		`Sources whose terms require credit (${credited.filter((source) => source.attribution === ObligationState.Required).length}) ` +
			`or whose OpenAddresses definition records a credit (${credited.filter((source) => source.attribution === ObligationState.Recorded).length}):`,
		...credited.map(line),
		"",
	]

	if (shareAlike.length) {
		lines.push(
			`Sources under share-alike terms (${shareAlike.length}). A database derived from their rows is offered under the same terms:`,
			...shareAlike.map(line),
			""
		)
	}

	lines.push(
		`Sources whose terms the register has not established (${unknown.length}). Their publishers' terms may require credit or restrict use:`,
		...unknown.map(line),
		"",
		"Generated by `mailwoman situs attribution-manifest` from the layer's ATTRIBUTION.json ledgers and the Mailwoman",
		"address-source register. The data bill of materials lists each source's decision, basis and terms URL.",
		""
	)

	return lines.join("\n")
}
