/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Functional diagnostic for the postcode anchor (#240). Wires the real `postalcode-us.db` +
 *   `postalcode-intl.db` shards through `WOFPostcodeLookup` and runs `extractPostcodeAnchors` on a
 *   few addresses that exercise each claim in the design doc: single-country placement,
 *   cross-country ambiguity, a regex-shaped non-member (the house-number case), and an
 *   out-of-coverage country (graceful zero-confidence).
 *
 *   Build the shards first: node --experimental-strip-types scripts/build-unified-wof.ts --data
 *   <repos> --output postalcode-intl.db --placetypes postalcode node --experimental-strip-types
 *   scripts/backfill-postcode-centroids.ts --db postalcode-intl.db
 *
 *   Run: node --experimental-strip-types scripts/diag-postcode-anchor.ts
 */

import { extractPostcodeAnchors } from "@mailwoman/neural/postcode-anchor"
import { WOFPostcodeLookup } from "@mailwoman/resolver-wof-sqlite"

const SHARDS = [
	"/mnt/playpen/mailwoman-data/wof/postalcode-us.db",
	"/mnt/playpen/mailwoman-data/wof/postalcode-intl.db",
]

const INPUTS = [
	"8 Rue du Faubourg Saint-Honoré, 75008 Paris", // FR, single-country, placed
	"Straußstraße 27, 12623 Berlin", // DE, GeoNames centroid
	"123 Market St, San Francisco, CA 94105", // US, own centroid
	"Calle de Alcalá 1, 28014 Madrid", // ES, GeoNames centroid
	"Via Roma 1, 20121 Milano", // IT, GeoNames centroid (corrects WOF's bad Milan→Liguria link)
	"75001 Paris", // FR + US (Addison, TX) — ambiguous → moderate confidence
	"Apartment 99999, Nowhere", // regex-shaped, in no gazetteer → confidence 0
	"10 Downing Street, London SW1A 2AA", // GB — not in our shards → graceful 0
]

const lookup = new WOFPostcodeLookup(SHARDS)

for (const input of INPUTS) {
	console.log(`\n=== ${input} ===`)
	const anchors = extractPostcodeAnchors(input, lookup)
	if (anchors.length === 0) {
		console.log("  (no postcode-shaped span)")
		continue
	}
	for (const a of anchors) {
		const post = Object.entries(a.posterior)
			.map(([c, p]) => `${c}:${p.toFixed(2)}`)
			.join(" ")
		const cands = a.candidates.map((c) => `${c.country}(${c.lat.toFixed(3)},${c.lon.toFixed(3)})`).join(" ") || "—"
		console.log(`  "${a.normalized}"  conf=${a.confidence.toFixed(3)}  posterior=[${post || "∅"}]  centroid=${cands}`)
	}
}

lookup.close()
