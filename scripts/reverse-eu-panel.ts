/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reverse-geocode regression panel (#1015): EU capitals + border cities → assert the result lands in
 *   the RIGHT country. Border towns are the hard class by construction — a reverse geocoder blind to a
 *   country's admin extents (e.g. Overture-backfilled locales with point-only bboxes before the
 *   `type=division_area` fix) picks the nearest CROSS-BORDER neighbour (Brussels → Netherlands).
 *
 *   Run against any admin gazetteer:
 *     node scripts/reverse-eu-panel.ts --admin /mnt/playpen/mailwoman-data/wof/admin-global-priority.db
 *
 *   Exits non-zero if any case resolves to the wrong country, so it can gate a rebuild.
 */

import { parseArgs } from "node:util"

import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { WOFReverseGeocoder } from "@mailwoman/resolver-wof-sqlite"

/** `[label, lat, lon, expectedISO2]`. Capitals confirm no regression; border cities are the hard class. */
const CASES: ReadonlyArray<readonly [string, number, number, string]> = [
	// EU capitals — must stay correct.
	["Brussels", 50.8503, 4.3517, "BE"],
	["Amsterdam", 52.3676, 4.9041, "NL"],
	["Paris", 48.8566, 2.3522, "FR"],
	["Berlin", 52.52, 13.405, "DE"],
	["Luxembourg", 49.6116, 6.1319, "LU"],
	["Vienna", 48.2082, 16.3738, "AT"],
	["Bern", 46.948, 7.4474, "CH"],
	// Belgian cities — the reported #1015 failures.
	["Antwerpen", 51.2194, 4.4025, "BE"],
	["Gent", 51.0543, 3.7174, "BE"],
	["Liège", 50.6326, 5.5797, "BE"],
	// Border cities — a few km from a foreign border, the adversarial class.
	["Aachen (DE, ~5km from BE/NL)", 50.7753, 6.0839, "DE"],
	["Maastricht (NL, ~5km from BE)", 50.8514, 5.691, "NL"],
	["Lille (FR, ~15km from BE)", 50.6292, 3.0573, "FR"],
	["Basel (CH, on DE/FR border)", 47.5596, 7.5886, "CH"],
	["Luxembourg City (~15km from FR/DE)", 49.6116, 6.1319, "LU"],
]

const { values } = parseArgs({
	options: { admin: { type: "string" }, polygons: { type: "string" } },
	allowNegative: true,
})
const adminDBPath = values.admin ?? `${mailwomanDataRoot()}/wof/admin-global-priority.db`

const rg = new WOFReverseGeocoder({ adminDBPath, ...(values.polygons ? { polygonDBPath: values.polygons } : {}) })
let fail = 0

console.log(`Reverse EU panel · admin=${adminDBPath}\n`)

for (const [label, lat, lon, expected] of CASES) {
	const r = await rg.reverseGeocode(lat, lon)
	const deepest = r.hierarchy[0]
	const gotCountry = r.hierarchy.find((h) => h.placetype === "country")?.country ?? deepest?.country ?? "(none)"
	const ok = gotCountry.toUpperCase() === expected

	if (!ok) fail++
	console.log(
		`  ${ok ? "✓" : "✗"} ${label.padEnd(38)} → ${(deepest?.name ?? "(empty)").padEnd(28)} ${gotCountry}  (want ${expected})  [${r.containment}]`
	)
}

console.log(`\n${CASES.length - fail}/${CASES.length} correct-country${fail ? ` — ${fail} FAILED` : ""}`)
rg.close()
process.exit(fail ? 1 : 0)
