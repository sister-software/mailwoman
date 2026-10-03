/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Records the search tests share. Two share a URL so the collapse to one hit per page is observable,
 *   and one is a level-5 table row.
 */

import type { SearchRecord } from "@mailwoman/react/search/types"

const N = null

/**
 * Five records over four pages, shared by the index writer and query tests.
 */
export const FIXTURE_RECORDS: SearchRecord[] = [
	{
		id: "viterbi-top",
		url: "/docs/kb/decoding-and-viterbi",
		anchor: "",
		hierarchy: ["Address intelligence", "Decoding and Viterbi", N, N, N, N, N],
		content: "The decoder reads a grammar.",
		level: 1,
		position: 0,
	},
	{
		id: "viterbi-section",
		url: "/docs/kb/decoding-and-viterbi",
		anchor: "objective",
		hierarchy: ["Address intelligence", "Decoding and Viterbi", "The objective", N, N, N, N],
		content: "The viterbi objective is a sum of span scores over the decoder grammar.",
		level: 2,
		position: 1,
	},
	{
		id: "tiers",
		url: "/docs/reference/locales-and-tiers",
		anchor: "",
		hierarchy: ["Reference", "Locales and tiers", N, N, N, N, N],
		content: "Tier-1 locales ship with a regression bar.",
		level: 1,
		position: 0,
	},
	{
		id: "parsers",
		url: "/docs/how-to/validate",
		anchor: "",
		hierarchy: ["How-to guides", "Validate addresses", N, N, N, N, N],
		content: "Two parsers disagree on a flat number.",
		level: 1,
		position: 0,
	},
	{
		id: "row",
		url: "/docs/reference/coverage",
		anchor: "rows",
		hierarchy: ["Reference", "Coverage", "Rows", N, N, "Norway", N],
		content: "Elected",
		level: 5,
		position: 3,
	},
]
