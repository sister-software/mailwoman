// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The differential report of the `coordinates` family against `parsePointQuery`,
 * written to `packages/recognize/data/reports/point-query-differential.json`.
 *
 * It runs every input of `packages/spatial/lib/point-query.test.ts` that concerns
 * decimal pairs and `geo:` URIs, and a generated grid of decimal pairs and `geo:`
 * URIs (signs, separators, padding, out-of-range values, extra tokens, parameters),
 * through `parsePointQuery` and through `recognize`.
 * It lists every input where the two disagree with both results and a reason.
 *
 * What's compared: the point `parsePointQuery` returns for the whole text, as `{ lat, lon, order }`,
 * against the point of a recognition that `isDeterministicCoordinate` accepts.
 * That's a validated coordinate recognition that covers the whole text.
 *
 * `parsePointQuery` trims its input and `recognize` reads the text as given,
 * so a padded input is a disagreement with the reason stated.
 * A text `recognize` matches and rejects (`100, 200`) agrees with `null`, because neither returns a point.
 *
 * Out of scope: the shapes `parsePointQuery` reads that Phase 7 owns.
 * Those are degrees-minutes-seconds and hemisphere letters, plus codes, H3 cells,
 * geohashes, Who's On First ids, Google Maps segments and labeled pairs.
 *
 * An input of the test file in one of those shapes is listed with its shape
 * and isn't counted as a disagreement.
 *
 * The tool lives under `mailwoman` because `@mailwoman/recognize` takes no
 * dependency on `@mailwoman/spatial`: the recognizer is a standalone engine,
 * and `spatial` would only be a test dependency of it.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/recognize/point-differential.run.ts [--check]`
 *
 * `--check` writes no file and exits non-zero when the committed report differs from what the code produces.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { createRecognizer } from "@mailwoman/recognize"
import { coordinates } from "@mailwoman/recognize/coordinates"
import { isDeterministicCoordinate } from "@mailwoman/recognize/deterministic"
import { coordinatePairText, parsePointQuery } from "@mailwoman/spatial/point-query"
import { type FormatConfig, format } from "oxfmt"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

const reportPath = workspacePath("recognize", "data", "reports", "point-query-differential.json")
const recognizer = createRecognizer([coordinates])

/**
 * What a reader returned for a whole text.
 */
type Reading =
	| { kind: "coordinates"; lat: number; lon: number; order: "lat_lon" | "lon_lat" }
	| { kind: "none" }
	| { kind: "rejected"; code: string }
	| { kind: "other"; shape: string }

function legacyReading(text: string): Reading {
	const point = parsePointQuery(text)

	if (!point) return { kind: "none" }

	if (point.kind === "coordinates") return { kind: "coordinates", lat: point.lat, lon: point.lon, order: point.order }

	return { kind: "other", shape: point.kind }
}

function recognizeReading(text: string): Reading {
	if (!text) return { kind: "none" }

	const { recognitions } = recognizer.recognize(text)
	const whole = recognitions.filter((recognition) => recognition.start === 0 && recognition.end === text.length)

	for (const recognition of whole) {
		if (isDeterministicCoordinate(recognition, text)) {
			const { payload } = recognition.validation

			return {
				kind: "coordinates",
				lat: payload.latitude,
				lon: payload.longitude,
				order: "order" in payload ? payload.order : "lat_lon",
			}
		}
	}

	for (const recognition of whole) {
		if (recognition.validation.status === "rejected") {
			return { kind: "rejected", code: recognition.validation.rejection.code }
		}
	}

	return { kind: "none" }
}

function sameReading(legacy: Reading, found: Reading): boolean {
	if (legacy.kind === "coordinates" && found.kind === "coordinates") {
		return legacy.lat === found.lat && legacy.lon === found.lon && legacy.order === found.order
	}

	// Neither returned a point: `null` and a rejected span agree.
	return legacy.kind !== "coordinates" && found.kind !== "coordinates"
}

/**
 * The shapes of `parsePointQuery` that Phase 7 owns, by the marks that identify them.
 * A decimal pair or a `geo:` URI holds none of them.
 */
function outOfScopeShape(text: string): string | null {
	const trimmed = text.trim()

	// A `geo:` URI is in scope whatever its parameters hold, and its parameter
	// characters include marks that identify the other shapes.
	if (/^geo:/iu.test(trimmed)) return null

	if (trimmed.startsWith("@")) {
		return "Google Maps segment"
	}

	if (/^(?:wof|whosonfirst)[\s:]/iu.test(trimmed) || /^https?:\/\//iu.test(trimmed)) return "Who's On First id"

	if (/^(?:geohash|gh):/iu.test(trimmed)) return "geohash"

	if (/^(?:lat|lon|lng)/iu.test(trimmed)) return "labeled pair"

	if (/[°º'′"″]|[0-9.][NSEW](?:\s|,|$)/iu.test(trimmed)) return "degrees, minutes, seconds or hemisphere letters"

	if (/^(?:h3:)?8[0-9a-f]{14}$/iu.test(trimmed)) return "H3 cell"

	if (/\+/u.test(trimmed) && /[A-Z0-9]{2,8}\+[A-Z0-9]*/iu.test(trimmed)) return "plus code"

	return null
}

/**
 * The inputs of `point-query.test.ts`: each string literal passed to `parsePointQuery`,
 * and the text `coordinatePairText` writes in the test of that name.
 */
async function testFileInputs(): Promise<string[]> {
	const source = await readLocalTextFile(workspacePath("spatial", "lib", "point-query.test.ts"))
	const found: string[] = []

	for (const match of source.matchAll(/parsePointQuery\(("(?:[^"\\]|\\.)*")\)/gu)) {
		found.push(parseJSONStrict<string>(match[1]!))
	}

	found.push(coordinatePairText(48.8584, 2.2945), coordinatePairText(-33.865, 151.21))

	return [...new Set(found)]
}

const NUMBERS_FIRST = ["0", "12.5", "48.8584", "-90", "90.5", "139.6917", "-200", "+12.5", "007", "5."]
const NUMBERS_SECOND = ["0", "45.2", "-74.006", "180", "-180.5", "91", "+45.2", ".5", "1e3"]
const SEPARATORS = [",", ", ", " , ", ";", "; ", ",,", " ", "  ", "\t", " ,\n "]

/**
 * The generated decimal pairs: every first and second number in every separator,
 * and a padded variant of a few.
 */
function generatedPairs(): string[] {
	const inputs: string[] = []

	for (const first of NUMBERS_FIRST) {
		for (const second of NUMBERS_SECOND) {
			for (const separator of SEPARATORS) {
				inputs.push(`${first}${separator}${second}`)
			}
		}
	}

	for (const base of ["48.8584, 2.2945", "139.6917,35.6895", "100, 200", "1,2"]) {
		for (const [before, after] of [
			[" ", ""],
			["", " "],
			["\t", "\n"],
			["x ", ""],
			["", " x"],
			["", ",3"],
			["", ", 3"],
			["", ";3"],
		] as const) {
			inputs.push(`${before}${base}${after}`)
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

const SCHEMES = ["geo:", "GEO:", "Geo:", " geo:", "geo: ", "geo ", "geo:/"]

const POINTS = [
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

const PARAMETERS = [
	"",
	";crs=wgs84",
	";crs=WGS84",
	";crs=Moon-2011",
	";u=10",
	";u=0",
	";u=-1",
	";u=1.5",
	";crs=wgs84;u=5",
	";u=5;crs=wgs84",
	";foo=bar",
	";foo",
	";x=1;crs=wgs84",
	";u=1;u=2",
	";crs=wgs84;crs=wgs84",
	";",
	";=",
	";u=",
	";crs=",
	";a b",
	";a=%20",
	";a=%2",
	";a=!~*'()[]:&+$",
	";a=,",
	";é=1",
	" extra",
]

function generatedURIs(): string[] {
	const inputs: string[] = []

	for (const scheme of SCHEMES) {
		for (const point of POINTS) {
			inputs.push(`${scheme}${point}`)
		}
	}

	for (const point of ["48.8584,2.2945", "1,2,35", "94,0"]) {
		for (const parameter of PARAMETERS) {
			inputs.push(`geo:${point}${parameter}`)
		}
	}

	return inputs
}

/**
 * A disagreement's reason, from the features of the input and of the two readings.
 *
 * An input no rule explains gets the reason `unexplained`, and the tool prints a warning for it.
 */
function reasonFor(text: string, legacy: Reading, found: Reading): string {
	const isURI = /^\s*geo:?/iu.test(text)
	const trimmedAgrees = text !== text.trim() && sameReading(legacyReading(text.trim()), recognizeReading(text.trim()))

	if (legacy.kind === "other") return "parsePointQuery reads another shape"

	if (text !== text.trim() && trimmedAgrees && legacy.kind === "coordinates") {
		return "parsePointQuery trims surrounding whitespace and recognize reads the text as given"
	}

	if (!isURI) {
		const trimmed = text.trim()

		if (legacy.kind === "coordinates" && found.kind !== "coordinates") {
			if (!/[,;]/u.test(trimmed) && /\s/u.test(trimmed)) {
				return "recognize admits no whitespace-only separator, which would read adjacent numbers of an address as a pair"
			}

			if ((trimmed.match(/[,;]/gu) ?? []).length > 1 || /^[^,;]*[,;][^,;]*[,;]/u.test(trimmed)) {
				return "parsePointQuery splits at the first separator and ignores what follows, so a third number is dropped (a legacy defect)"
			}

			return "unexplained"
		}

		if (found.kind === "coordinates" && legacy.kind !== "coordinates") {
			if (/(?:^|[^0-9])[+-]?\.\d/u.test(trimmed))
				return "recognize reads a bare fraction such as `.5` and parsePointQuery needs digits before the point"

			if (/^[^,;]*[,;]\s*$/u.test(trimmed)) return "unexplained"

			return "unexplained"
		}

		return "unexplained"
	}

	// A `geo:` URI.
	if (legacy.kind === "coordinates" && found.kind !== "coordinates") {
		if (/^\s/u.test(text) || /\s$/u.test(text)) {
			return "parsePointQuery trims surrounding whitespace and recognize reads the text as given"
		}

		if (found.kind === "rejected") {
			if (found.code === "unsupported_crs")
				return "recognize rejects a coordinate reference system other than WGS84, and parsePointQuery ignores every parameter"

			if (found.code === "misplaced_parameter") {
				return "recognize rejects a repeated or late `crs` or `u` (RFC 5870 section 3.3), and parsePointQuery ignores every parameter"
			}

			return `recognize rejects the values (${found.code}) where parsePointQuery accepted the pair`
		}

		return "parsePointQuery accepts any text after the first `;`, and recognize requires the parameter syntax of RFC 5870 section 3.3"
	}

	if (found.kind === "coordinates" && legacy.kind !== "coordinates") {
		return "unexplained"
	}

	return "unexplained"
}

interface Disagreement {
	input: string
	parsePointQuery: Reading
	recognize: Reading
	reason: string
}

const testInputs = await testFileInputs()
const outOfScope: Array<{ input: string; shape: string }> = []
const compared: Array<{ input: string; source: "point-query.test.ts" | "generated" }> = []

for (const input of testInputs) {
	const shape = outOfScopeShape(input)

	if (shape) {
		outOfScope.push({ input, shape })
	} else {
		compared.push({ input, source: "point-query.test.ts" })
	}
}

for (const input of [...generatedPairs(), ...generatedURIs()]) {
	// A generated input in a shape of Phase 7 would be a mistake of the generator, so it is refused.
	const shape = outOfScopeShape(input)

	if (shape) {
		throw new Error(`the generator produced ${stringifyJSON(input)}, which is a ${shape}`)
	}

	compared.push({ input, source: "generated" })
}

// A generated input equal to a test input is compared once.
const seen = new Set<string>()
const unique = compared.filter(({ input }) => !seen.has(input) && seen.add(input))

const disagreements: Disagreement[] = []
let agreements = 0

for (const { input } of unique) {
	const legacy = legacyReading(input)
	const found = recognizeReading(input)

	if (sameReading(legacy, found)) {
		agreements++

		continue
	}

	disagreements.push({ input, parsePointQuery: legacy, recognize: found, reason: reasonFor(input, legacy, found) })
}

const byReason: Record<string, number> = {}

for (const { reason } of disagreements) {
	byReason[reason] = (byReason[reason] ?? 0) + 1
}

const unexplained = disagreements.filter(({ reason }) => reason === "unexplained")

if (unexplained.length) {
	console.error(`${unexplained.length} disagreements have no reason:`)

	for (const entry of unexplained.slice(0, 40)) {
		console.error(stringifyJSON(entry))
	}
}

const report = {
	$generatedBy: "packages/mailwoman/tools/dev-tools/recognize/point-differential.run.ts",
	$note:
		"parsePointQuery against recognize over decimal pairs and geo: URIs. A reading is the point returned for the whole text; a validated coordinate recognition that covers the whole text on the recognize side. null and a rejected recognition agree. Do not edit by hand: rerun the generator.",
	counts: {
		compared: unique.length,
		agreements,
		disagreements: disagreements.length,
		outOfScope: outOfScope.length,
		unexplained: unexplained.length,
	},
	disagreementsByReason: Object.fromEntries(Object.entries(byReason).toSorted(([a], [b]) => a.localeCompare(b))),
	outOfScope,
	disagreements,
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

	console.log(
		`wrote ${reportPath}: ${unique.length} compared, ${agreements} agree, ${disagreements.length} differ, ${outOfScope.length} out of scope`
	)
}

if (unexplained.length) {
	process.exitCode = 1
}
