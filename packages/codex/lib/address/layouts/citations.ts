// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The primary document behind each rendered layout that isn't a UPU Postal Addressing Systems reading.
 *
 * A UPU reading stores its citation in its own record, `UPU_PAS_LAYOUT_RECORDS`.
 * This table holds the citation of a layout rendered from the hand-authored board table
 * or from the libaddressinput skeleton. libaddressinput is the dataset the skeleton came
 * from, so an entry here records the document a reader compared that skeleton with,
 * and the details the skeleton prints differently.
 *
 * Each example is transcribed from the description's PDF text layer, one string per
 * printed line, with the description's line labels left out.
 */

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"

/**
 * The date every description below was retrieved and hashed.
 */
const RETRIEVED_AT = "2026-11-24"

/**
 * A citation of the UPU Postal Addressing Systems description filed under `iso3`.
 */
function upuDescription(
	iso3: string,
	documentDate: string,
	sha256: string,
	examples: readonly (readonly string[])[],
	unexpressed: readonly string[]
): LayoutCitation {
	return {
		source: ConventionSource.PostalAddressingSystems,
		url: `https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/${iso3}En.pdf`,
		documentDate,
		retrievedAt: RETRIEVED_AT,
		sha256,
		examples,
		unexpressed,
	}
}

/**
 * The description France's overseas departments and collectivities defer to with `See France`.
 *
 * Its lines 2 and 3, the delivery point and the building, print above the street,
 * and its line 5, the P.O. box, prints below it.
 */
const FRENCH_LINES_ABOVE_STREET =
	"the delivery-point and building lines France's description prints above the street (`See France`); this layout prints the unit after the street"

/**
 * Citations by ISO 3166-1 alpha-2, for countries the UPU table doesn't render.
 */
export const LAYOUT_CITATIONS: Readonly<Record<string, LayoutCitation>> = {
	AU: upuDescription(
		"aus",
		"2017-7",
		"f137a0d8c32114de34e3138593caecb63356e7cd0d8e372b93673c1278dd27fa",
		[
			["MR. RON JAMES", "4360 DUKES RD", "KALGOORLIE WA 6430", "AUSTRALIA"],
			["MS. C. FITZGERALD", "LEVEL 6 51 JACOBSON ST", "BRISBANE QLD 4000", "AUSTRALIA"],
		],
		[
			"the floor and door before the house number on the street line (`LEVEL 6 51 JACOBSON ST`); this layout prints the unit after the street",
			"one or, preferably, two spaces between the locality, the state and the postcode",
		]
	),
	BA: upuDescription(
		"bih",
		"2019-4",
		"b2fcfde02e9358931364d2526990d587b4b694acd35d98ee043f2bed2f5acdff",
		[
			["Demira Isaković", "Semira Frašte E6/6", "71000 SARAJEVO", "BOSNIA AND HERZEGOVINA"],
			["HUD PROMET d.o.o.", "Poslovna jedinica br.2 Sapna", "Sapna BB", "75411 SAPNA", "BOSNIA AND HERZEGOVINA"],
		],
		["the organization unit line between the organization and the street (`Poslovna jedinica br.2 Sapna`)"]
	),
	BL: upuDescription(
		"blm",
		"2011-8",
		"04d3cd4fa011168b3804ae0331cc713ac3136ac3d6081ad8704f6b7cecd3890a",
		[["Monsieur Jean DURAND", "5 RUE VICTOR HUGO", "97133 SAINT-BARTHELEMY", "FRANCE"]],
		[FRENCH_LINES_ABOVE_STREET]
	),
	BT: upuDescription(
		"btn",
		"2010-2",
		"b878c01e760fb749f91c3e36aedc0a0e5f65a3437adf20dbed87f1f99bfb2be9",
		[["Tenzin Wangchuk", "Chang Lam, JD House", "Flat No. 2B", "Zone 4", "Thimphu 11001", "BHUTAN"]],
		[
			"the flat on its own line below the street (`Flat No. 2B`); this layout prints the unit on the street line",
			"the building name after the street, separated by a comma (`Chang Lam, JD House`)",
		]
	),
	CA: upuDescription(
		"can",
		"2014-9",
		"3d3f804ce949bf3edc0493c389077e9cd93d03f5f3c3d5803d83c53ed8099b3d",
		[["JOHN JONES", "MARKETING DEPT", "10–123 ½ MAIN STREET NW", "MONTREAL QC H3Z 2Y7", "CANADA"]],
		[
			"the unit before the house number, joined by a hyphen (`10–123 ½ MAIN STREET NW`); this layout prints the unit after the street",
		]
	),
	DE: upuDescription(
		"deu",
		"2015-1",
		"aaa1341bc960ab3c38fd0ca1aebc4291a06ac505178c04b256c2538da5fddbab",
		[
			["Herrn", "Quincy Happy", "Wacholderweg 52a", "26133 OLDENBURG", "GERMANY"],
			["Liselotte Sommer", "Rhondorfer Str. 666 // Appartment 47", "50939 KÖLN", "GERMANY"],
			["Schloß Britz", "Ortsteil Neukoelln", "Alt-Britz 73", "12359 BERLIN", "GERMANY"],
		],
		[
			"the sub-locality above the street (`Ortsteil Neukoelln` then `Alt-Britz 73`); this layout prints the district below the street",
			"the apartment after the number, separated by `//`",
			"the Packstation form: a customer number line, then `Packstation 101`, then the postcode and locality",
		]
	),
	DZ: upuDescription(
		"dza",
		"2002-7",
		"9be861e4fbc48cc6a39cf00adc7b2231079a64e1dd1a63f49ef86763b5f36533",
		[["M. Said Mohamed", "2, rue de l'Indépendance", "16027 ALGIERS", "ALGERIA"]],
		["the comma after the house number (`2, rue de l'Indépendance`)"]
	),
	ES: upuDescription(
		"esp",
		"2013-1",
		"2bd575a2d7c6d91451efc689c6817e231ca3c8c2f3f912a4dc05b9b97be24e43",
		[
			["Sr. D. Jaime Lozano Seguí", "Plaza de las Descalzas 27, Esc 2, 3º, C", "45012 TOLEDO", "TOLEDO", "SPAIN"],
			[
				"Srta. Carmen Garcés Casero",
				"Edificio Lepanto",
				"Calle Huertas 18, 4º, C",
				"29400 MARBELLA",
				"MÁLAGA",
				"SPAIN",
			],
		],
		[
			"the number after the street name with no comma (`Calle Huertas 18`); this layout writes `Mainstreet, 12`",
			"the province on its own line below the postcode and locality; this layout prints it on the locality line",
			"the building line above the street (`Edificio Lepanto`)",
		]
	),
	FR: upuDescription(
		"fra",
		"2011-9",
		"54c80b84d6f5a7480887b8e9a1848758ddf9e91cfa899fb259e6ddea110b2ae0",
		[
			["Monsieur Jean DURAND", "25 RUE DES FLEURS", "33500 LIBOURNE", "FRANCE"],
			[
				"Monsieur Jean DELHOURME",
				"Chez Mireille COPEAU Apartment 2",
				"Entrée A Bâtiment Jonquille",
				"25 RUE DE L EGLISE",
				"CAUDOS",
				"33380 MIOS",
				"FRANCE",
			],
		],
		[
			"lines 2 and 3, the delivery point and the building, above the street; this layout prints the unit after the street",
			"line 5, the P.O. box or lieu-dit, below the street (`BP 40122`)",
		]
	),
	GB: upuDescription(
		"gbr",
		"2011-11",
		"fd1a751e7694578ac80e56c3c18fffc4163499694448b5891a5c47ddfa132b22",
		[
			["Mr. Walter C. Brown", "49 Featherstone Street", "LONDON", "EC1Y 8SY", "UNITED KINGDOM"],
			["Victoria House", "15 The Street", "Hurn", "CHRISTCHURCH", "BH23 6AA", "UNITED KINGDOM"],
		],
		["the dependent thoroughfare and double dependent locality lines (`1A Seastone Cottages` above `Station Road`)"]
	),
	GF: upuDescription(
		"guf",
		"2011-8",
		"f2282deb65219c1eba76288dd3dd4b8f05a87a87f704af0bd77e8b99f6fc4a2a",
		[["Monsieur Jean DURAND", "3 AVENUE HENRI AGARANDE", "97300 CAYENNE", "FRANCE"]],
		[FRENCH_LINES_ABOVE_STREET]
	),
	GL: upuDescription(
		"grl",
		"2003-7",
		"044d75ec4cd29864a37d788138792866c8c6f51c7f75aa853471eaa01f1c9933",
		[["See Denmark."]],
		[
			"Denmark's description (`dnkEn.pdf`, 05/2024, sha256 306d35ea6a52e6c6981e67bb115c0934c8050c2841dccebdf9a4c749e7915f2f) prints the district on the street line after the number and floor (`Kastanievej 15, 2, Agerskov`); this layout prints it on its own line",
		]
	),
	GP: upuDescription(
		"glp",
		"2011-8",
		"c4d2a72ca1850cfbac6aeb7203d3c930aab674d0c1888ae755345541a24445d1",
		[["Monsieur. Jean DURAND", "3 ALLEE DES ACACIAS", "97100 BASSE TERRE", "FRANCE"]],
		[FRENCH_LINES_ABOVE_STREET]
	),
	GS: upuDescription(
		"sgs",
		"2005-8",
		"b301ba2e6f28548adcb193cda244c07e0003ec7be209913c9acea6a02ebcd928",
		[["Mr. I. Hunt", "King Edward Point", "SIQQ 1ZZ", "SOUTH GEORGIA ISLAND"]],
		["the example prints no locality line: `King Edward Point` is the delivery point above the postcode"]
	),
	HU: upuDescription(
		"hun",
		"2012-1",
		"f0cc8f019c4330c063a135f48efd618d10e896e34c64735e1b925ca8b4aeaf25",
		[
			["MÁTÉ JÓZSEF", "BUDAPEST", "VIRÁG TÉR 3. IV. 61", "1037", "HUNGARY"],
			["JELES ÉVA", "DABAS", "PF. 83", "2380", "HUNGARY"],
		],
		["the floor and apartment after the house number (`3. IV. 61`)"]
	),
	IS: upuDescription(
		"isl",
		"2002-7",
		"f5b5405d099f25928356c85f05b137e9c823d62a4de7327622968726d4365443",
		[
			["Hr. Guðmundur Árnasson", "Tryggvagötu 5", "220 HAFNARFIRĐI", "ICELAND"],
			["Jón Sigurðsson", "Pósthólf 1550", "121 REYKJAVÍK", "ICELAND"],
		],
		["none: each example prints the street with its number, then the postcode and locality"]
	),
	IT: upuDescription(
		"ita",
		"2020-4",
		"aaa8365d42cb714f18cf9f53b0848f7b0879a3d759aa67c89aea8697cb130650",
		[
			["SIG. MARIO ROSSI", "VIALE EUROPA 22", "00122 ROMA RM", "ITALY"],
			["SIG. MARIO ROSSI", "INTERNO 12 PIANO 10", "VIALE EUROPA 300", "00144 ROMA RM", "ITALY"],
		],
		[
			"line 3, the stairway, floor and apartment, above the street (`INTERNO 12 PIANO 10`)",
			"the province as its two-letter code (`RM`)",
		]
	),
	JE: upuDescription(
		"jey",
		"2005-3",
		"50aa20d6971f8bd8df3184ae09308644e97a1c7cb86dcaab8081a582895d4808",
		[
			["See United Kingdom of Great Britain and Northern Ireland."],
			["Jersey Post", "Postal Head Quarters", "JERSEY", "JE1 1AA", "CHANNEL ISLANDS"],
		],
		["the United Kingdom description's dependent thoroughfare and double dependent locality lines"]
	),
	ME: upuDescription(
		"mne",
		"2019-8",
		"862da339618e9fb2f1307df4286ef4239f5316dafc937100e008d7b4f6c2c151",
		[
			["Mr Petar Petrovic", "Ul. Slobode br. 1", "81000 PODGORICA", "MONTENEGRO"],
			["Ivan Ivanović", "Avda Međedovića 15 stan 15", "85000 BAR", "MONTENEGRO"],
		],
		["the flat after the number, introduced by `stan` or `/` (`Bracana Bracanovića 11/15`)"]
	),
	MF: upuDescription(
		"maf",
		"2011-8",
		"25b04d3e810200597e76fc27ec9043de41bb6a259a13a1e6d4971e229dbb3c97",
		[["Monsieur Jean DURAND", "5 RUE DES ACACIAS", "97150 SAINT-MARTIN", "FRANCE"]],
		[FRENCH_LINES_ABOVE_STREET]
	),
	NC: upuDescription(
		"ncl",
		"2013-9",
		"489919efe684a89c3d521883d6bd3751929052fe0f654460318d1e7d4b735a45",
		[
			[
				"Ms. CELINE BELLE",
				"APPARTEMENT 15",
				"BATIMENT LES JONQUILLES",
				"24 RUE DES PALMIERS",
				"98800 NOUMEA",
				"NEW CALEDONIA",
			],
		],
		[
			"the apartment and building lines above the street (`APPARTEMENT 15`, `BATIMENT LES JONQUILLES`); this layout prints the unit after the street",
		]
	),
	NZ: upuDescription(
		"nzl",
		"2014-8",
		"e4e3ec906985986ee3c277814c9907d3abb0f5d4ca374da2f6810d18c4804618",
		[
			["Jollys Jewellery", "236 Majoribanks Street", "Mount Victoria", "WELLINGTON 6011", "NEW ZEALAND"],
			["Mrs Brown", "Maplethorp Farm", "287 Guy Road", "RD 2", "KAIAPOI 7692", "NEW ZEALAND"],
		],
		["the rural delivery line below the street (`RD 2`)"]
	),
	PR: upuDescription(
		"pri",
		"2005-3",
		"20d5990965d42f9c00b66376e71dc1be626cd43ae90b3ecc77078ca8f9605af4",
		[
			[
				"Puerto Rico follows the United States of America postal system. Its state code is PR and",
				"its postal codes range from 00601 to 00799 and from 00901 to 00999.",
			],
		],
		[
			"the urbanización and condominium lines above the street that the United States description's Puerto Rico examples print (`URB LAS GLADIOLAS`, `COND LAS AMAPOLAS`)",
		]
	),
	SH: upuDescription(
		"shn",
		"2005-8",
		"3e1946f849857d5f382096c6763bfeef27736b2012a48e7a5096b41a1033b4c6",
		[["Mr. D.K. Wellington", "6 High Street", "JAMESTOWN", "STHL 1ZZ", "ST. HELENA"]],
		["none: the example prints the number and street, the post town, then the postcode on its own line"]
	),
	SR: upuDescription(
		"sur",
		"2005-3",
		"65a2a969de23d5567bfdcdc417a52ca086d5fccdb41268a5566f81d6bf1cdb42",
		[["Ms. Saskia Panka", "Walapastraat 2", "Bloemendal", "PARAMARIBO", "SURINAME"]],
		[
			"the example prints no district line apart from `PARAMARIBO`, which names a district and its city; this layout prints a region line below the locality",
		]
	),
	TC: upuDescription(
		"tca",
		"2025-10",
		"81411e006295b278736bdde53996cfcfa193ee3b27f6ea9b6764ef5f7f19cb48",
		[["George Brown Post Office", "Airport road", "DOWNTOWN, PROVIDENCIALES", "TKCA1ZZ", "TURKS AND CAICOS ISLAND"]],
		[
			"the only address printed is the operator's contact block, which writes the district and the locality on one line (`DOWNTOWN, PROVIDENCIALES`); this layout prints the district on its own line",
		]
	),
	US: upuDescription(
		"usa",
		"2010-6",
		"6aaf7be56335d60b31c8fd5f88b543f6a42d4f04c0ff24b72d43a49663e0b1e1",
		[
			["MR JOHN DOE", "123 MAGNOLIA ST", "HEMPSTEAD NY 11550–1234", "UNITED STATES OF AMERICA"],
			["ABC MOVERS", "1500 E MAIN AVE STE 201", "SPRINGFIELD VA 22162–1010", "UNITED STATES OF AMERICA"],
		],
		[
			"no comma after the locality (`HEMPSTEAD NY`); this layout writes `Springfield, VA`",
			"two spaces between the state and the postcode",
		]
	),
	WF: upuDescription(
		"wlf",
		"2011-8",
		"8eef5f94220cb0e9505ac89a644259db8ef0944e5f31966300ee1eca032dd5ee",
		[
			[
				"Monsieur Jean DELHOURME",
				"Appartment 25",
				"Entrée A Bâtiment Jonquille",
				"14 RUE DE L OCEAN",
				"BP 42",
				"98600 UVEA",
				"FRANCE",
			],
		],
		[
			"the apartment and building lines above the street; this layout prints the unit after the street",
			"the P.O. box line below the street (`BP 42`)",
		]
	),
}
