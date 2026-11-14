// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `state-tx-notaries`: Texas Notary Public Commissions CSV consumer.
 *
 *   The Texas Secretary of State publishes a registry of commissioned notaries public.
 *   Each row optionally includes a mailing address in free-form text
 *   (in some rows multi-line with embedded city/state/zip).
 *   Address fill rate is ~5-10%.
 *
 *   The adapter parses the embedded `Address` field for city/state/zip using a trailing `"city, ST
 *   ZIP"` pattern.
 *
 *   License: stamped `"Public Domain"` per Texas state government open-data terms.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { isPresent } from "@mailwoman/core/objects"
import { formatPersonName } from "@mailwoman/record/name"
import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/source-id"
import { splitStreetLine } from "#adapters/street/line"
import { createUnitSplitter } from "#adapters/street/unit"
import { SourceRegister } from "#registers"
import { streetIndexOpener } from "#street-index/reader"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation, type USStateInfo } from "#us/fips-state"
import { splitUSStreetLine, unitLine } from "#us/street-unit"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const STATE_TX_NOTARIES_ADAPTER_ID = "state-tx-notaries"
/**
 * License assigned by this source (Public Domain), attached to each row so downstream
 * consumers inherit the terms rather than having to look them up.
 */
export const STATE_TX_NOTARIES_DEFAULT_LICENSE = "Public Domain"

/**
 * The trailing `, ST ZIP` or `, ST` the registry writes after the city.
 */
const STATE_ZIP_SUFFIX = /,\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?\s*$/i

/**
 * An address field split into the street text before its city, the city,
 * its state abbreviation and its ZIP Code.
 */
export interface TxNotaryAddress {
	street: string
	city: string
	state: USStateInfo
	zip: string
}

/**
 * Splits a registry `Address` field, such as `"1215 mcmillan DR\nCEDAR hill, TX 75104"`,
 * at its trailing city, state and ZIP Code, or returns `null` when the state isn't
 * a US one or no comma-separated city precedes it.
 *
 * The registry appends its own `, ST ZIP` to the city a notary typed, and that city
 * sometimes already ends in the state, a country or the ZIP Code: `Houston, TX, TX 77043`,
 * `San Antonio TX, TX 78245`, `Godley, Texas 76044, TX 76044`, `Houston TX 77006, US, TX 77006`.
 * Those repetitions are removed before the city is read, so the city is `Houston`
 * and the state isn't taken for the city.
 */
export function parseTxNotaryAddress(rawAddress: string): TxNotaryAddress | null {
	const line = rawAddress.replaceAll("\n", ", ")
	const suffix = STATE_ZIP_SUFFIX.exec(line)
	const state = lookupStateAbbreviation(suffix?.[1] ?? null)

	if (!suffix || !state) return null

	const zip = suffix[2] ?? ""

	const repetitions = [
		`[\\s,]+(?:${state.abbreviation}\\.?|${state.name})`,
		",\\s*USA?",
		...(zip ? [`[\\s,]+${zip}`] : []),
	]

	const repeated = new RegExp(`(?:${repetitions.join("|")})\\s*$`, "iu")

	let head = line.slice(0, suffix.index)

	for (let match = repeated.exec(head); match; match = repeated.exec(head)) {
		head = head.slice(0, match.index)
	}

	const comma = head.lastIndexOf(",")

	if (comma === -1) return null

	return { street: head.slice(0, comma).replace(/,\s*$/u, "").trim(), city: head.slice(comma + 1).trim(), state, zip }
}

/**
 * A notary's street text as its first line and the unit lines typed after it.
 */
export interface TxNotaryStreetLines {
	line: string
	units: string[]
}

/**
 * Splits the street text {@linkcode parseTxNotaryAddress} returns into its first line
 * and the unit lines typed after it, in their written order.
 *
 * Notaries type a suite or department as its own line (`555 N. Carancahua, Suite 620`),
 * and some type the street line twice (`231 Blanco Dr, 231 Blanco Dr`).
 * A trailing comma-separated segment that {@linkcode unitLine} reads as a unit joins `units`,
 * and one that repeats the first line, with or without its house number, is removed.
 *
 * The split stops at the first trailing segment that's neither, so the street keeps every segment before it.
 */
export function splitTxNotaryStreetLines(street: string): TxNotaryStreetLines {
	// The unit splitter collapses a line's inner whitespace when it splits one, so a peeled line does too.
	const collapse = (text: string) => text.trim().replaceAll(/\s+/gu, " ")
	const comparable = (text: string) => collapse(text).toLowerCase()
	const first = street.split(",")[0] ?? ""
	const repeats = new Set([first, splitStreetLine(first)?.street ?? first].map(comparable))
	const units: string[] = []
	let line = street

	for (let comma = line.lastIndexOf(","); comma > 0; comma = line.lastIndexOf(",")) {
		const last = line.slice(comma + 1)
		const unit = unitLine(last)

		if (unit) {
			units.unshift(unit)
		} else if (last.trim() && !repeats.has(comparable(last))) {
			break
		}

		line = line.slice(0, comma).trimEnd()
	}

	if (line === street) return { line, units }

	return { line: collapse(line), units: units.map(collapse) }
}

/**
 * The `unit` component for a street line's own trailing unit followed by the unit lines typed after it.
 */
function withUnitLines(trailing: string | undefined, typed: readonly string[]): { unit?: string } {
	const unit = [trailing, ...typed].filter(isPresent).join(" ")

	return unit ? { unit } : {}
}

interface TxNotaryRow {
	"Notary ID": string
	"First Name": string
	"Last Name": string
	Address: string
}

export function createStateTxNotariesAdapter(): CorpusAdapter {
	return {
		id: STATE_TX_NOTARIES_ADAPTER_ID,
		defaultLicense: STATE_TX_NOTARIES_DEFAULT_LICENSE,
		addressRole: AddressRole.Mailing,
		register: SourceRegister.TexasNotaries,
		surface: SurfaceOrigin.Rendered,
		description:
			"Texas Notary Public Commissions — name + mailing address with embedded city/state/zip (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const units = await createUnitSplitter({ streetIndex: streetIndexOpener(opts.streetIndex) })

			if (opts.country && opts.country !== "US") {
				throw new Error(`state-tx-notaries adapter: only US supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<TxNotaryRow>) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const rawAddress = record.Address ?? ""

				if (!rawAddress) continue

				const firstName = record["First Name"] ?? ""
				const lastName = record["Last Name"] ?? ""
				const notaryID = record["Notary ID"] ?? ""

				const address = parseTxNotaryAddress(rawAddress)

				if (!address?.city) continue

				const { city, state, zip, street: streetPortion } = address

				if (!streetPortion) continue

				const typed = splitTxNotaryStreetLines(streetPortion)
				const split = splitUSStreetLine(typed.line, units)

				if (!split) continue

				// A PO box row emits no unit, so a box followed by a unit line keeps its whole street text.
				const line = !("po_box" in split)
					? { ...split, ...withUnitLines(split.unit, typed.units) }
					: typed.units.length
						? splitUSStreetLine(streetPortion, units)
						: split

				if (!line) continue

				const venue = formatPersonName({ given: firstName, family: lastName }, "short") || undefined

				const components: CanonicalRow["components"] = {
					...(venue ? { venue } : {}),
					...line,
					locality: city,
					region: state.abbreviation,
					...(zip ? { postcode: zip } : {}),
				}

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				if (Object.keys(aligned).length <= 2) continue

				const sourceID = notaryID
					? `${STATE_TX_NOTARIES_ADAPTER_ID}-${notaryID}`
					: stableSourceID(STATE_TX_NOTARIES_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: STATE_TX_NOTARIES_ADAPTER_ID,
					source_id: sourceID,
					license: STATE_TX_NOTARIES_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const stateTxNotariesAdapter = createStateTxNotariesAdapter()
