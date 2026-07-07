#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerate `codex/country/reference-data.ts` — the per-country calling code (E.164) + currency
 *   (ISO 4217) table — from mledoze/countries (https://github.com/mledoze/countries, ODbL). The
 *   output is committed; this script makes it reproducible (provenance), not a hand-typed
 *   dictionary.
 *
 *   Calling-code rule: mledoze splits the code as `idd.root` + `idd.suffixes`. For most countries a
 *   single suffix completes the code (GB `+4` + `4` = 44); NANP members share root `+1` with their
 *   area code as the suffix, so they map to 1.
 *
 *   Usage: node scripts/build-country-reference.ts
 */

import { writeFileSync } from "node:fs"

const SOURCE = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
const OUT = new URL("../codex/country/reference-data.ts", import.meta.url)

/** A single country record from mledoze/countries, narrowed to the fields this script reads. */
interface MledozeCountry {
	cca2?: string
	idd?: { root?: string; suffixes?: string[] }
	currencies?: Record<string, { name?: string; symbol?: string }>
}

/** The emitted per-country reference row. */
interface CountryReferenceEntry {
	callingCode?: number
	currency?: { isoCode: string; name?: string; symbol?: string }
}

function callingCode(country: MledozeCountry): number | undefined {
	const root = (country.idd?.root ?? "").replace("+", "")
	const suffixes = country.idd?.suffixes ?? []

	if (!root) return undefined

	if (root === "1") return 1

	if (suffixes.length === 1) {
		const n = Number(root + suffixes[0])

		return Number.isFinite(n) ? n : undefined
	}
	const n = Number(root)

	return Number.isFinite(n) ? n : undefined
}

const response = await fetch(SOURCE)

if (!response.ok) throw new Error(`fetch ${SOURCE} failed: ${response.status}`)
const countries = (await response.json()) as MledozeCountry[]

const rows: Record<string, CountryReferenceEntry> = {}

for (const country of countries) {
	const alpha2 = country.cca2

	if (!alpha2) continue
	const entry: CountryReferenceEntry = {}
	const cc = callingCode(country)

	if (cc != null) {
		entry.callingCode = cc
	}
	const currencyCodes = Object.keys(country.currencies ?? {}).sort()

	if (currencyCodes.length) {
		const code = currencyCodes[0]!
		const info = country.currencies![code] ?? {}
		entry.currency = { isoCode: code }

		if (info.name) {
			entry.currency.name = info.name
		}

		if (info.symbol) {
			entry.currency.symbol = info.symbol
		}
	}

	if (Object.keys(entry).length) {
		rows[alpha2] = entry
	}
}

const serialize = (o: CountryReferenceEntry): string =>
	JSON.stringify(o, null, 0)
		.replace(/"isoCode"/g, "isoCode")
		.replace(/"callingCode"/g, "callingCode")
		.replace(/"currency"/g, "currency")
		.replace(/"name"/g, "name")
		.replace(/"symbol"/g, "symbol")

const body = Object.keys(rows)
	.sort()
	.map((k) => `\t${k}: ${serialize(rows[k]!)},`)
	.join("\n")

const header = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GENERATED — do not edit by hand. Country calling codes (E.164) + currencies (ISO 4217), derived
 *   from mledoze/countries (https://github.com/mledoze/countries, ODbL). NANP members map to 1.
 *   Regenerate with scripts/build-country-reference.ts.
 */

/** Static per-country reference: calling code + currency. */
export interface CountryReference {
	callingCode?: number
	currency?: { isoCode: string; name?: string; symbol?: string }
}

/** ISO 3166-1 alpha-2 → reference. */
export const COUNTRY_REFERENCE: Record<string, CountryReference> = {`

writeFileSync(OUT, `${header}\n${body}\n}\n`)
console.error(`wrote ${OUT.pathname} (${Object.keys(rows).length} countries)`)
