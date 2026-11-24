// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The citations the AC–GE review of 2026-11-24 read, for layouts that already
 * print what the postal operator's document prints.
 *
 * `LAYOUT_CITATIONS` in `#address/layouts/citations` holds them beside the rest.
 * Each example is transcribed from the description's PDF text layer.
 * Each string is one printed line.
 */

import type { LayoutCitation } from "#address/convention-claims"
import { upuDescription } from "#address/layouts/citations/upu-description"

/**
 * The description American Samoa and Micronesia defer to, with the details it
 * prints that this layout prints differently.
 *
 * It is `usaEn.pdf`, dated 06/2010.
 * Its sha256 is 6aaf7be56335d60b31c8fd5f88b543f6a42d4f04c0ff24b72d43a49663e0b1e1.
 *
 * Its example prints `123 MAGNOLIA ST` above `HEMPSTEAD NY 11550–1234`.
 */
const UNITED_STATES_DESCRIPTION =
	"the United States description this one defers to (`usaEn.pdf`, 06/2010, sha256 6aaf7be56335d60b31c8fd5f88b543f6a42d4f04c0ff24b72d43a49663e0b1e1) prints two spaces between the state and the postcode (`HEMPSTEAD NY 11550–1234`); this layout prints one"

/**
 * The note of a description whose examples print no street.
 */
const NO_STREET_EXAMPLE =
	"no example prints a street, so the street line keeps the order the generator's street table states"

/**
 * Citations by ISO 3166-1 alpha-2.
 */
export const AC_GE_LAYOUT_CITATIONS: Readonly<Record<string, LayoutCitation>> = {
	AC: upuDescription(
		"asc",
		"2005-8",
		"c334e32dda7b7ffb35be420171578f6ff08ff82271480a8f4ae15dd5db0c546e",
		[["Mr. W.D. Awake", "2 Main Street", "GEORGETOWN", "ASCN 1ZZ", "ASCENSION"]],
		["none: the example prints the number and street, the post town, then the postcode on its own line"]
	),
	AI: upuDescription(
		"aia",
		"2017-9",
		"6c7d3ec9cad17c159e4b66d85e319bbef9518edab4f1fde6f2a4bf136b9c8218",
		[["Ms Laureen Conor", "P.O. Box 60", "The Valley", "AI-2640", "ANGUILLA, BWI"]],
		[NO_STREET_EXAMPLE, "the `BWI` after the country name (`ANGUILLA, BWI`)"]
	),
	AL: upuDescription(
		"alb",
		"2014-9",
		"909b0d28fc55ce2f3a2a8b6e7a57fad2e2d07320e73c1d6a5a58bdcc3b5f7ace",
		[
			["Ilir Drenova", "Ruga Myslym Shyri", "Pallati 37 shkalla 4 apartamenti 15", "1001", "TIRANA", "ALBANIA"],
			["Arben Leka", "Fshati Arbane", "1041", "VAQAR", "TIRANA", "ALBANIA"],
		],
		[
			"the building, staircase and flat on their own line below the street name (`Pallati 37 shkalla 4 apartamenti 15`); this layout prints the number and unit after the street name",
			"the rural example's post office line between the postcode and the locality (`VAQAR`); this layout prints the district line there",
		]
	),
	AS: upuDescription(
		"asm",
		"2003-7",
		"90aae26be71d9983df78d903cfe766cf0976db3fc9d82db6c727d13072402aba",
		[["American Samoa follows the United States of America postal system."]],
		[
			UNITED_STATES_DESCRIPTION,
			"the district line above the locality, which the United States description doesn't print",
		]
	),
	AX: upuDescription(
		"ala",
		"2019-2",
		"4ecbef7cd8b746d75c5d4a04afc8575eb5db56172403137908be719e766c428c",
		[["Ålands Museum", "Stadshusparken", "AX-22100 MARIEHAMN", "ÅLAND", "FINLAND"]],
		[
			"the island line between the locality and the country (`ÅLAND`)",
			"`FINLAND` as the country line; this layout prints the country slot's value",
		]
	),
	BB: upuDescription(
		"brb",
		"2014-11",
		"71cfb3fc8c608e423132409bdd311131131279e21636ac9b8942a5403dd6a1d6",
		[
			["Mr. John Browne", "#35, “The Grotto”", "04th Ave., Cherry Lane", "Farm Road", "St. Peter BB26028", "BARBADOS"],
			["Police Station Complex", "Holetown,", "St. James BB24000", "BARBADOS"],
		],
		[
			"the sub-locality on its own line above the parish and postcode (`Holetown,` then `St. James BB24000`); this layout prints the locality, a comma and the parish on one line",
			"the premises line above the street (`#35, “The Grotto”`)",
		]
	),
	BD: upuDescription(
		"bgd",
		"2014-9",
		"3b4f32fd14faa2764192fa190850038d4e1eaf038e2be0daae72d5acfd7e9ad4",
		[
			["Mr. Ashraduddin Khan", "Vil Genda", "P.O. SAVAR", "DHAKA – 1340", "BANGLADESH"],
			["Senior Postmaster", "Chittagong GPO", "CHITTAGONG – 4000", "BANGLADESH"],
		],
		[
			"the en dash between the locality and the postcode (`DHAKA – 1340`); this layout prints a hyphen",
			"the delivery post office line (`P.O. SAVAR`)",
		]
	),
	BH: upuDescription(
		"bhr",
		"2024-1",
		"790f4864d6ef0f4c224024768d43c9269364e3a50682104ae68dfbe82a2681ec",
		[
			["Mr. Abdullah Ahmed Abdullah", "House no. 888", "Sheikh Abdulla Road", "AL-MANAMAH 317", "BAHRAIN"],
			["M. Abdullah Ahmed Abdullah", "House 916", "Road 2035", "RIFFA 926", "BAHRAIN"],
			["Mr. Abdullah Ahmed Abdullah", "P.O Box 1212", "AL-MANAMAH 317", "BAHRAIN"],
		],
		[
			"the house number on its own line above the street (`House no. 888` then `Sheikh Abdulla Road`); this layout prints the number before the street on one line",
		]
	),
	BN: upuDescription(
		"brn",
		"2019-1",
		"f445c70b73bf805f4b2b9f36447ec019688ec541f528853ac7193c13ffe06d37",
		[
			["JOHN WALKER", "NO. 7 SIMPANG 170, JALAN MUARA", "KAMPONG KAPOK", "MUARA BT2328", "BRUNEI DARUSSALAM"],
			["UNIT KARTOGRAFI", "JABATAN UKUR", "BANDAR SERI BEGAWAN BA1511", "BRUNEI DARUSSALAM"],
			["SYARIKAT WILLIAM", "PETI SURAT 999", "KUALA BELAIT KA1131", "BRUNEI DARUSSALAM"],
		],
		[
			"the comma between the junction and the main road (`SIMPANG 170, JALAN MUARA`); this layout prints its comma after the house number",
			"the `NO.` before the house number",
		]
	),
	BS: upuDescription(
		"bhs",
		"2025-10",
		"499818cf3672d401f7fc563e9a1a085af79b2de64e04ec5325c1063b27601831",
		[["John Doe", "P.O. Box GT 2001", "Nassau", "BAHAMAS"]],
		[
			NO_STREET_EXAMPLE,
			"the post office abbreviation inside the P.O. box (`P.O. Box GT 2001`), which belongs to the box's value",
		]
	),
	BW: upuDescription(
		"bwa",
		"2004-9",
		"6409e4792a773e2bfabe6ccd9927e2816420e380873632788a6b9b4868f3e666",
		[
			["Mr. Poso Mogae", "P.O. Box 231", "HUKUNTSI", "BOTSWANA"],
			["Mr. Poso Mogae", "P/Bag 1061", "GABORONE", "BOTSWANA"],
		],
		[NO_STREET_EXAMPLE, "the private bag line (`P/Bag 1061`) in the P.O. box's place"]
	),
	BY: upuDescription(
		"blr",
		"2018-7",
		"5e090d60ed6f5f266aad180c412adad6822f512d0f18aa97432bbf1349c99e14",
		[
			["Svistunovu Ivanu Ivanovichu", "pr-t Mašerova, d.1, kv.12", "220005, g. Minsk", "REPUBLIC OF BELARUS"],
			['ZAO "Kalinka"', "pr-t Mira, d.28", "223709, g. Soligorsk", "Minskaya obl.", "REPUBLIC OF BELARUS"],
			[
				"Svistunovu Ivanu Ivanovichu",
				"ul. Miroshnichenko, d.1, kv.2",
				"222615, ag. Snov",
				"Nesvizhskogo r-na",
				"Minskoy obl.",
				"REPUBLIC OF BELARUS",
			],
		],
		[
			"the rural examples' district (rayon) line between the locality and the province (`Nesvizhskogo r-na`); this layout prints no subregion",
			"the `d.` and `kv.` markers and the comma between the house number and the flat (`d.1, kv.12`)",
		]
	),
	DJ: upuDescription(
		"dji",
		"2020-5",
		"bdde6a8643c1a9905dd574cce29fbcf776ac5def6c0a628095a4ab47578d9391",
		[
			["ISMAEL MOHAMED OMAR", "W3W jeunesse.livrable.brisons", "BP 1663", "77101 DJIBOUTI VILLE", "REP. DE DJIBOUTI"],
			["Mr Abdel Omar", "BP 220", "Village du Day", "Randa", "77601 TADJOURAH", "REP. DE DJIBOUTI"],
		],
		[
			"the geocoded what3words line above the P.O. box (`W3W jeunesse.livrable.brisons`)",
			"the rural form, which prints the village and the locality on their own lines and the region after the postcode (`Randa` then `77601 TADJOURAH`); this layout prints the locality after the postcode",
		]
	),
	DO: upuDescription(
		"dom",
		"2005-3",
		"3d312d2079279f81cc55e2c9754e92e0ca652b5d196e226d919e1ab83ac48020",
		[["Dominica L. Hernandez", "C/45 # 33", "Katanga, Los Minas", "11903 SANTO DOMINGO", "DOMINICAN REP."]],
		["the `#` between the street and the number (`C/45 # 33`)"]
	),
	EG: upuDescription(
		"egy",
		"2023-7",
		"86376a548e29fade9ea125d5d57cc3d378c7d6de48c745dec7d17165e9800964",
		[
			["Mohamed Ahmed Mahmoud", "30 Moussa Galal street", "Al-Mohandessine", "GIZA", "3759914", "EGYPT"],
			[
				"Mohamed Ahmed Mahmoud",
				"4 El-Mehata street - El-Zohor Village",
				"Ville El-kharga",
				"NEW VALLEY",
				"1062261",
				"EGYPT",
			],
		],
		[
			"the village after the street with a dash (`4 El-Mehata street - El-Zohor Village`)",
			"the P.O. box example's post office line (`Main Ciro post office`), which prints no postcode",
		]
	),
	ET: upuDescription(
		"eth",
		"2002-7",
		"5a5dd83db210dcabf886b717eae40420d0d92b40e9bde9f2f29e2f682e9b8fc3",
		[
			["Mr. Abebe Bekele", "K. 3 W.47 house no 268", "1000 ADDIS ABABA", "ETHIOPIA"],
			["Mr. Abebe Bekele", "P.O. Box 1519", "1000 ADDIS ABABA", "ETHIOPIA"],
		],
		[
			"the geographical address of kebele, wereda and house number (`K. 3 W.47 house no 268`); this layout prints a street line",
		]
	),
	FK: upuDescription(
		"flk",
		"2005-8",
		"315549e7306f606adf348c33bc2abaf3e474001e9a4146138b5e829f7d353a5d",
		[["Mr. I. Fish", "10 Drury Street", "STANLEY", "FIQQ 1ZZ", "FALKLAND ISLANDS (MALVINAS)"]],
		["none: the example prints the number and street, the post town, then the postcode on its own line"]
	),
	FM: upuDescription(
		"fsm",
		"2005-3",
		"ce0366094d5e18f9db40fd89e944a52052218a8072744a5f477d9938432edc12",
		[["Micronesia follows the United States of America postal system."]],
		[UNITED_STATES_DESCRIPTION]
	),
	GE: upuDescription(
		"geo",
		"2018-1",
		"27aacdae6f63faae2595ebae92fa58d03bcb824bfb87ae495106ba8b0d2858fd",
		[["Ms. Nino Giorgobiani", "Pekini ave. #39, flat 66", "0160 TBILISI", "GEORGIA"]],
		[
			"the `#` before the house number and the comma before the flat (`Pekini ave. #39, flat 66`); this layout prints `Pekini ave. 39 flat 66`",
		]
	),
}
