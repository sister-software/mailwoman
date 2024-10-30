/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Options as CSVOptions, parse } from "csv-parse/sync"
import FastGlob from "fast-glob"
import { AddressParser, Tokenizer } from "mailwoman"
import { functionTestsDirectory } from "mailwoman/sdk/repo"
import { readFileSync } from "node:fs"
import Tape from "tape"

const options: CSVOptions = {
	trim: true,
	skip_empty_lines: true,
	relax_column_count: true,
	relax_quotes: true,
	columns: true,
}

// {
//   LON: '171.251359',
//     LAT: '-44.0831092',
//       NUMBER: '8',
//         STREET: 'Ash Drive',
//           UNIT: '',
//             CITY: 'Geraldine',
//               DISTRICT: 'Geraldine',
//                 REGION: '',
//                   POSTCODE: '',
//                     ID: '2099969',
//                       HASH: 'c97860ebc8b12d3e'
// },

const parser = new AddressParser()

type OpenAddressesColumnName =
	| "LON"
	| "LAT"
	| "NUMBER"
	| "STREET"
	| "UNIT"
	| "CITY"
	| "DISTRICT"
	| "REGION"
	| "POSTCODE"
	| "ID"
	| "HASH"

type OpenAddressesRow = Record<OpenAddressesColumnName, string>
type AddressComponent = "housenumber" | "street" | "postcode"

type ExtractedAddress = {
	[component in AddressComponent]?: string
}

function extract({ NUMBER, STREET, POSTCODE }: OpenAddressesRow): ExtractedAddress {
	/**
	 * @type {[AddressComponent, string][]}
	 */
	const entries = [
		["housenumber", NUMBER],
		["street", STREET],
		["postcode", POSTCODE],
	]
		.map(([k, v]) => {
			return /** @type {[AddressComponent, string]} */ [k, (typeof v === "string" ? v : "").trim()]
		})

		.filter(([, v]) => Boolean(v))

	return Object.fromEntries(entries)
}

function assert(t: Tape.Test, ext: Record<string, string>) {
	const text = Object.keys(ext)
		.map((k) => ext[k])
		.join(" ")
	const expected = Object.keys(ext).map((k) => {
		return { [k]: ext[k] }
	})

	const tokenizer = new Tokenizer(text)
	parser.classify(tokenizer)
	parser.solve(tokenizer)

	t.deepEquals(
		tokenizer.solutions.map((solution) =>
			solution.pair.map((c) => {
				return { [c.classification.label]: c.span.body }
			})
		)[0],
		expected,
		text
	)

	return text
}

export async function all(tape: Tape.Test["test"]) {
	// find all files ending in .test.js
	const openAddressesFiles = await FastGlob(functionTestsDirectory("oa/**/*.csv").toString()).then(($) =>
		$.map((file) => file.slice(functionTestsDirectory.length + 1))
	)

	for (const csvpath of openAddressesFiles) {
		const suite = csvpath.replace(functionTestsDirectory.toString(), "")
		const contents = readFileSync(csvpath)
		/**
		 * @type {Record<string, string>[]}
		 */
		const rows = parse(contents, options)

		tape(`oa: ${suite}`, (t) => {
			let prev = ""

			for (const row of rows) {
				const ext = extract(row)
				const hash = Object.keys(ext)

					.map((k) => ext[k as AddressComponent])
					.join(",")

				if (hash === prev) {
					return
				}

				prev = hash
				assert(t, ext)
			}

			t.end()
		})
	}
}
