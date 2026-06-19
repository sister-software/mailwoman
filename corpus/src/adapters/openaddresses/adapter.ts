/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `openaddresses`: Line-delimited GeoJSON adapter for openaddresses.io exports.
 *
 *   OpenAddresses publishes country-partitioned address dumps as either CSV or line-delimited GeoJSON
 *   (one `Feature` per line, also called ND-GeoJSON / GeoJSONL). This adapter consumes the
 *   line-delimited GeoJSON shape — it streams cleanly without holding the file in memory, which
 *   matters for the multi-gigabyte national dumps (e.g. `us-northeast.geojsonl`, ~20M rows).
 *
 *   The collection aggregates **hundreds** of underlying sources with **per-source licenses** (city
 *   open-data portals, county GIS departments, state DOTs). The adapter therefore prefers the
 *   per-row `LICENSE` property when present and falls back to the configured `defaultLicense`. The
 *   propagated license travels with each `CanonicalRow` so downstream code can stratify, exclude,
 *   or re-attribute by license at training time.
 *
 *   Country must be explicit (`opts.country` REQUIRED): OpenAddresses files are organized by country
 *   but the row-level data doesn't include a country code, so the adapter refuses to run without
 *   one. This matches how a `mailwoman corpus build` invocation pins each file to a country via the
 *   inputs JSON.
 *
 *   Properties consumed (per the canonical OpenAddresses schema; both UPPERCASE and lowercase
 *   variants are accepted because legacy dumps used UPPERCASE):
 *
 *   | Property | ComponentTag | | ------------- |
 *   -------------------------------------------------------------- | | `number` | `house_number` |
 *   | `street` | `street` | | `unit` | `unit` (if non-empty) | | `city` | `locality` | | `region` |
 *   `region` (state code for US, province for CA, etc.) | | `postcode` | `postcode` | | `LICENSE` |
 *   per-row `license` override | | `hash` / `id` | `source_id` (prefer `hash`; fall back to `id`;
 *   then synthesize)|
 *
 *   `district` is intentionally NOT mapped — for US data it carries borough or county and would
 *   inflate alignment quarantine because postal addresses don't include it. Phase 6+ may revisit
 *   for non-US locales where district names DO appear on the envelope.
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { stableSourceId } from "../../adapter.js"
import { formatAddress, reconcileComponents } from "../../format.js"
import { SHARE_ALIKE_PATTERN } from "../../license.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const OPENADDRESSES_ADAPTER_ID = "openaddresses"
export const OPENADDRESSES_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * Subset of OpenAddresses Feature properties the adapter inspects. The runtime accepts UPPERCASE or
 * lowercase keys; this interface documents the canonical lowercase form after normalization.
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

/** Return a lowercase-keyed view of a Feature's properties so case variants both work. */
function normalizeProperties(raw: unknown): OaProperties {
	if (!raw || typeof raw !== "object") return {}
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === "string") out[k.toLowerCase()] = v
		else if (typeof v === "number") out[k.toLowerCase()] = String(v)
	}
	return out as OaProperties
}

/** Parse a single ND-GeoJSON line; return null for blanks, comments, or non-Feature shapes. */
function parseFeatureLine(line: string): OaProperties | null {
	const trimmed = line.trim()
	if (!trimmed || trimmed.startsWith("#")) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const obj = parsed as { type?: string; properties?: unknown }
	if (obj.type !== "Feature") return null
	return normalizeProperties(obj.properties)
}

export interface OpenaddressesAdapterOptions {
	/**
	 * Per-row license used when a Feature lacks an explicit `LICENSE` property. Defaults to
	 * `CC-BY-4.0` — the most common license across the OpenAddresses collection. Override per dump
	 * via the runner's adapter-options passthrough.
	 */
	defaultLicense?: string

	/**
	 * Per-adapter share-alike drop. Default **true** (include) as of 2026-06-19: exclusion is a
	 * deliberate BUILD-level act (`buildCorpus({ excludeLicenses })` / `--exclude-share-alike`), NOT
	 * a silent adapter default (#26 — "purposely exclude, don't opt in to include"). Set false only
	 * for an explicit adapter-scoped drop; the build-level `--exclude-share-alike` is the normal
	 * path.
	 */
	allowShareAlike?: boolean
}

/**
 * Build an OpenAddresses adapter. The optional `defaultLicense` lets callers stamp a non-default
 * fallback for dumps known to carry a single license throughout (e.g. a PDDL-only state slice).
 */
export function createOpenaddressesAdapter(opts: OpenaddressesAdapterOptions = {}): CorpusAdapter {
	const defaultLicense = opts.defaultLicense ?? OPENADDRESSES_DEFAULT_LICENSE
	const allowShareAlike = opts.allowShareAlike ?? true

	return {
		id: OPENADDRESSES_ADAPTER_ID,
		defaultLicense,
		description: "OpenAddresses (global): line-delimited GeoJSON dumps with per-row licenses.",

		async *rows(adapterOpts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (!adapterOpts.country) {
				throw new Error(
					"openaddresses adapter: --country is required (OpenAddresses files are country-partitioned but rows lack a country field)"
				)
			}
			const country = adapterOpts.country

			const stream = createReadStream(adapterOpts.inputPath, { encoding: "utf8" })
			const lines = createInterface({ input: stream, crlfDelay: Infinity })

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

					// A row is only useful if it has, at minimum, a street + (postcode OR locality).
					// Pure point-only rows would land in quarantine anyway.
					if (!street) continue
					if (!city && !postcode) continue

					const license = (props.license?.trim() || defaultLicense).trim()

					if (!allowShareAlike && SHARE_ALIKE_PATTERN.test(license)) {
						shareAlikeBlocked++
						continue
					}

					const components: CanonicalRow["components"] = {}
					if (houseNumber) components.house_number = houseNumber
					if (street) components.street = street
					if (unit) components.unit = unit
					if (city) components.locality = city
					if (region) components.region = region
					if (postcode) components.postcode = postcode

					const raw = formatAddress(components, country, { separator: ", " })
					if (!raw) continue

					const aligned = reconcileComponents(components, raw)
					if (Object.keys(aligned).length === 0) continue

					const sourceIdSeed = props.hash?.trim() || props.id?.trim()
					const sourceId = sourceIdSeed
						? `${OPENADDRESSES_ADAPTER_ID}-${sourceIdSeed}`
						: stableSourceId(OPENADDRESSES_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country,
						source: OPENADDRESSES_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license,
					}
					emitted++
				}
			} finally {
				lines.close()
				stream.destroy()
				if (shareAlikeBlocked > 0) {
					process.stderr.write(`  openaddresses: ${shareAlikeBlocked} share-alike rows dropped, ${emitted} kept\n`)
				}
			}
		},
	}
}

export const openaddressesAdapter = createOpenaddressesAdapter()
