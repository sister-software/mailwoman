/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `openaddresses`: line-delimited GeoJSON adapter for openaddresses.io exports.
 *
 * Country must be explicit because OpenAddresses organizes files by country while the row data
 * has no country code. A per-row `LICENSE` property wins where present and the configured
 * `defaultLicense` covers the remaining rows. `district` stays unmapped because US data uses it for a borough or county.
 * The adapter omits that field because mapping it would inflate alignment quarantine.
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { tryParsingJSON } from "@mailwoman/core/json"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { createLicenseVerdictCache, LicensePolicy } from "#utils"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const OPENADDRESSES_ADAPTER_ID = "openaddresses"
/**
 * License assigned to each row from this source (CC-BY-4.0), so downstream consumers
 * inherit the terms rather than having to look them up.
 */
export const OPENADDRESSES_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * Subset of OpenAddresses Feature properties the adapter inspects.
 *
 * The runtime accepts uppercase or lowercase keys.
 * This interface documents the canonical lowercase form after normalization.
 */
interface OaProperties {
	hash?: string
	id?: string
	number?: string
	street?: string
	unit?: string
	city?: string
	district?: string
	region?: string
	postcode?: string
	license?: string
}

/**
 * Return a lowercase-keyed view of a Feature's properties so case variants both work.
 */
function normalizeProperties(raw: unknown): OaProperties {
	if (!raw || typeof raw !== "object") return {}
	const out: Record<string, string> = {}

	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === "string") {
			out[k.toLowerCase()] = v
		} else if (typeof v === "number") {
			out[k.toLowerCase()] = String(v)
		}
	}

	return out as OaProperties
}

/**
 * Parse a single ND-GeoJSON line.
 * Return null for blanks, comments, or non-Feature shapes.
 */
function parseFeatureLine(line: string): OaProperties | null {
	const trimmed = line.trim()

	if (!trimmed || trimmed.startsWith("#")) return null
	const parsed = tryParsingJSON(trimmed)

	if (!parsed || typeof parsed !== "object") return null
	const obj = parsed as { type?: string; properties?: unknown }

	if (obj.type !== "Feature") return null

	return normalizeProperties(obj.properties)
}

export interface OpenaddressesAdapterOptions {
	/**
	 * Per-row license used when a Feature lacks an explicit `LICENSE` property.
	 *
	 * Defaults to `CC-BY-4.0` — the most common license across the OpenAddresses collection.
	 * Override per dump via the runner's adapter-options passthrough.
	 */
	defaultLicense?: string

	/**
	 * Whether this adapter emits a row whose per-file license requires share-alike.
	 *
	 * The default is `true`.
	 * `buildCorpus({ licensePolicy })` and `mw corpus build --license-policy share-alike-free`
	 * express a refusal at build level.
	 *
	 * The policy reads the obligations of every adapter's rows under one policy and records what it refused.
	 *
	 * Pass `false` only for an adapter-scoped drop, such as a fixture that must use one license.
	 */
	allowShareAlike?: boolean
}

/**
 * Build an OpenAddresses adapter.
 *
 * The optional `defaultLicense` lets callers stamp a non-default fallback for dumps
 * known to use a single license throughout (e.g. a PDDL-only state extract).
 */
export function createOpenaddressesAdapter(opts: OpenaddressesAdapterOptions = {}): CorpusAdapter {
	const defaultLicense = opts.defaultLicense ?? OPENADDRESSES_DEFAULT_LICENSE
	const allowShareAlike = opts.allowShareAlike ?? true
	// The same reading the build applies, so an adapter-scoped drop
	// and a build-level policy refuse the same rows.
	// OpenAddresses stamps a per-file license.
	// A file's value can be prose naming a share-alike register rather than an identifier.
	const shareAlike = createLicenseVerdictCache(LicensePolicy.ShareAlikeFree)

	return {
		id: OPENADDRESSES_ADAPTER_ID,
		defaultLicense,
		addressRole: AddressRole.Premise,
		// OpenAddresses redistributes national and municipal registers with terms that differ per file.
		// A row's source file identifies its upstream, rather than this adapter.
		register: SourceRegister.OpenAddresses,
		surface: SurfaceOrigin.Attested,
		description: "OpenAddresses (global): line-delimited GeoJSON dumps with per-row licenses.",

		async *rows(adapterOpts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (!adapterOpts.country) {
				throw new Error(
					"openaddresses adapter: --country is required (OpenAddresses files are country-partitioned but rows lack a country field)"
				)
			}

			const country = adapterOpts.country

			// The path string lets the library own and dispose the file handle, including on an early `break`.
			const lines = TextSpliterator.fromAsync(adapterOpts.inputPath)

			let emitted = 0
			let shareAlikeBlocked = 0

			try {
				for await (const line of lines) {
					if (adapterOpts.signal?.aborted) break

					if (adapterOpts.limit !== undefined && emitted >= adapterOpts.limit) break

					const props = parseFeatureLine(line)

					if (!props) continue

					const houseNumber = props.number?.trim() ?? ""
					const street = props.street?.trim() ?? ""
					const unit = props.unit?.trim() ?? ""
					const city = props.city?.trim() ?? ""
					const region = props.region?.trim() ?? ""
					const postcode = props.postcode?.trim() ?? ""

					// A row needs a street plus a postcode or locality, or the aligner quarantines it.
					if (!street) continue

					if (!city && !postcode) continue

					const license = (props.license?.trim() || defaultLicense).trim()

					if (!allowShareAlike && shareAlike.read(license).refusal !== null) {
						shareAlikeBlocked++

						continue
					}

					const components: CanonicalRow["components"] = {}

					if (houseNumber) {
						components.house_number = houseNumber
					}

					if (street) {
						components.street = street
					}

					if (unit) {
						components.unit = unit
					}

					if (city) {
						components.locality = city
					}

					if (region) {
						components.region = region
					}

					if (postcode) {
						components.postcode = postcode
					}

					const rendered = formatAddressRow(components, country, { singleLine: true })

					if (!rendered) continue

					const { raw, components: aligned } = rendered
					const sourceIDSeed = props.hash?.trim() || props.id?.trim()

					const sourceID = sourceIDSeed
						? `${OPENADDRESSES_ADAPTER_ID}-${sourceIDSeed}`
						: stableSourceID(OPENADDRESSES_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country,
						source: OPENADDRESSES_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license,
					}

					emitted++
				}
			} finally {
				if (shareAlikeBlocked > 0) {
					process.stderr.write(`  openaddresses: ${shareAlikeBlocked} share-alike rows dropped, ${emitted} kept\n`)
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const openaddressesAdapter = createOpenaddressesAdapter()
