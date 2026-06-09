#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the gazetteer-anchor LEXICON (knowledge-ladder rung 3.2; #464). One generated artifact,
 *   codex as the single source of truth, consumed by BOTH the Python trainer (gazetteer_anchor.py)
 *   and the TS inference side — so the two matchers cannot drift (the PLACETYPE_ORDER lesson:
 *   dual implementations silently corrupt).
 *
 *   The lexicon maps normalized surface forms → a candidate-tag BITMASK:
 *     country=1, region=2, po_box=4, cedex=8, homograph=16 (set iff country∩region by construction).
 *   Two entry maps with different match rules (encoded as DATA so both consumers share them):
 *     - `entries`      — case-INSENSITIVE, keyed lowercase ("georgia", "costa rica", "timor-leste").
 *     - `code_entries` — exact-UPPERCASE only ("CA", "GA", "IN", "USA"), because "in"/"ca" as common
 *       lowercase words would fire everywhere. Country/region surfaces ≤3 alphabetic chars land here.
 *       po_box/cedex designators stay case-insensitive regardless of length ("Box 17" is titlecase).
 *
 *   The anchor is membership CLUES, not verdicts — the model decides every tag (model-first, see
 *   docs/articles/plan/reference/closed-vocab-fields-model-first.mdx). A "Box" hit inside
 *   "Box Canyon Rd" is fine: the homograph/contrast training teaches the model to read context.
 *
 *   Output: data/gazetteer/anchor-lexicon-v1.json (small, committed, provenance-tracked).
 *   Usage: node scripts/build-gazetteer-anchor-lexicon.mjs [--output <path>]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { COUNTRY_LOOKUP } from "../codex/out/country/index.js"
import { US_PO_BOX_DESIGNATORS } from "../codex/out/us/po-box.js"
import { US_STATE_ABBREVIATIONS, US_STATE_BY_ABBREVIATION } from "../codex/out/us/state.js"

const BIT = { country: 1, region: 2, po_box: 4, cedex: 8, homograph: 16 }
const SLOTS = ["country", "region", "po_box", "cedex", "homograph"]

const argv = process.argv.slice(2)
const outIdx = argv.indexOf("--output")
const OUTPUT = outIdx >= 0 ? argv[outIdx + 1] : "data/gazetteer/anchor-lexicon-v1.json"

/**
 * THE shared word-normalization rule (mirrored verbatim in gazetteer_anchor.py and the TS matcher —
 * documented in `rules.word_norm` below): per whitespace-word, strip LEADING/TRAILING characters
 * that are not Unicode letters or digits (keep internal ones: "timor-leste", "u.s.a"), then rejoin
 * single-spaced. Entry keys and scanned tokens both pass through it, so "U.S.A." ≡ "u.s.a".
 */
const wordNorm = (s) =>
	s
		.split(/\s+/)
		.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean)
		.join(" ")
/** Normalize a surface for the case-insensitive map. */
const norm = (s) => wordNorm(s).toLowerCase()
/** Short alphabetic code (≤3 letters once punctuation is dropped) → exact-uppercase matching. */
const isShortCode = (s) => {
	const letters = s.replace(/[^\p{L}]/gu, "")
	return letters.length > 0 && letters.length <= 3 && /^[\p{L}.\s]+$/u.test(s)
}

// surface → bits, split across the two match-rule maps.
const entries = new Map() // lowercase key
const codeEntries = new Map() // exact-uppercase key
let maxNgram = 1

function add(surface, bit) {
	const s = surface.trim()
	if (!s) return
	if ((bit === BIT.country || bit === BIT.region) && isShortCode(s)) {
		const key = wordNorm(s).toUpperCase()
		if (key) codeEntries.set(key, (codeEntries.get(key) ?? 0) | bit)
		return
	}
	const key = norm(s)
	if (!key) return
	maxNgram = Math.max(maxNgram, key.split(" ").length)
	entries.set(key, (entries.get(key) ?? 0) | bit)
}

// ── country: COUNTRY_LOOKUP already aggregates canonical names + alpha-2 + alpha-3 + curated
// surface forms (lowercase-keyed) — consume it directly so this builder can't drift from codex.
for (const surface of COUNTRY_LOOKUP.keys()) add(surface, BIT.country)

// ── region (US first cut): state names + USPS abbreviations ────────────────────────────────────
for (const name of Object.values(US_STATE_BY_ABBREVIATION)) add(name, BIT.region)
for (const abbrev of US_STATE_ABBREVIATIONS) add(abbrev, BIT.region)

// ── po_box designators (case-insensitive even when short — "Box 17" is titlecase) ──────────────
for (const d of US_PO_BOX_DESIGNATORS) {
	const key = norm(d)
	maxNgram = Math.max(maxNgram, key.split(" ").length)
	entries.set(key, (entries.get(key) ?? 0) | BIT.po_box)
}

// ── cedex (FR) ──────────────────────────────────────────────────────────────────────────────────
entries.set("cedex", (entries.get("cedex") ?? 0) | BIT.cedex)

// ── homograph bit: surface is BOTH a country and a region candidate ────────────────────────────
for (const map of [entries, codeEntries]) {
	for (const [key, bits] of map) {
		if (bits & BIT.country && bits & BIT.region) map.set(key, bits | BIT.homograph)
	}
}

const homographs = [...entries, ...codeEntries].filter(([, b]) => b & BIT.homograph).map(([k]) => k)

const lexicon = {
	version: 1,
	generated_by: "scripts/build-gazetteer-anchor-lexicon.mjs (source: @mailwoman/codex)",
	feature_dim: SLOTS.length,
	slots: SLOTS,
	bits: BIT,
	max_ngram: maxNgram,
	rules: {
		word_norm:
			"per whitespace-word: strip leading/trailing chars that are not Unicode letters/digits " +
			"(keep internal: 'timor-leste', 'u.s.a'); rejoin single-spaced. Applied to BOTH entry keys " +
			"and scanned tokens.",
		entries: "case-insensitive; key = word_norm lowercased",
		code_entries: "case-SENSITIVE exact: word_norm(token) == key (keys uppercase; the surface must already BE uppercase, so 'in' the word ≠ 'IN' the code). n-gram length 1 only.",
		scan: "longest-first n-gram over whitespace words, left to right, non-overlapping",
	},
	entries: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))),
	code_entries: Object.fromEntries([...codeEntries].sort(([a], [b]) => a.localeCompare(b))),
}

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, JSON.stringify(lexicon, null, 1) + "\n")
console.error(
	`wrote ${OUTPUT}: ${entries.size} entries + ${codeEntries.size} code_entries, ` +
		`max_ngram=${maxNgram}, ${homographs.length} homographs: ${homographs.slice(0, 12).join(", ")}${homographs.length > 12 ? ", …" : ""}`
)
