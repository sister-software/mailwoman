/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Export the codex US street-affix vocab (directionals + Pub-28 street suffixes) as a JSON
 *   lexicon for the Python training loader's affix-split relabel pass (#511). Same
 *   one-source-of-truth pattern as build-gazetteer-anchor-lexicon.mjs: the TS codex matchers stay
 *   canonical; Python consumes a dumb variant→canonical map so the relabel pass agrees with the
 *   affix shard builder (which calls the codex matchers directly) by construction.
 *
 *   Usage: node scripts/build-affix-relabel-lexicon.mjs   (writes data/gazetteer/affix-relabel-lexicon-v1.json)
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const { US_STREET_SUFFIX_LOOKUP } = await import(resolve(root, "codex/out/us/street-suffix.js"))
const { DirectionalToAbbreviationMap, AbbreviationToDirectional } = await import(
	resolve(root, "codex/out/us/street-directional.js")
)

// Directionals: every SINGLE-TOKEN surface variant → canonical abbreviation. The codex maps are
// Maps keyed by the Pub-28 spaced names ("NORTH WEST"); real US streets use the one-word form
// ("Northwest"), which is what a whitespace-token relabel pass can match — so we emit the abbr
// ("nw") and the de-spaced name ("northwest"), same surfaces matchLeadingDirectional accepts.
const directionals = {}
for (const [name, abbr] of DirectionalToAbbreviationMap) {
	directionals[abbr.toLowerCase()] = abbr
	directionals[name.replace(/\s+/g, "").toLowerCase()] = abbr
}
for (const [abbr, name] of AbbreviationToDirectional) {
	directionals[abbr.toLowerCase()] = abbr
	directionals[name.replace(/\s+/g, "").toLowerCase()] = abbr
}

// Suffixes: the codex lookup already maps every Pub-28 variant (lowercase) → canonical suffix.
const suffixes = {}
for (const [variant, canonical] of US_STREET_SUFFIX_LOOKUP) {
	suffixes[variant] = canonical
}

const lexicon = {
	version: "affix-relabel-v1",
	source: "@mailwoman/codex us/street-directional + us/street-suffix (USPS Pub 28)",
	directionals,
	suffixes,
}

const out = resolve(root, "data/gazetteer/affix-relabel-lexicon-v1.json")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(lexicon, null, "\t") + "\n")
console.log(
	`wrote ${out}: ${Object.keys(directionals).length} directional variants, ${Object.keys(suffixes).length} suffix variants`,
)
