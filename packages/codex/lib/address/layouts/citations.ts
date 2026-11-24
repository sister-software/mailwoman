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
 *
 * The citations the L–Z review of 2026-11-24 added sit in `citations/l-z.ts`.
 * Those the AC–GE review added sit in `citations/ac-ge.ts`.
 *
 * The split keeps each module under the repository's line ceiling.
 */

import type { LayoutCitation } from "#address/convention-claims"
import { AC_GE_LAYOUT_CITATIONS } from "#address/layouts/citations/ac-ge"
import { L_Z_LAYOUT_CITATIONS } from "#address/layouts/citations/l-z"
import { upuDescription } from "#address/layouts/citations/upu-description"

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
	AD: upuDescription(
		"and",
		"2004-9",
		"43bf5366d607167e13217e3f3bc640e1b1c584b617e418c628402800475b1dc0",
		[
			[
				"Societat TORRES",
				"Servei Compres S BARO",
				"ZONA INDUSTRIAL OEST",
				"Entrada A Edifici Les Grandalles",
				"12 AVINGUDA TORRENT PREGO",
				"BP 15",
				"AD501 ANDORRA LA VELLA",
				"ANDORRA",
			],
		],
		[
			"the Spanish postal office's form, which writes the number after the street (`AVINGUDA TORRENT PREGO 12`); this layout writes the French office's `12 AVINGUDA TORRENT PREGO`",
			"the delivery-point and building lines above the street, and the P.O. box below it",
		]
	),
	AT: upuDescription(
		"aut",
		"2014-4",
		"aa74ac059961aee6638e4951d47a1207ef3ff6332782b3fccd903b0f6c6e47be",
		[
			["Mr. Max Maier", "Rennbahnweg 25/2/15", "1220 WIEN", "AUSTRIA"],
			["Mr. Max Maier", "Weingartenweg 1", "Rafing", "3741 PULKAU", "AUSTRIA"],
		],
		["the block and flat joined to the house number with slashes (`Rennbahnweg 25/2/15`)"]
	),
	AU: upuDescription(
		"aus",
		"2017-7",
		"f137a0d8c32114de34e3138593caecb63356e7cd0d8e372b93673c1278dd27fa",
		[
			["MR. RON JAMES", "4360 DUKES RD", "KALGOORLIE WA 6430", "AUSTRALIA"],
			["MS. C. FITZGERALD", "LEVEL 6 51 JACOBSON ST", "BRISBANE QLD 4000", "AUSTRALIA"],
		],
		["one or, preferably, two spaces between the locality, the state and the postcode"]
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
	BE: upuDescription(
		"bel",
		"2012-9",
		"9182b024e3ce59a6b5bd54d9ec71e02caaeb325704b13310b5e3deb54388bd89",
		[
			["Monsieur Alain Dupont", "Rue du Vivier 7", "1000 Bruxelles", "BELGIUM"],
			["Dhr Paul Janssens", "Kortijkstraat 37 bus 1", "9800 Deinze", "BELGIUM"],
			["Dhr Paul Janssens", "Postbus 24", "9000 Gent Centrum", "BELGIUM"],
		],
		[
			"the description's rule that no sub-community follows the town and none enters the street name; this layout prints a district line between the street and the postcode, where the regional register's rows write the section (`Rue Auguste Goemans 5A BP3, Hamme-Mille, 1320 Beauvechain`)",
			"the building, floor and room line above the street (`Gebouw A - Verdiep 3 - Kamer 8`); this layout prints the unit on the street line",
			"the retail agency after the town in a P.O. box address (`9000 Gent Centrum`)",
		]
	),
	BG: upuDescription(
		"bgr",
		"2017-5",
		"dee36980bfe0db50b8bb2e5f5ce3857e32bf4069f5688de2eef10e13440f1e7a",
		[
			["Detelina Ivanova Khristova", "ul. Aleksandŭr Ekzarkh 2", "4000 PLOVDIV", "BULGARIA (REP.)"],
			["Penka Hristova Smugleva", "ul. Kokiche", "obl. Vratza", "3264 s. Mechka", "BULGARIA (REP.)"],
		],
		[
			"the rural example's province on its own line above the postcode and locality (`obl. Vratza`)",
			"the housing-estate form, with block, entrance, floor and flat after the sub-locality (`j.k. Belite Brezi, bl. 104, vh.1, et.2, ap.4`)",
		]
	),
	BL: upuDescription(
		"blm",
		"2011-8",
		"04d3cd4fa011168b3804ae0331cc713ac3136ac3d6081ad8704f6b7cecd3890a",
		[["Monsieur Jean DURAND", "5 RUE VICTOR HUGO", "97133 SAINT-BARTHELEMY", "FRANCE"]],
		[FRENCH_LINES_ABOVE_STREET]
	),
	BR: upuDescription(
		"bra",
		"2012-3",
		"db74529856993bc48d5eb44c3b430330b18bcfcb8fc53df2ff0c8bd7e2fd5c1c",
		[
			["Marina Costa e Silva", "Rua Afonso Camargo, 805", "Santana", "GUARAPUAVA – PR", "85070-200", "BRASIL"],
			["Marina Costa e Silva", "Caixa Postal 443", "Guarapuava – PR", "85100-970", "BRAZIL"],
		],
		[
			"the spaced dash between the town and the state (`GUARAPUAVA – PR`); this layout joins them with a bare hyphen",
			"the Brasília sector form (`SBN – Quadra 13 – Bloco B – 8º andar`)",
		]
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
	CC: upuDescription(
		"cck",
		"2004-9",
		"4951e4e5cca7472909454debc915524b94d5609e71c1e64667b85ed035d14896",
		[["Cocos (Keeling) Islands", "Australian Territory", "See Australia"]],
		[
			"every detail of Australia's description, which this one defers to and prints no example of; Australia's citation lists them",
		]
	),
	CH: upuDescription(
		"che",
		"2024-6",
		"530a9a37c2b0e953bf2c78e9d61d1d632438b0bbd69d71596b7ae7ffb1ddf7e6",
		[
			["Herrn", "Rudolf Weber", "Solothurnerstrasse 28", "2544 BETTLACH", "SWITZERLAND"],
			["Sandoz SA", "Rue de Bourgogne 5", "Case postale 12", "1211 GENEVA 6", "SWITZERLAND"],
			["Monsieur", "Fernand Genoud", "Rue du Marché 8", "1556 CERNIAZ VD", "SWITZERLAND"],
		],
		[
			"the P.O. box below the street (`Rue de Bourgogne 5` / `Case postale 12`); this layout prints the box above it",
			"the canton abbreviation after a locality whose name isn't unique (`1556 CERNIAZ VD`)",
			"the post office number after the town (`1211 GENEVA 6`)",
		]
	),
	CI: upuDescription(
		"civ",
		"2004-9",
		"af6e2a87af21af3143102ec66f68d8356287934219357f07b7ae626dd0c437ff",
		[["Madame KOUAME AKISSI", "COMMERCANTE", "06 B.P. 37 ABIDJAN 06", "COTE D'IVOIRE (REP.)"]],
		[
			"the P.O. box on the locality line (`06 B.P. 37 ABIDJAN 06`); this layout's street block prints the box on its own line above the office code and locality",
		]
	),
	CL: upuDescription(
		"chl",
		"2017-3",
		"61ce236665e11c3b72165cbd191571e490fd533ddf788c7ed5066a1bd48c05f1",
		[
			["Señor", "Juan Pérez", "Moneda 1152", "8340648 SANTIAGO", "REGION METROPOLITANA", "CHILE"],
			[
				"Señorita",
				"Ester Avila",
				"Avenida Palena 1084, Depto. 505, Piso 5",
				"9180794 ESTACION CENTRAL",
				"REGION METROPOLITANA",
				"CHILE",
			],
		],
		[
			"the comma before the flat and floor (`Avenida Palena 1084, Depto. 505, Piso 5`); this layout writes the unit after a space",
		]
	),
	CN: upuDescription(
		"chn",
		"2013-9",
		"0c17b0868e67173ffcea3a809d7c222ee56bde85854ea6d4af3ac78b8047fd7c",
		[
			[
				"An address written in Chinese will start with the biggest geographical component (the province)",
				"and end with the smallest one (the addressee). However, the name of the country (P.R. CHINA)",
				"must be written in an internationally known language.",
			],
		],
		[
			"a Chinese-script example, which the description doesn't print: the postcode's place in the Chinese order is libaddressinput's `%Z` first line",
			"the Latin order, smallest first (`No.1 Jianguomenwai Avenue` / `100004 BEIJING`), which the Latin layout renders",
		]
	),
	CX: upuDescription(
		"cxr",
		"2004-9",
		"38561cf6b92521227903d7817cede831d71b1524c050f2937461d87a94d508fa",
		[["Christmas Island", "Australian Territory", "See Australia"]],
		[
			"every detail of Australia's description, which this one defers to and prints no example of; Australia's citation lists them",
		]
	),
	CY: upuDescription(
		"cyp",
		"2023-3",
		"3ffaf57736cafb95f7d97acd9bd65deac876de8a64c2db038762f026bd26335b",
		[
			["Mr Andreas Panagiotou", "Sofocleous 26", "CY-2008 Strovolos", "CYPRUS"],
			["Mr Andreas Orphanides", "Sokratous 12", "6036 Larnaka"],
		],
		[
			"the `CY-` before the postcode on inbound mail (`CY-2008 Strovolos`); this layout prints the domestic form (`6036 Larnaka`)",
		]
	),
	CZ: upuDescription(
		"cze",
		"2018-2",
		"8cb166483076b68437558b9554414903e9eeb1c7770ff1ced31387643a462307",
		[
			["Pan Martin Parma", "Hrušovská 455/10", "102 00 Praha 102", "CZECH REP."],
			["Pan Martin Parma", "Ladova 3/64", "Hrusice", "251 66 SENOHRABY", "CZECH REP."],
		],
		["the conscription number before the house number with a slash (`Hrušovská 455/10`)"]
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
			"the sub-locality above the street (`Ortsteil Neukoelln` then `Alt-Britz 73`), printed in one example; this layout prints the district below the street, where the corpus's German rows write it (`Neusser Str. 12, Nippes, 50733 Köln`)",
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
			"the building line above the street (`Edificio Lepanto`)",
		]
	),
	EE: upuDescription(
		"est",
		"2014-6",
		"afca9c47fc80f9fd1c3bd127f79987c268dfea45bb4a5336c31fd88bf8543158",
		[
			["Pr. Elina Loor", "Astri 6–1", "11212 TALLINN", "ESTONIA"],
			["Hr. Raul Tammek", "Allika talu", "Halliste alevik", "69501 VILJANDIMAA", "ESTONIA"],
		],
		[
			"the locality or the region after the postcode, never both (`11212 TALLINN`, `69501 VILJANDIMAA`); this layout prints both, as the national address register's full form does (`Pargi tn 2b, 76607 Keila linn Harju maakond`)",
			"the flat joined to the number with a dash (`Astri 6–1`)",
		]
	),
	FI: upuDescription(
		"fin",
		"2024-11",
		"2f1ce8f45d3eb4bc116d49e08458ac5c0bb30d39fda8645fe54996e4c4def754",
		[
			["Matti Manninen", "Mäkelänkatu 25 B 13", "00550 HELSINKI", "FINLAND"],
			["Myymäläpäällikkö Reijo Rekonen", "Oy Finland Camex Ltd", "PL 900", "00101 HELSINKI", "FINLAND"],
		],
		[
			"the addressee line below the organization (`Myymäläpäällikkö Reijo Rekonen` above `Oy Finland Camex Ltd`); this layout prints the organization first",
		]
	),
	FO: upuDescription(
		"fro",
		"2017-12",
		"171683b9a9331dc7c6c16132d6217daa9003ab67bf3d728e054b3e6f4224a863",
		[["P/F Postverk Føroya", "Óðinshædd 2", "FO-100 Tórshavn", "Faroe Islands"]],
		["none: the example prints a street with its number, the prefixed postcode and locality, and the country"]
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
			"line 3, the building, between the delivery point and the street (`Entrée A Bâtiment Jonquille`)",
			"the locality written on the P.O. box line (`BP 90432 MONTFERRIER SUR LEZ`)",
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
	GR: upuDescription(
		"grc",
		"2005-3",
		"6e986ab4fb6453e6c051abb467d39cc490a2dd9e40838d4a0afd44b27d71b9f4",
		[
			["Mr. George PANAGIOTOU", "1, D. GOUNARI STREET", "151 24 MAROUSI", "GREECE"],
			["Mr. George PANAGIOTOU", "P.O. BOX 999", "151 10 MAROUSI", "GREECE"],
		],
		[
			"the number before the street in both transliterated examples (`1, D. GOUNARI STREET`); this layout keeps the number after the name, as Greek writes it (`Γούναρη 1`), which the description prints no example of",
		]
	),
	GS: upuDescription(
		"sgs",
		"2005-8",
		"b301ba2e6f28548adcb193cda244c07e0003ec7be209913c9acea6a02ebcd928",
		[["Mr. I. Hunt", "King Edward Point", "SIQQ 1ZZ", "SOUTH GEORGIA ISLAND"]],
		["the example prints no locality line: `King Edward Point` is the delivery point above the postcode"]
	),
	HK: upuDescription(
		"hkg",
		"2025-4",
		"f04a58bb28a7027fde06a23a9ca8ad12d1290083fdb442e599aaadfb173cc5c7",
		[
			["Mr. CHAN Kwok-kwong", "Flat 25, 12/F", "Acacia Building", "150 Kennedy Road", "WAN CHAI", "HONGKONG"],
			["Mr. WONG Yat-ming", "P.O. Box 42345", "CAUSEWAY BAY POST OFFICE", "HONGKONG"],
		],
		[
			"the building name between the flat and the street (`Acacia Building`); this layout prints the venue above the flat",
			"the post office name below the P.O. box (`CAUSEWAY BAY POST OFFICE`)",
		]
	),
	HR: upuDescription(
		"hrv",
		"2014-5",
		"695df04065cd708e8431cdd3ee081d66f3bb37c2d9cd1b89f10ddbbe4e2ec642",
		[
			["Mr. Ivan Horvat", "Krapinska 17/I stan 4", "HR-10000 ZAGREB", "CROATIA"],
			["Mr. Josip Kralj", "Branimirova 4", "Kanfanar", "HR-52341 ŽMINJ", "CROATIA"],
		],
		["the floor joined to the number with a slash (`Krapinska 17/I stan 4`)"]
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
	IE: upuDescription(
		"irl",
		"2017-6",
		"a2f9b16409d2e9301cfcf38b82c5da872c464e09a3b87dddc3f65b7056a2ee95",
		[
			["MS M SULLIVAN", "56 BROOMFIELD", "MACROOM", "CO. CORK", "T37 F8HK", "IRELAND"],
			["Ms. M Sullivan", "21 STONEWALL DRIVE", "DUBLIN 24", "D24 TF12", "IRELAND"],
		],
		["the `CO.` before the county name (`CO. CORK`)"]
	),
	IN: upuDescription(
		"ind",
		"2013-1",
		"f8ac2ed37a59ecece8cd11e2ac5088411148b1e3d69304c118e655e275fa2a3e",
		[
			["Mr. Rajiv Rattan", "4, Amrita Shergill Road", "New Delhi", "110003", "INDIA"],
			[
				"Mr. N Gopalarathnam",
				"32/1, 2nd Main Road",
				"8th Block",
				"Jayanagar",
				"Bangalore",
				"Karnataka",
				"560082",
				"INDIA",
			],
		],
		[
			"the second sub-locality line (`8th Block` above `Jayanagar`), of which one district line is kept",
			"the rural taluk and district lines (`Pennukonda Taluk`, `Anantpur District`)",
			"the contact block's PIN on the locality line (`NEW DELHI 110001`), which no example prints",
		]
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
	...L_Z_LAYOUT_CITATIONS,
	...AC_GE_LAYOUT_CITATIONS,
}
