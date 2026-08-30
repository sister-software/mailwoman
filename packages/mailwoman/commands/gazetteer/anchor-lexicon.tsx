import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { dirname } from "@mailwoman/platform/path"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Homographs printed before the list is truncated.
 */
const MAX_LISTED_HOMOGRAPHS = 12

/**
 * Letters at or below which a token reads as an abbreviation rather than a word.
 */
const MAX_ABBREVIATION_LETTERS = 3

const BIT = { country: 1, region: 2, po_box: 4, cedex: 8, homograph: 16 }
const SLOTS = ["country", "region", "po_box", "cedex", "homograph"]

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "anchor-lexicon",
	description: "Build the shared anchor lexicon",
	options: {
		output: { type: "string", description: "Output path. Default <repo>/data/gazetteer/anchor-lexicon-v1.json" },
	},
} as const satisfies CommandSpec

interface Options {
	output?: string
}

/**
 * THE shared word-normalization rule (mirrored verbatim in gazetteer_anchor.py and the TS matcher — documented in
 * `rules.word_norm` below): per whitespace-word, strip LEADING/TRAILING characters that are not Unicode letters or
 * digits (keep internal ones: "timor-leste", "u.s.a"), then rejoin single-spaced. Entry keys and scanned tokens both
 * pass through it, so "U.S.A." ≡ "u.s.a".
 */
/**
 * Normalize a surface for the case-insensitive map.
 */
/**
 * Short alphabetic code (≤3 letters once punctuation is dropped) → exact-uppercase matching.
 */
const isShortCode = (s: string): boolean => {
	const letters = s.replaceAll(/[^\p{L}]/gu, "")

	return letters.length > 0 && letters.length <= MAX_ABBREVIATION_LETTERS && /^[\p{L}.\s]+$/u.test(s)
}

const GazetteerAnchorLexicon: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { wordNorm, wordNormLower } = await import("@mailwoman/codex")
		const { COUNTRY_LOOKUP } = await import("@mailwoman/codex/country")

		const { US_PO_BOX_DESIGNATORS, US_STATE_ABBREVIATIONS, US_STATE_BY_ABBREVIATION } =
			await import("@mailwoman/codex/us")

		const { repoRootPathBuilder } = await import("@mailwoman/core/utils")

		const output = options.output ?? String(repoRootPathBuilder("data", "gazetteer", "anchor-lexicon-v1.json"))

		// surface → bits, split across the two match-rule maps.
		const entries = new Map<string, number>() // lowercase key
		const codeEntries = new Map<string, number>() // exact-uppercase key
		let maxNgram = 1

		const add = (surface: string, bit: number): void => {
			const s = surface.trim()

			if (!s) return

			if ((bit === BIT.country || bit === BIT.region) && isShortCode(s)) {
				const key = wordNorm(s).toUpperCase()

				if (key) {
					codeEntries.set(key, (codeEntries.get(key) ?? 0) | bit)
				}

				return
			}

			const key = wordNormLower(s)

			if (!key) return
			maxNgram = Math.max(maxNgram, key.split(" ").length)
			entries.set(key, (entries.get(key) ?? 0) | bit)
		}

		// ── country: COUNTRY_LOOKUP already aggregates canonical names + alpha-2 + alpha-3 + curated
		// surface forms (lowercase-keyed) — consume it directly so this builder can't drift from codex.
		for (const surface of COUNTRY_LOOKUP.keys()) {
			add(surface, BIT.country)
		}

		// ── region (US first cut): state names + USPS abbreviations ──────────────────────────────────
		for (const name of Object.values(US_STATE_BY_ABBREVIATION)) {
			add(name, BIT.region)
		}

		for (const abbrev of US_STATE_ABBREVIATIONS) {
			add(abbrev, BIT.region)
		}

		// ── po_box designators (case-insensitive even when short — "Box 17" is titlecase) ────────────
		for (const d of US_PO_BOX_DESIGNATORS) {
			const key = wordNormLower(d)
			maxNgram = Math.max(maxNgram, key.split(" ").length)
			entries.set(key, (entries.get(key) ?? 0) | BIT.po_box)
		}

		// ── cedex (FR) ──────────────────────────────────────────────────────────────────────────────
		entries.set("cedex", (entries.get("cedex") ?? 0) | BIT.cedex)

		// ── homograph bit: surface is BOTH a country and a region candidate ──────────────────────────
		for (const map of [entries, codeEntries]) {
			for (const [key, bits] of map) {
				if (bits & BIT.country && bits & BIT.region) {
					// oxlint-disable-next-line oxc/bad-bitwise-operator -- genuine bit-set union, not a mistyped logical or
					map.set(key, bits | BIT.homograph)
				}
			}
		}

		const homographs = [...entries, ...codeEntries].filter(([, b]) => b & BIT.homograph).map(([k]) => k)

		const lexicon = {
			version: 1,
			generated_by: "mailwoman gazetteer anchor-lexicon (source: @mailwoman/codex)",
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
				code_entries:
					"case-SENSITIVE exact: word_norm(token) == key (keys uppercase; the surface must already BE uppercase, so 'in' the word ≠ 'IN' the code). n-gram length 1 only.",
				scan: "longest-first n-gram over whitespace words, left to right, non-overlapping",
			},
			entries: Object.fromEntries([...entries].toSorted(([a], [b]) => a.localeCompare(b))),
			code_entries: Object.fromEntries([...codeEntries].toSorted(([a], [b]) => a.localeCompare(b))),
		}

		await makeDirectories(dirname(output))
		await writeLocalJSONFile(lexicon, output)

		return [
			`${output}`,
			`${entries.size} entries + ${codeEntries.size} code_entries, max_ngram=${maxNgram}`,
			`${homographs.length} homographs: ${homographs.slice(0, MAX_LISTED_HOMOGRAPHS).join(", ")}${homographs.length > MAX_LISTED_HOMOGRAPHS ? ", …" : ""}`,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ wrote " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerAnchorLexicon
