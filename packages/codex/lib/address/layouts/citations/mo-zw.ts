// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The citations the MO–ZW review of 2026-11-24 read, for layouts that already
 * print what the postal operator's document prints.
 *
 * `LAYOUT_CITATIONS` in `#address/layouts/citations` holds them beside the rest.
 * Each example is transcribed from the document's text, one string per printed line.
 */

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"
import { RETRIEVED_AT, upuDescription } from "#address/layouts/citations/upu-description"

/**
 * The note of a French overseas department or collectivity whose description
 * defers to France with `See France`.
 */
const SEE_FRANCE =
	"France's description (`fraEn.pdf`, 09/2011, sha256 54c80b84d6f5a7480887b8e9a1848758ddf9e91cfa899fb259e6ddea110b2ae0), which the page's `See France` names, prints the delivery-point and building lines above the street (`Chez Mireille COPEAU Apartment 2`, `Entrée A Bâtiment Jonquille`) and the P.O. box below it (`BP 40122`); this layout prints the unit after the street and the P.O. box above it"

/**
 * The note of a description that prints no street, so its street line is unconfirmed.
 */
const STREET_UNPRINTED =
	"the house number's place: no example prints a street, so the street line is libaddressinput's order, which no example confirms"

/**
 * Citations by ISO 3166-1 alpha-2.
 */
export const MO_ZW_LAYOUT_CITATIONS: Readonly<Record<string, LayoutCitation>> = {
	MO: {
		source: ConventionSource.NationalPostalAuthority,
		url: "https://www.ctt.gov.mo/MacauPost/Contents/AddressFormat.aspx?lang=zh-hant",
		documentDate: "2023-10",
		retrievedAt: RETRIEVED_AT,
		sha256: "54c807dd34b1edda45bebfb71c371d72514094448f0ceafd5a63396e2643a2de",
		examples: [
			["澳門 氹仔", "葡京街130 號", "葡京花園B3棟", "14樓 D座", "吳小麗女士"],
			["澳門", "宋玉生廣場159-207 號", "海富商業中心", "4樓A", "甲乙丙出入口有限公司"],
			["澳門 氹仔", "嘉模郵政分局", "郵政信箱 3888 號", "李康健先生"],
		],
		unexpressed: [
			"the district line the page prints first (`區域（澳門/氹仔/路環）`, `澳門 氹仔`); this layout prints no district and prints the country line last",
			"the floor and unit line between the building and the addressee (`14樓 D座`); this layout prints the unit on the street line",
			"the post office line between the district and the box (`嘉模郵政分局`)",
			"the postcode the page lists `（如適用）`, if applicable; this layout prints none",
			"the page's Portuguese and English versions (`?lang=pt-pt`, sha256 b5532e66d4a026a06b6895006ba3e8ccfc8be02f901dffa64e457b1cfa393d06; `?lang=en-us`, sha256 1f0b142ffb09be489c8366c2dee8724194e5bb43f4d474e6d3739c3858694608) print the smallest-first order (`Ms. Ng Sio Lai` first, `Taipa, Macau` last), which the Latin layout prints; a value pairing a Chinese and a Portuguese name prints in that order",
			"the page is HTML served with per-request markup (an ASP.NET view state), so its bytes and sha256 change on every retrieval; the hash is one retrieval's",
		],
	},
	MQ: upuDescription(
		"mtq",
		"2011-8",
		"83ab554aede399dcb673c67b380f353316b0db1337e02db21eb687317bc2ce3a",
		[["Monsieur Jean DURAND", "25 RUE CARNOT", "97220 LA TRINITE", "FRANCE"], ["See France."]],
		[SEE_FRANCE]
	),
	MV: upuDescription(
		"mdv",
		"2004-9",
		"f0e73d6a2bb65dc8e052be0edffa12f9d37d88d02e8bcceb2a5623641fd311bb",
		[["MALDIVES POST LIMITED", "26, BODUTHAKURUFAANU MAGU", "MALÉ 20026", "MALDIVES"]],
		[
			"the only address printed is the operator's contact block (`See contact below.`)",
			"the comma after the house number (`26, BODUTHAKURUFAANU MAGU`); this layout writes the number and the street with a space",
		]
	),
	MY: upuDescription(
		"mys",
		"2010-2",
		"aa509c40536e95395cbd4d3b52befcd5943d68e7fb7bc9736321fb5f4fbe6357",
		[
			["Mr. Anuar bin Samsudin", "66 Jalan Kenari", "Taman Kenari", "43000 KAJANG", "SELANGOR", "MALAYSIA"],
			["Ahmad Bin Ghazali", "Citybank Berhad", "Peti surat 11725", "50754 KUALA LUMPUR", "KUALA LUMPUR", "MALAYSIA"],
		],
		[
			"line 2, the house, lot, floor and building line above the street (`house no./lot no./floor and building name`); this layout prints the unit after the street",
			"the comma after the number in two examples (`1, Jalan Ikan`)",
		]
	),
	NA: upuDescription(
		"nam",
		"2018-9",
		"57f48ce828b9f7aa0bc94a7566f7967d41fdd8c51cdef424a31e9db57340666a",
		[
			["Ms. Nangula Hamutenya", "11 Mermaid Street", "Ocean View", "UIS", "13013", "NAMIBIA"],
			["Mr P Rossouw", "PO Box 999", "OKAHANDJA", "12004", "NAMIBIA"],
		],
		[
			"the rural and informal forms, which print a locality and the post office on two lines above the postcode (`ONETHINDI` then `ONDANGWA`); this layout prints one locality line",
			"the supplementary information line (`Section 13`, `off Justine Street, near New World bar`)",
		]
	),
	NF: upuDescription(
		"nfk",
		"2014-9",
		"29ec07225c7a3be588b8840882630d30af2febf4ea8963d7381d20f65e24e7cc",
		[["Postcode of NORFOLK ISLAND (NSW) is 2899."], ["See Australia."]],
		[
			"Australia's description (`ausEn.pdf`, 07/2017, sha256 f137a0d8c32114de34e3138593caecb63356e7cd0d8e372b93673c1278dd27fa), which the page's `See Australia` names, prints the locality, the state and the postcode on one line with one or, preferably, two spaces between them (`KALGOORLIE WA 6430`); this layout uses one",
			"the page prints no address, so whether a letter writes the `(NSW)` it names on the locality line is unstated",
		]
	),
	PA: upuDescription(
		"pan",
		"2015-2",
		"40b4a77e8d528b9a8cfb6531174b0a8663941e42544679d2338179966933cb3e",
		[
			[
				"LICENCIADO GREGORIO FERNANDEZ",
				"GERENTE GENERAL",
				"INFONET S.A.",
				"VIA ESPAÑA, CALLE 6ta",
				"EDIFICIO DEL PADRO No2, TERCER",
				"PISO, LOCAL No10, PARQUE LEFEVRE",
				"PARQUE LEFEVRE",
				"PROVINCIA DE PANAMÁ",
				"PANAMA (REP.)",
			],
			["INFONET S.A.", "APARTADO POSTAL 0832-02345", "PARQUE LEFEVRE", "PROVINCIA DE PANAMÁ", "PANAMA (REP.)"],
		],
		[
			"the building, floor and premises line below the street, wrapped over two lines (`EDIFICIO DEL PADRO No2, TERCER`)",
			"the premises after a comma on the street line (`VIA ESPAÑA, CALLE 6ta`); this layout writes the number after the street name with a space",
		]
	),
	PG: upuDescription(
		"png",
		"2017-9",
		"da93d2fd44cb7b048d004a7a7eedad0f438fcec45df80a3d2ef88ecf88d1db8d",
		[["Post PNG", "P.O. Box 3264", "BOROKO 111 NCD", "PAPUA NEW GUINEA"]],
		[
			"the province printed as its abbreviation (`NCD`), which the description's province list writes in full (`National Capital`)",
			STREET_UNPRINTED,
		]
	),
	PH: upuDescription(
		"phl",
		"2004-9",
		"aa871ca2b42c1b574f65ceb24aaee0f99c62817887633ea85ac34a65d00482fb",
		[
			[
				"Mr. Samuel H. Magtanggol",
				"96 Hermogenes St., Sofa Subdivision",
				"Del Pilar, San Fernando",
				"2000 PAMPANGA",
				"PHILIPPINES",
			],
			["Ms. Teresita C. Metrillo", "7117 Kundiman St., Sampaloc", "1008 MANILA", "PHILIPPINES"],
		],
		[
			"the Manila form, which prints the district on the street line after a comma (`7117 Kundiman St., Sampaloc`) and the city on the postcode line (`1008 MANILA`); this layout prints the district and the city on a line of their own and the province after the postcode",
			"the Metro Manila P.O. box form, which prints the municipality between the postcode and the region (`1135 Quezon City, METRO MANILA`)",
			"the post office after the box number (`P.O. Box 1201, Manila Central P.O.`)",
		]
	),
	PK: upuDescription(
		"pak",
		"2004-9",
		"5bf31d0e49078af8501d6a31aff52c33f01f35f78bf8278d24688b8e47c04315",
		[["Mr. Nasratullah Khan", "House No 17–B", "Street No 30", "Sector F–7/1", "ISLAMABAD–44000", "PAKISTAN"]],
		[
			"the dash between the locality and the postcode, an en dash in the example (`ISLAMABAD–44000`); this layout joins them with a hyphen",
			"the house, the street and the sector on three lines (`House No 17–B`, `Street No 30`, `Sector F–7/1`); this layout prints the number and the street on one line and the sector as the district",
		]
	),
	PM: upuDescription(
		"spm",
		"2011-8",
		"85a960f3001203fafeb2f3bba64c2b176d214d706c57fb1d1e94196973170787",
		[["Monsieur Jean DURAND", "12 AVENUE DU VENT", "97500 MIQUELON", "FRANCE"], ["See France."]],
		[SEE_FRANCE]
	),
	PN: upuDescription(
		"pcn",
		"2005-8",
		"7d0dc34e153a17f6aa08a3a5d68c4ba90620541c74456583a988715e623537e7",
		[["7 alphanumeric characters below the name of the locality, with a space"], ["PCRN 1ZZ"]],
		[
			"the description prints no address, only the single postcode and its place below the locality; the lines above the locality are libaddressinput's, which no example confirms",
		]
	),
	PY: upuDescription(
		"pry",
		"2018-9",
		"7eece40cd3dd69eb9fccf5972eff65d2c08cae54c2accda10fb345e43923431b",
		[
			[
				"Mr Juan Pérez – T 0981400525",
				"Estrella Nº 340, casi Yegros",
				"Edif. España, Bloque A,",
				"Piso 3, Depto. 10",
				"001218 ASUNCIÓN, CENTRAL",
				"PARAGUAY",
			],
			[
				"Ms Jorgelina Pérez – T 0981400525",
				"CC 15024",
				"Agencia Shopping del Sol",
				"001521 ASUNCIÓN, CENTRAL",
				"PARAGUAY",
			],
		],
		[
			"the province after the locality on the postcode line (`001218 ASUNCIÓN, CENTRAL`); this layout prints no region",
			"the building, floor and apartment lines below the street (`Edif. España, Bloque A,`, `Piso 3, Depto. 10`); this layout prints the unit on the street line",
			"`Nº` before the number and the cross street after it (`Estrella Nº 340, casi Yegros`)",
			"the addressee's phone number after the name (`– T 0981400525`)",
		]
	),
	RE: upuDescription(
		"reu",
		"2011-8",
		"d7cd8d958f27294efae10c088e3ee2479e7bf0e1a42c68924a2e2431a0ec7646",
		[["Monsieur Jean DURAND", "7 AVENUE JEAN ALBANY", "97400 ST DENIS", "FRANCE"], ["See France."]],
		[SEE_FRANCE]
	),
	SJ: upuDescription(
		"sjm",
		"2004-5",
		"88fbc1b19fdba7e5e15687c1b62ff7a47af5be2410db3aa7328934c09c17604c",
		[["See Norway"]],
		[
			"Norway's description (`norEn.pdf`, 01/2013, sha256 0473f73319a5639bb62fd54f340ec7de3c3937325aae5896ed2d0d62ca038d6f), which the page's `See Norway` names, prints the number after the street and the postcode before the locality (`Karl Johansgate 25 B`, `0025 OSLO`); this layout prints both so, and leaves out the building code number line above the street (`Bolignummer H0302`)",
		]
	),
	SN: upuDescription(
		"sen",
		"2015-2",
		"f0a0604187e954695dd2c1abfa1dcb1baca452861eedd18d6b951e16147edf6e",
		[
			["Monsieur Bouya KA", "24 AVENUE DE LA GARE", "10000 Dakar", "SENEGAL"],
			["Madame Madeleine TOUNDE", "BP 1534", "27000 Ziguinchor", "SENEGAL"],
		],
		[
			"the apartment and building lines above the street (`Appartement 12`, `Résidence Fallou`); this layout prints the unit after the street",
			"the P.O. box line below the street (`10 RUE PAUL HOLLE` then `BP 225`); this layout prints it above",
		]
	),
	SO: upuDescription(
		"som",
		"2004-9",
		"674604ab90c6f4ecdec84d1fab3639de787d14b194e7af7fa3a6453515864c1d",
		[["Hassan O. Omar", "P.O. Box 1001", "KISMAYU, JH 09010", "SOMALIA"]],
		[
			"the region code is part of the 7-character postcode (`JH 09010`), with two spaces before the digits by the header's rule and one in the example; this layout prints the region slot before the postcode slot, so a row holding the code in both prints it twice",
			STREET_UNPRINTED,
		]
	),
	SZ: upuDescription(
		"swz",
		"2018-8",
		"642489ca08cf5632541b1f1524a309f0d4ece88023b6706afe7e8dd1619baade",
		[["Ms. T.M. DLAMINI", "P.O. Box 125", "MBABANE", "H100", "ESWATINI"]],
		[STREET_UNPRINTED]
	),
	TA: upuDescription(
		"shn",
		"2005-8",
		"3e1946f849857d5f382096c6763bfeef27736b2012a48e7a5096b41a1033b4c6",
		[["Mr. D.K. Wellington", "6 High Street", "JAMESTOWN", "STHL 1ZZ", "ST. HELENA"], ["See Saint Helena."]],
		[
			"the dependencies page (`Saint Helena (dependencies) (Islands)`, 07/2003) names no island and no postcode of its own, so Saint Helena's example stands for Tristan da Cunha",
		]
	),
	TJ: upuDescription(
		"tjk",
		"2019-9",
		"80fbaacbd374fe27f91f445d784fe280035c0c98d7d8884e4c3c967452735cb7",
		[["Mr. Zourabekov Mourod", "Khoutchandi 7 street", "735450 GARM", "TAJIKISTAN"]],
		[
			"the number between the street's name and its type (`Khoutchandi 7 street`); this layout prints the number after the whole street name",
		]
	),
	TN: upuDescription(
		"tun",
		"2014-4",
		"95dca8fa95f1e2494f396fdd83bf99d12e8ab5526cb78cbf7e08bbbf1da557a7",
		[
			["MONSIEUR B. ABDELWAHEB", "15 AVENUE BOURGUIBA", "8170 BOU SALEM", "TUNISIA"],
			["Melle R. SOUAD", "BOITE PRIVEE 72", "8129 AIN DRAHAM", "TUNISIA"],
			["MONSIEUR S. ABDERAOUF", "ABIDA", "3100 KAIROUAN", "TUNISIA"],
		],
		[
			"line 3, the entrance, staircase and building line above the street; this layout prints the unit after the street",
			"the delivery sector after the locality on the postcode line (`1002 TUNIS BELVEDERE`)",
		]
	),
	UG: upuDescription(
		"uga",
		"2026-1",
		"0ba034d44c345f2e07ee4ce22a665f5f5049248b2ff771325d3087accf6d9419",
		[
			["Lawrence Muwanga", "22 Siad Barre Avenue", "10000 KAMPALA", "UGANDA"],
			[
				"James Ngogoro",
				"Public Relations Department",
				"Sapoba Bookshop Ltd",
				"53 Katwe Road",
				"12331 KAMPALA",
				"UGANDA",
			],
			["Ms Olive Takubua", "P.O. Box 21310", "10000 KAMPALA", "UGANDA"],
		],
		[
			"the rural form's sub-locality line above the postcode (`Nabbingo Village`); this layout prints no district",
			"the department line between the addressee and the organization (`Public Relations Department`)",
		]
	),
	UZ: upuDescription(
		"uzb",
		"2019-7",
		"0a38a376f135d444bb1bd70906ac7ec176d5d757ffcf6f48e40353350e801fdd",
		[
			["Azizova Maluku Tsadykovne", "ul. Murtso Ulyzbeka, d. 4, kv. 23", "140101, g. Samarkand, 1", "UZBEKISTAN"],
			[
				"Dzhurayevoy Shakhnoze Bakhtiyarovne",
				"kolkhoz Leningrad, brigada 2",
				"220605, Kashkupyrskiy rayon, p/o Khayrovan",
				"Khorezemskaya oblastʹ",
				"UZBEKISTAN",
			],
		],
		[
			"the comma after the postcode and `g.` before the town (`140101, g. Samarkand, 1`)",
			"the post office number after the locality (`100123, g. Tashkent 123`)",
			"the rural form's district between the postcode and the locality (`Kashkupyrskiy rayon`)",
			"the house and flat markers after the street (`d. 4, kv. 23`); this layout prints the number after the street with a space",
		]
	),
	VE: upuDescription(
		"ven",
		"2019-5",
		"84313bdd9cd517bbabb79eac782817f61994a7c4cc383b44c2ce20ced108de2d",
		[
			[
				"SEÑOR JOSE PEREZ",
				"AV. FUERZAS ARMADAS",
				"TORRE SAN JOSÉ, ENTRADA B",
				"PISO 5, APARTAMENTO 20",
				"PARROQUIA SAN JOSÉ",
				"CARACAS 1010, D.C.",
				"VENEZUELA",
			],
			[
				"INSTITUTO CARDIÓLOGICO DEL CENTRO",
				"APARTADO POSTAL Nº 6547",
				"PARROQUIA SAN CARLOS DE AUSTRIA",
				"BARINAS 2201, COJEDES",
				"VENEZUELA",
			],
		],
		[
			"the parish and the municipality on two sub-locality lines (`PARROQUIA PIO TAMAYO`, `MUNICIPIO ANDRÉS ELOY BLANCO`); this layout prints one district line",
			"the premises, door, floor and apartment lines below the street (`TORRE SAN JOSÉ, ENTRADA B`); this layout prints the unit on the street line",
			"the right alignment the description states for the address lines",
		]
	),
	YT: upuDescription(
		"myt",
		"2011-8",
		"0dcc5eb86da72d76049badabf8b235f79a855b8cb266eb97e0697f796736fd6b",
		[["Monsieur Jean DURAND", "5 RUE DE L OCEAN", "97600 MAMOUDZOU", "FRANCE"], ["See France."]],
		[SEE_FRANCE]
	),
	ZW: upuDescription(
		"zwe",
		"2005-3",
		"4e2d37298699205a8d70d0d0d54f038ae60387f13f3348c391de2d75aac918bf",
		[
			["Ms. Sue Susan", "34–6th Crescent", "Warren Park 1", "HARARE", "ZIMBABWE"],
			["Mr. Joe John", "P.O. Box AY 30", "Amby", "HARARE", "ZIMBABWE"],
		],
		["the house number joined to the street by an en dash (`34–6th Crescent`); this layout writes them with a space"]
	),
}
