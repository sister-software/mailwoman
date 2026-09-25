/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Lists the hard-case board rows copied from regression cases instead of written by hand.
 */

import type { HardCaseClass } from "#eval-harness/hard-case-board"

/**
 * Lists regression cases that the hard-case board copies.
 *
 * Each entry points at a case id in `gauntlet/cases/<cc>/regression.jsonl`.
 * The builder copies that case's input, coordinate and tolerance, so the board
 * and the corpus cannot disagree.
 *
 * This file sets only the class and the probe surface.
 * To change an input, change the regression case.
 */
export const SWEEP_ROWS: Array<{
	cc: string
	caseID: string
	class: HardCaseClass
	probeSurface: string
	note: string
}> = [
	// `country_structure` rows use national addressing structures that the corpus does not cover.
	// Every one lies outside the FST countries.
	{
		cc: "br",
		caseID: "br-cs-rua-augusta-1000-cerqueira",
		class: "country_structure",
		probeSurface: "Cerqueira",
		note: "BR rua/bairro structure.",
	},
	{
		cc: "cn",
		caseID: "cn-cs-nanjing-road-huangpu-shanghai",
		class: "country_structure",
		probeSurface: "Nanjing",
		note: "CN road/district structure — the street NAME is a major city, and the sweep landed 272 km away on Nanjing itself.",
	},
	{
		cc: "id",
		caseID: "id-cs-jl-jendral-sudirman-no",
		class: "country_structure",
		probeSurface: "Sudirman",
		note: "ID jalan structure.",
	},
	{
		cc: "pk",
		caseID: "pk-cs-house-4-street-25",
		class: "country_structure",
		probeSurface: "Islamabad",
		note: "PK sector structure (house/street/sector numbering).",
	},
	{
		cc: "pl",
		caseID: "pl-cs-ul-marsza-kowska-4",
		class: "country_structure",
		probeSurface: "Warszawa",
		note: "PL ulica structure.",
	},
	{
		cc: "sg",
		caseID: "sg-cs-blk-12-kallang-ave",
		class: "country_structure",
		probeSurface: "Kallang",
		note: "SG block/postal structure.",
	},
	{
		cc: "vn",
		caseID: "vn-cs-12-ly-thai-to",
		class: "country_structure",
		probeSurface: "Hoan Kiem",
		note: "VN street/ward structure — the sweep landed 7,019 km away, in Кемь.",
	},
	{
		cc: "za",
		caseID: "za-cs-14-long-st-green",
		class: "country_structure",
		probeSurface: "Green Point",
		note: "ZA suburb/postal structure.",
	},
	{
		cc: "eg",
		caseID: "eg-cs-1-tahrir-square-downtown",
		class: "country_structure",
		probeSurface: "Tahrir",
		note: "EG venue/square structure.",
	},
	{
		cc: "ph",
		caseID: "ph-cs-barangay-san-antonio-makati",
		class: "country_structure",
		probeSurface: "San Antonio",
		note: "PH barangay structure — 'San Antonio' is also a major US city, and the sweep landed 13,532 km away on it.",
	},

	// `fst_out_of_reach` rows are namesakes in countries that no shipped FST covers.
	// No arm can win them, so they are reported apart to keep a tie from reading as a harmless change.
	{
		cc: "bw",
		caseID: "bw-cs-gaborone",
		class: "fst_out_of_reach",
		probeSurface: "Gaborone",
		note: "Sweep family-C. No BW FST in any arm. Measured root cause: the alternate-names join attaches 'Gaborone' to an Austrian hamlet.",
	},
	{
		cc: "sc",
		caseID: "sc-cs-victoria",
		class: "fst_out_of_reach",
		probeSurface: "Victoria",
		note: "Sweep family-C — the Seychelles capital against the surface us-cf-victoria-texas also probes.",
	},
	{
		cc: "fk",
		caseID: "fk-cs-stanley",
		class: "fst_out_of_reach",
		probeSurface: "Stanley",
		note: "Sweep family-C — the Falklands capital; pairs with us-cf-stanley-north-dakota.",
	},
	{
		cc: "do",
		caseID: "do-cs-santiago",
		class: "fst_out_of_reach",
		probeSurface: "Santiago",
		note: "Sweep family-C — a THIRD Santiago (DR), alongside the Chilean capital and the US hamlets.",
	},
	{
		cc: "ky",
		caseID: "ky-cs-george-town",
		class: "fst_out_of_reach",
		probeSurface: "George Town",
		note: "Sweep family-C — spelling-variant trap; the sweep landed 17,261 km away.",
	},
	{
		cc: "sh",
		caseID: "sh-cs-jamestown",
		class: "fst_out_of_reach",
		probeSurface: "Jamestown",
		note: "Sweep family-C — St Helena against the US bearers.",
	},
	{
		cc: "bm",
		caseID: "bm-cs-hamilton",
		class: "fst_out_of_reach",
		probeSurface: "Hamilton",
		note: "Sweep family-C — Bermuda's capital; pairs with us-cf-hamilton-ohio (120 US bearers).",
	},
	{
		cc: "ru",
		caseID: "ru-cs-moscow",
		class: "fst_out_of_reach",
		probeSurface: "Moscow",
		note: "Sweep family-C — the exonym; pairs with us-cf-moscow-idaho.",
	},
	{
		cc: "bs",
		caseID: "bs-cs-nassau",
		class: "fst_out_of_reach",
		probeSurface: "Nassau",
		note: "Sweep family-C — resolved to NOTHING in the sweep. The corpus twin of us-wpc-nassau-bahamas, which asserts the same place through an en-us query.",
	},
]
