// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The differential report of the `coordinates`, `spatial` and `identifiers`
 * families against the text recognizers of `@mailwoman/spatial`, written
 * to `packages/recognize/data/reports/point-query-differential.json`.
 *
 * Five spatial readings are compared, each on every input:
 *
 * - `parsePointQuery`: the point, plus code, H3 cell, geohash or Who's On First id it returns for the text.
 * - `isFullPlusCode` and `isShortPlusCode`: whether the text is exactly such a code.
 * - The DIGIPIN decoder `getLatLngFromDIGIPIN`: whether it accepts the text,
 *   and the cell center it decodes.
 * - `PLUS_CODE_TOKEN`: the first plus code token in the text, as `applyPlusCodeOverride` extracts it.
 *
 * The inputs are the string literals of the three spatial test files, and generated
 * inputs dense in each shape and its near misses: random angles with every mark,
 * labeled pairs, Maps segments, codes with every length and neighbor character,
 * DIGIPIN forms, identifiers with every prefix, Unicode case-folding near misses,
 * padded variants of every spelling, and random strings over the alphabet of all the shapes.
 *
 * The comparison covers the parsed value and the acceptance.
 * A coordinate's latitude, longitude and axis order to full precision, a plus code's upper-cased text
 * and full flag, a cell's lower-cased text, an id as a number, and a DIGIPIN's decoded position.
 *
 * A recognition that the validator rejected is a reading of no value, like `null`,
 * so a rejected span and `null` agree.
 *
 * The recognize side reads the text its caller trims.
 * `parsePointQuery` trims its input, and `recognize` reports spans of the text it is given,
 * so the caller passes `text.trim()` and the grammars admit no outer white space.
 *
 * That's the stated contract of `isDeterministicCoordinate`.
 * The tool applies it to `parsePointQuery` only.
 *
 * The plus code and DIGIPIN readers don't trim, and the tool compares them on the text as given.
 * The report counts the padded inputs that `parsePointQuery` reads only because it trims.
 *
 * `PLUS_CODE_TOKEN` is unexported, so the tool holds its pattern and checks that
 * the source file still spells it the same way.
 *
 * The tool lives under `mailwoman` because `@mailwoman/recognize` takes no
 * dependency on `@mailwoman/spatial`.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/recognize/point-differential.run.ts [--check]`
 *
 * `--check` leaves the report as it is and exits non-zero when the committed
 * report differs from the code's output.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { mulberry32 } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { createRecognizer } from "@mailwoman/recognize"
import { coordinates } from "@mailwoman/recognize/coordinates"
import { identifiers } from "@mailwoman/recognize/identifiers"
import { spatial } from "@mailwoman/recognize/spatial"
import { getLatLngFromDIGIPIN } from "@mailwoman/spatial/digipin"
import { isFullPlusCode, isShortPlusCode } from "@mailwoman/spatial/open-location-code"
import { coordinatePairText, parsePointQuery } from "@mailwoman/spatial/point-query"
import { type FormatConfig, format } from "oxfmt"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

const reportPath = workspacePath("recognize", "data", "reports", "point-query-differential.json")
const recognizer = createRecognizer([coordinates, spatial, identifiers])

/**
 * The pattern of `packages/mailwoman/lib/plus-code-override.ts`, which keeps it unexported.
 */
const PLUS_CODE_TOKEN = /(?:^|[\s,])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3})(?=[\s,]|$)/i
const PLUS_CODE_TOKEN_SOURCE = String.raw`/(?:^|[\s,])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3})(?=[\s,]|$)/i`

const overrideSource = await readLocalTextFile(repoRootPath("packages", "mailwoman", "lib", "plus-code-override.ts"))

if (!overrideSource.includes(`const PLUS_CODE_TOKEN = ${PLUS_CODE_TOKEN_SOURCE}`)) {
	throw new Error("plus-code-override.ts spells PLUS_CODE_TOKEN differently than this tool: update the tool")
}

/**
 * What one reader returned for one input: no value, or a value of plain JSON.
 */
type Reading = { accepted: false } | { accepted: true; value: unknown }

const NONE: Reading = { accepted: false }

function same(a: Reading, b: Reading): boolean {
	if (!a.accepted || !b.accepted) return a.accepted === b.accepted

	return stringifyJSON(a.value) === stringifyJSON(b.value)
}

interface Recognized {
	readonly kind: string
	readonly start: number
	readonly end: number
	readonly text: string
	readonly validation:
		| { readonly status: "validated"; readonly payload: Record<string, unknown> }
		| { readonly status: "rejected"; readonly rejection: { readonly code: string } }
		| { readonly status: "unvalidated" }
}

function recognizeAll(text: string): readonly Recognized[] {
	if (!text) return []

	// Each recognition is copied into the plain shape the readers below take, so no cast is needed.
	return recognizer.recognize(text).recognitions.map((recognition): Recognized => {
		const { validation } = recognition

		const common = {
			kind: String(recognition.kind),
			start: recognition.start,
			end: recognition.end,
			text: recognition.text,
		}

		if (validation.status === "validated") {
			return { ...common, validation: { status: "validated", payload: { ...validation.payload } } }
		}

		if (validation.status === "rejected") {
			return { ...common, validation: { status: "rejected", rejection: { code: validation.rejection.code } } }
		}

		return { ...common, validation: { status: "unvalidated" } }
	})
}

/**
 * The validated recognitions that cover the whole text.
 */
function wholeValidated(text: string): Recognized[] {
	return recognizeAll(text).filter(
		(recognition) =>
			recognition.start === 0 && recognition.end === text.length && recognition.validation.status === "validated"
	)
}

function payloadOf(recognition: Recognized): Record<string, unknown> {
	return recognition.validation.status === "validated" ? recognition.validation.payload : {}
}

/**
 * The order in which `parsePointQuery` tries the shapes.
 * The first kind a text reads as wins.
 */
const POINT_KIND_ORDER = ["wof", "h3", "geohash", "plus_code", "coordinates"] as const

function pointOf(recognition: Recognized): { kind: string; value: Record<string, unknown> } | null {
	const payload = payloadOf(recognition)

	switch (recognition.kind) {
		case "wof.reference":
		case "wof.spelunker_url":
			return { kind: "wof", value: { kind: "wof", id: payload["id"] } }
		case "h3.cell":
		case "h3.prefixed_cell":
			return { kind: "h3", value: { kind: "h3", cell: payload["cell"] } }
		case "geohash.prefixed":
			return { kind: "geohash", value: { kind: "geohash", hash: payload["hash"] } }
		case "plus_code.token":
			return { kind: "plus_code", value: { kind: "plus_code", code: payload["code"], full: payload["full"] } }
		default:
			if (recognition.kind.startsWith("coordinate.")) {
				return {
					kind: "coordinates",
					value: {
						kind: "coordinates",
						lat: payload["latitude"],
						lon: payload["longitude"],
						order: payload["order"] ?? "lat_lon",
					},
				}
			}

			return null
	}
}

function legacyPoint(text: string): Reading {
	const point = parsePointQuery(text)

	return point ? { accepted: true, value: point } : NONE
}

function recognizePoint(text: string, asGiven = false): Reading {
	const trimmed = asGiven ? text : text.trim()

	const points = wholeValidated(trimmed)
		.map(pointOf)
		.filter((point): point is NonNullable<typeof point> => point !== null)

	for (const kind of POINT_KIND_ORDER) {
		const found = points.find((point) => point.kind === kind)

		if (found) return { accepted: true, value: found.value }
	}

	return NONE
}

function legacyPlusCode(text: string, full: boolean): Reading {
	return (full ? isFullPlusCode(text) : isShortPlusCode(text))
		? { accepted: true, value: { code: text.toUpperCase(), full } }
		: NONE
}

function recognizePlusCode(text: string, full: boolean): Reading {
	const found = wholeValidated(text).find(
		(recognition) => recognition.kind === "plus_code.token" && payloadOf(recognition)["full"] === full
	)

	return found ? { accepted: true, value: { code: payloadOf(found)["code"], full } } : NONE
}

function legacyDIGIPIN(text: string): Reading {
	try {
		return { accepted: true, value: getLatLngFromDIGIPIN(text) }
	} catch (error) {
		if (error instanceof RangeError) return NONE

		throw error
	}
}

function recognizeDIGIPIN(text: string): Reading {
	const found = wholeValidated(text).find((recognition) => recognition.kind.startsWith("digipin."))

	if (!found) return NONE

	// The payload holds the ten characters.
	// The decoder belongs to the spatial package, so the cell is the decoder's own.
	return { accepted: true, value: getLatLngFromDIGIPIN(String(payloadOf(found)["code"])) }
}

function legacyToken(text: string): Reading {
	const token = PLUS_CODE_TOKEN.exec(text)?.[1]

	return token ? { accepted: true, value: token.toUpperCase() } : NONE
}

function recognizeToken(text: string): Reading {
	// A token the validator rejects is still a token: `PLUS_CODE_TOKEN` matches two
	// to eight digits, and the caller reads the count afterwards.
	const found = recognizeAll(text).find((recognition) => recognition.kind === "plus_code.token")

	return found ? { accepted: true, value: found.text.toUpperCase() } : NONE
}

const COMPARATORS = {
	parsePointQuery: { spatial: legacyPoint, recognize: recognizePoint },
	isFullPlusCode: {
		spatial: (text: string) => legacyPlusCode(text, true),
		recognize: (text: string) => recognizePlusCode(text, true),
	},
	isShortPlusCode: {
		spatial: (text: string) => legacyPlusCode(text, false),
		recognize: (text: string) => recognizePlusCode(text, false),
	},
	getLatLngFromDIGIPIN: { spatial: legacyDIGIPIN, recognize: recognizeDIGIPIN },
	PLUS_CODE_TOKEN: { spatial: legacyToken, recognize: recognizeToken },
} as const

type ComparatorName = keyof typeof COMPARATORS

// #region Inputs

/**
 * The seed of the generated inputs, so the inputs and the report are the same on every run.
 */
const INPUT_SEED = 0x7a_11_ed

/**
 * The longest string literal of a spatial test file that the tool feeds to the readers.
 */
const MAX_LITERAL_LENGTH = 48

/**
 * The counts of random pairs of angles, labeled pairs, plus codes, DIGIPIN forms
 * and random strings the tool generates.
 */
const ANGLE_PAIRS = 9000
const LABELED_PAIRS = 2500
const PLUS_CODES = 6000
const DIGIPIN_FORMS = 4000
const IDENTIFIER_ROUNDS = 800
const RANDOM_STRINGS = 6000

/**
 * The share of random angles that have a seconds part.
 */
const SECONDS_SHARE = 0.4

/**
 * The equal readings the report keeps as examples for each reader.
 */
const EQUAL_EXAMPLES = 12

const random = mulberry32(INPUT_SEED)

function pick<T>(items: readonly T[]): T {
	return items[Math.floor(random() * items.length)]!
}

function digitsOf(alphabet: string, length: number): string {
	let out = ""

	for (let index = 0; index < length; index++) {
		out += alphabet[Math.floor(random() * alphabet.length)]!
	}

	return out
}

/**
 * The string literals of the spatial test files: every spelling the spatial recognizers are tested with.
 */
async function testFileInputs(): Promise<string[]> {
	const found = new Set<string>()

	for (const file of ["point-query.test.ts", "open-location-code.test.ts", "digipin.test.ts"]) {
		const source = await readLocalTextFile(workspacePath("spatial", "lib", file))

		for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/gu)) {
			const literal = parseJSONStrict<string>(`"${match[1]!}"`)

			if (literal.length <= MAX_LITERAL_LENGTH) {
				found.add(literal)
			}
		}
	}

	found.add(coordinatePairText(48.8584, 2.2945))
	found.add(coordinatePairText(-33.865, 151.21))

	return [...found]
}

const NUMBERS_FIRST = ["0", "12.5", "48.8584", "-90", "90.5", "139.6917", "-200", "+12.5", "007", "5."]
const NUMBERS_SECOND = ["0", "45.2", "-74.006", "180", "-180.5", "91", "+45.2", ".5", "1e3"]
const SEPARATORS = [",", ", ", " , ", ";", "; ", ",,", " ", "  ", "\t", " ,\n ", " ", " "]

function decimalInputs(): string[] {
	const inputs: string[] = []

	for (const first of NUMBERS_FIRST) {
		for (const second of NUMBERS_SECOND) {
			for (const separator of SEPARATORS) {
				inputs.push(`${first}${separator}${second}`)
			}
		}
	}

	for (const text of [
		"1,2,3",
		"1;2;3",
		"1 ,2, 3",
		"1, 2, ",
		", 1, 2",
		"1,",
		",2",
		",",
		"-",
		"--1,2",
		"1,--2",
		"+-1,2",
	]) {
		inputs.push(text)
	}

	for (const digits of [20, 330, 400]) {
		inputs.push(
			`${"9".repeat(digits)}, 1`,
			`1, ${"9".repeat(digits)}`,
			`0.${"1".repeat(digits)}, 0.${"1".repeat(digits)}`
		)
	}

	return inputs
}

function geoURIInputs(): string[] {
	const inputs: string[] = []

	const points = [
		"48.8584,2.2945",
		"-90,180",
		"94,0",
		"0,-180.5",
		"100.5,40",
		"1,2,35",
		"1,2,-12.5",
		"1, 2",
		"+1,2",
		".5,2",
		"1,2,",
	]

	const parameters = [
		"",
		";crs=wgs84",
		";crs=Moon-2011",
		";u=10",
		";u=0",
		";u=-1",
		";u=5;crs=wgs84",
		";foo=bar",
		";x=1;crs=wgs84",
		";u=1;u=2",
		";",
		";=",
		";a b",
		";a=%2",
		";é=1",
		" extra",
	]

	for (const scheme of ["geo:", "GEO:", " geo:", "geo: ", "geo ", "geo:/"]) {
		for (const point of points) {
			inputs.push(`${scheme}${point}`)
		}
	}

	for (const point of ["48.8584,2.2945", "1,2,35", "94,0"]) {
		for (const parameter of parameters) {
			inputs.push(`geo:${point}${parameter}`)
		}
	}

	return inputs
}

function angleInput(): string {
	const sign = pick(["", "", "", "-", "+", "- "])
	const degrees = pick(["12", "48.8584", "0", "90", "91", "180", "181", "5", "007", "12.5", "33", "151"])
	const degreeMark = pick(["", "", "°", "º", "d", " d", "d ", "° ", " °"])

	const minutes =
		random() < 0.5
			? ""
			: `${pick(["30", "30.5", "60", "75", "5"])}${pick(["'", "′", "’", "m", " m", "m ", " ′ ", "’"])}`

	const seconds =
		random() < SECONDS_SHARE
			? ""
			: `${pick(["15", "15.25", "59.9", "30", "5"])}${pick(['"', "″", "”", "''", "s", " s", "s ", " ″"])}`

	const hemisphere = pick(["", "", "N", "S", "E", "W", "n", "w", " N", " E", " s", "e"])
	const spacer = pick(["", "", " ", "  "])

	return `${sign}${degrees}${degreeMark}${spacer}${minutes}${spacer}${seconds}${spacer}${hemisphere}`
}

function angleInputs(): string[] {
	const inputs: string[] = []

	for (let count = 0; count < ANGLE_PAIRS; count++) {
		inputs.push(`${angleInput()}${pick([", ", ",", ";", " ", "  ", "\t", " , ", " ; "])}${angleInput()}`)
	}

	inputs.push(
		"38°53'51.72\"N 77°2'11.40\"W",
		"33° 51′ 54″ S, 151° 12′ 36″ E",
		"12d 30m N, 5 E",
		"12d30m N, 5 E",
		"12°30''N, 5E",
		'12°30"N, 5E',
		"12°30′20S, 5E",
		"12 N 5",
		"12N 5E 7W",
		"12°, 30°, 5°",
		"12N, 30N",
		"1200 N, 400 W",
		"12 W 34",
		"12\n34N"
	)

	return inputs
}

function labeledInputs(): string[] {
	const inputs: string[] = []
	const labels = ["lat", "latitude", "lon", "longitude", "lng", "LAT", "Lng", "la", "long", "Latitude"]
	const marks = ["", ":", "=", " : ", " =", "  "]
	const joiners = [" ", ", ", ";", ",", "  ", "", " ; "]
	const numbers = ["48.85", "2.29", "-74", "0", "91", "181", "+3", ".5", "5."]

	for (let count = 0; count < LABELED_PAIRS; count++) {
		inputs.push(
			`${pick(labels)}${pick(marks)}${pick(numbers)}${pick(joiners)}${pick(labels)}${pick(marks)}${pick(numbers)}`
		)
	}

	inputs.push(
		"lat 48.8584 lon 2.2945",
		"latitude: 48.8584, longitude: 2.2945",
		"lng=2.2945, lat=48.8584",
		"lng=2.2945, lng=48.8584",
		"flat 5 lon 6"
	)

	return inputs
}

function mapsInputs(): string[] {
	const inputs: string[] = []

	for (const point of ["48.8584,2.2945", "-90,-180", "91,181", "1, 2", ".5,1", "1,2,", "5.,6"]) {
		for (const tail of ["", ",17z", ",17Z", ",17", ",17.5z", ",z", ",1.2.3z", ",17z/data", "/", ",17z,"]) {
			for (const lead of ["@", " @", "@ ", "x@", "at@", "@@"]) {
				inputs.push(`${lead}${point}${tail}`)
			}
		}
	}

	return inputs
}

const OLC = "23456789CFGHJMPQRVWX"
const NEIGHBORS = ["", " ", ",", ", ", "x", "X", ".", "(", ")", "-", "_", "+", "'", "\t", " ", "5"]

function plusCodeInputs(): string[] {
	const inputs: string[] = []

	for (let count = 0; count < PLUS_CODES; count++) {
		const prefix = digitsOf(OLC, pick([1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 8, 8, 8, 9]))
		const suffix = digitsOf(OLC, pick([0, 1, 2, 2, 2, 3, 3, 4]))
		let code = `${prefix}+${suffix}`

		code = pick([code, code, code.toLowerCase(), code.slice(0, 3) + code.slice(3).toLowerCase()])
		inputs.push(code, `${pick(NEIGHBORS)}${code}${pick(NEIGHBORS)}`)
		inputs.push(`Managua${pick([", ", " ", ","])}${code}${pick([", Nicaragua", " Nicaragua", ""])}`)
	}

	inputs.push(
		"764MVFQ6+92P",
		"vfq6+92p",
		"VFQ6+92P Managua",
		"MAIN+ST",
		"8FVC0000+",
		"VFA6+92P",
		"+92P",
		"VFQ6+",
		"VFQ6+92PX",
		"VFQ6 +92P",
		"VFQ6+92P+"
	)

	return inputs
}

const DIGIPIN = "FC98J327K456LMPT"

function digipinInputs(): string[] {
	const inputs: string[] = []

	for (let count = 0; count < DIGIPIN_FORMS; count++) {
		const pin = digitsOf(DIGIPIN, pick([8, 9, 10, 10, 10, 10, 11]))
		const display = `${pin.slice(0, 3)}-${pin.slice(3, 6)}-${pin.slice(6)}`

		const form = pick([
			pin,
			pin,
			display,
			display,
			pin.toLowerCase(),
			display.toLowerCase(),
			`${pin.slice(0, 3)}-${pin.slice(3)}`,
			`${pin.slice(0, 4)}-${pin.slice(4, 7)}-${pin.slice(7)}`,
			`${pin.slice(0, 3)} ${pin.slice(3, 6)} ${pin.slice(6)}`,
		])

		inputs.push(
			pick([
				form,
				form,
				`${pick([" ", " ", ""])}${form}${pick([" ", ".", ""])}`,
				`${form.slice(0, 5)}${pick(["A", "B", "1", "0", "I", "O", "é"])}${form.slice(6)}`,
			])
		)
	}

	inputs.push("4T396F42L7", "39J-49L-L8T4", "39j-49l-l8t4", "Washington", "2345678923", "FCJKLMPTFC")

	return inputs
}

const GEOHASH = "0123456789bcdefghjkmnpqrstuvwxyz"

function identifierInputs(): string[] {
	const inputs: string[] = []

	for (let count = 0; count < IDENTIFIER_ROUNDS; count++) {
		const cell = `8${digitsOf("0123456789abcdef", pick([13, 14, 14, 14, 15]))}`

		inputs.push(pick(["", "h3:", "H3:", " h3:", "h3: ", "h3"]) + pick([cell, cell.toUpperCase(), `9${cell.slice(1)}`]))

		const hash = digitsOf(GEOHASH, pick([0, 1, 5, 7, 12, 12, 13, 14]))

		inputs.push(
			`${pick(["geohash:", "gh:", "GH:", "Geohash:", "gh: ", "gh:\t", "gh :", "gh;", "geohash", " gh:"])}${pick([hash, hash.toUpperCase(), `${hash}a`, `${hash} `])}`
		)
	}

	for (const id of [
		"1",
		"85633793",
		"0",
		"007",
		"9007199254740991",
		"9007199254740992",
		"1234567890123456",
		"12345678901234567",
		"-1",
		"1.5",
	]) {
		for (const lead of [
			"wof:",
			"wof ",
			"WOF  ",
			"whosonfirst:",
			"WhosOnFirst:",
			"wof: ",
			"wof:\t",
			"wof",
			"who:",
			" wof:",
		]) {
			inputs.push(`${lead}${id}`)
		}

		for (const lead of [
			"https://spelunker.whosonfirst.org/id/",
			"http://spelunker.whosonfirst.org/id/",
			"HTTPS://SPELUNKER.WHOSONFIRST.ORG/ID/",
			"https://spelunker.whosonfirst.org/id",
			"ftp://spelunker.whosonfirst.org/id/",
		]) {
			inputs.push(`${lead}${id}`, `${lead}${id}/`, `${lead}${id}/x`, `${lead}${id}?q=1`)
		}
	}

	// Unicode case folding: the legacy patterns read `ſ` as `s` and the Kelvin sign as `k`; the grammars read ASCII.
	inputs.push(
		"httpſ://spelunker.whosonfirst.org/id/1",
		"whoſonfirſt:1",
		"ſpelunker",
		"GEOHASH:ezs42",
		"8928308280FFFFF",
		"h3:8928308280fffff",
		"gh:ezs42",
		"12N 5ſ"
	)

	return inputs
}

const ALPHABET = "0123456789.,;:-+°'\" NSEWnsewdmsLATloungh@CFGHJMPQRVWXh3wofhttp/"

function randomInputs(): string[] {
	const inputs: string[] = []

	for (let count = 0; count < RANDOM_STRINGS; count++) {
		inputs.push(digitsOf(ALPHABET, 1 + Math.floor(random() * 14)))
	}

	return inputs
}

const ADDRESSES = [
	"10 Downing Street, London",
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"5 Hauptstraße, Berlin, Berlin 10115",
	"Chicago, IL",
	"350 5th Ave",
	"Apt 4, 12 Main St",
	"12345 Main Street",
	"90210",
	"12 34",
	"1200 N 400 W",
	"Managua, VFQ6+92P, Nicaragua",
	"Simpson's Field, 5G8H+8F5, Douglas, Isle of Man IM2 4RE",
]

const PADDING = [
	["", ""],
	[" ", ""],
	["", " "],
	["\t", "\n"],
	[" ", " "],
	["﻿", ""],
] as const

// #endregion

const base = [
	...(await testFileInputs()),
	...decimalInputs(),
	...geoURIInputs(),
	...angleInputs(),
	...labeledInputs(),
	...mapsInputs(),
	...plusCodeInputs(),
	...digipinInputs(),
	...identifierInputs(),
	...randomInputs(),
	...ADDRESSES,
]

/**
 * A padded variant of each curated input, so the trim contract is measured on every spelling.
 */
const padded: string[] = []

for (const [index, input] of base.entries()) {
	if (index % 7 === 0) {
		const [before, after] = PADDING[1 + (index % (PADDING.length - 1))]!

		padded.push(`${before}${input}${after}`)
	}
}

const seen = new Set<string>()
const inputs = [...base, ...padded].filter((input) => !seen.has(input) && seen.add(input))

// #region Reasons

/**
 * Why two readings of one input differ, from the features of the input and of the two readings.
 *
 * An input no rule explains gets the reason `unexplained`, and the tool prints a warning for it.
 */
function reasonFor(name: ComparatorName, input: string, spatialReading: Reading, found: Reading): string {
	if (spatialReading.accepted && found.accepted) return "the two read different values"

	if (name === "parsePointQuery") {
		const trimmed = input.trim()

		if (spatialReading.accepted) {
			if (/[ſK]/u.test(trimmed)) {
				return "the legacy patterns' `iu` flags read U+017F as `s` and U+212A as `k`, and the grammars read ASCII letters only"
			}

			if (/^geo:/iu.test(trimmed)) {
				return "parsePointQuery accepts any text after the first `;` of a geo: URI, and recognize needs the parameter syntax of RFC 5870 section 3.3, a WGS84 reference system, and `crs` and `u` first and once"
			}

			if (/[,;][^,;]*[,;]/u.test(trimmed)) {
				return "parsePointQuery splits at the first separator and drops what follows the second, so a third number is ignored (a legacy defect)"
			}
		} else if (/(?:^|[^0-9])\.[0-9]/u.test(trimmed)) {
			return "recognize reads a bare fraction such as `.5`, and parsePointQuery needs digits before the decimal point"
		}
	}

	if (name === "PLUS_CODE_TOKEN" && found.accepted) {
		return "recognize bounds a token by any character that is not a letter, a digit or a connector, and PLUS_CODE_TOKEN requires white space, a comma or an edge of the text"
	}

	return "unexplained"
}

// #endregion

interface Row {
	input: string
	spatial: Reading
	recognize: Reading
}

type Outcome = "equal" | "neither" | "only_spatial" | "only_recognize" | "different_values"

function outcomeOf(spatialReading: Reading, found: Reading): Outcome {
	if (spatialReading.accepted && found.accepted) return same(spatialReading, found) ? "equal" : "different_values"

	if (spatialReading.accepted) return "only_spatial"

	return found.accepted ? "only_recognize" : "neither"
}

const perComparator: Record<
	string,
	{
		counts: Record<Outcome, number>
		reasons: Record<string, number>
		disagreements: unknown[]
		equalExamples: Row[]
		equalByKind: Record<string, number>
	}
> = {}

const digest: string[] = []

for (const name of Object.keys(COMPARATORS) as ComparatorName[]) {
	const comparator = COMPARATORS[name]

	const entry = {
		counts: { equal: 0, neither: 0, only_spatial: 0, only_recognize: 0, different_values: 0 } satisfies Record<
			Outcome,
			number
		>,
		reasons: {} as Record<string, number>,
		disagreements: [] as unknown[],
		equalExamples: [] as Row[],
		equalByKind: {} as Record<string, number>,
	}

	for (const input of inputs) {
		const spatialReading = comparator.spatial(input)
		const found = comparator.recognize(input)
		const outcome = outcomeOf(spatialReading, found)

		entry.counts[outcome]++
		digest.push(stringifyJSON([name, input, spatialReading, found]))

		if (outcome === "equal") {
			if (entry.equalExamples.length < EQUAL_EXAMPLES) {
				entry.equalExamples.push({ input, spatial: spatialReading, recognize: found })
			}

			// What each equal reading was, so the report shows every shape the inputs reached.
			const value = (spatialReading as { value: unknown }).value

			const kind =
				typeof value === "object" && value !== null && "kind" in value
					? String((value as { kind: unknown }).kind)
					: typeof value === "object" && value !== null && "full" in value
						? `plus_code ${(value as { full: boolean }).full ? "full" : "short"}`
						: name

			entry.equalByKind[kind] = (entry.equalByKind[kind] ?? 0) + 1

			continue
		}

		if (outcome === "neither") continue

		const reason = reasonFor(name, input, spatialReading, found)

		entry.reasons[reason] = (entry.reasons[reason] ?? 0) + 1
		entry.disagreements.push({ input, outcome, spatial: spatialReading, recognize: found, reason })
	}

	perComparator[name] = entry
}

/**
 * The padded inputs `parsePointQuery` reads and `recognize` reads only after the caller
 * trims them: the contract the report states for surrounding white space.
 */
const paddedInputs = inputs.filter((input) => input !== input.trim())

const readOnlyAfterTrim = paddedInputs.filter((input) => {
	const spatialReading = legacyPoint(input)

	return spatialReading.accepted && !same(spatialReading, recognizePoint(input, true))
})

/**
 * The tokens `PLUS_CODE_TOKEN` accepts and the validator rejects: a count of three,
 * five or seven digits before the separator.
 *
 * `applyPlusCodeOverride` removes such a token from the components and then has no cell to decode,
 * so a replacement that reads validated recognitions only would change what it removes.
 */
const tokensRejectedByTheValidator = inputs.filter((input) => {
	if (!legacyToken(input).accepted) return false

	const first = recognizeAll(input).find((recognition) => recognition.kind === "plus_code.token")

	return first?.validation.status === "rejected"
})

const unexplained = Object.entries(perComparator).flatMap(([name, entry]) =>
	entry.disagreements
		.filter((item) => (item as { reason: string }).reason === "unexplained")
		.map((item) => ({ name, ...(item as object) }))
)

if (unexplained.length) {
	console.error(`${unexplained.length} disagreements have no reason; the first 60:`)

	for (const item of unexplained.slice(0, 60)) {
		console.error(stringifyJSON(item))
	}
}

const report = {
	$generatedBy: "packages/mailwoman/tools/dev-tools/recognize/point-differential.run.ts",
	$note:
		"The text recognizers of @mailwoman/spatial against recognize. A reading is the parsed value; a rejected recognition and null agree. Do not edit by hand: rerun the generator.",
	inputs: inputs.length,
	surroundingWhiteSpace: {
		contract:
			"recognize reports spans of the text it is given and its grammars admit no outer white space, so the caller passes text.trim(), as parsePointQuery trims its own input. The two never read the padding.",
		paddedInputs: paddedInputs.length,
		readByParsePointQueryOnlyBecauseItTrims: readOnlyAfterTrim.length,
	},
	plusCodeTokensTheValidatorRejects: {
		note: "Inputs PLUS_CODE_TOKEN accepts whose first plus_code.token recognition is rejected, because the count of digits before the separator is odd.",
		count: tokensRejectedByTheValidator.length,
		examples: tokensRejectedByTheValidator.slice(0, 8),
	},
	resultsSHA256: sha256Hex(Buffer.from(digest.join("\n"))),
	recognizers: Object.fromEntries(
		Object.entries(perComparator).map(([name, entry]) => [
			name,
			{
				counts: entry.counts,
				reasons: Object.fromEntries(Object.entries(entry.reasons).toSorted(([a], [b]) => a.localeCompare(b))),
				equalByKind: Object.fromEntries(Object.entries(entry.equalByKind).toSorted(([a], [b]) => a.localeCompare(b))),
				equalExamples: entry.equalExamples,
				disagreements: entry.disagreements,
			},
		])
	),
}

// effect-loads: oxfmt.config.ts
const { default: formatConfig } = (await import(repoRootPath("oxfmt.config.ts").toString())) as {
	default: FormatConfig
}

const formatted = await format(reportPath.toString(), prettyJSON(report), formatConfig)

if (formatted.errors.length) {
	throw new Error(`oxfmt could not format the report: ${formatted.errors.map((error) => error.message).join("; ")}`)
}

if (values.check) {
	const committed = await readLocalTextFile(reportPath).catch(() => null)

	if (committed !== formatted.code) {
		console.error(`${reportPath} differs from what the code produces`)

		process.exitCode = 1
	}
} else {
	await writeLocalFile(formatted.code, reportPath)

	console.log(`wrote ${reportPath}: ${inputs.length} inputs`)

	for (const [name, entry] of Object.entries(perComparator)) {
		console.log(name, stringifyJSON(entry.counts))
	}
}

if (unexplained.length) {
	process.exitCode = 1
}
