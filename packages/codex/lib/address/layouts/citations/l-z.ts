// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The citations the L–Z review of 2026-11-24 read, for layouts that already print
 * what the postal operator's document prints.
 *
 * `LAYOUT_CITATIONS` in `#address/layouts/citations` holds them beside the rest.
 * Each example is transcribed from the description's PDF text layer, one string per printed line.
 */

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"
import { RETRIEVED_AT, upuDescription } from "#address/layouts/citations/upu-description"

/**
 * Citations by ISO 3166-1 alpha-2.
 */
export const L_Z_LAYOUT_CITATIONS: Readonly<Record<string, LayoutCitation>> = {
	LB: upuDescription(
		"lbn",
		"2018-8",
		"cad3ca0b367c5b8287e87c79698337f507e301db0b92898450ef85094c08fca4",
		[
			[
				"Mr Ziad Hallab",
				"Haffar Bldg, 4th floor",
				"Near Istiklal School",
				"Rachid Karame Street",
				"TRIPOLI",
				"LEBANON",
			],
			["Mr John Smith", "Sbeity Building, Block C, 7th floor", "Jal Edde Street", "HARET HREIK BAABDA", "LEBANON"],
		],
		[
			"the district (kaza) after the locality on its line (`HARET HREIK BAABDA`, `Locality + district`); this layout prints no subregion",
			"the building, its number and the floor on their own line above the street (`Building 235, 1st floor`); this layout prints the house number before the street",
			"the postcode, which no example prints; this layout keeps libaddressinput's `%C %Z`",
		]
	),
	LC: upuDescription(
		"lca",
		"2019-7",
		"856ad28ef6bdb4f5596912ee5f10812a06a75d1f509467dd7a06889cf8abc8f0",
		[
			["Mr. A. Johnny", "Block A, Apt 146", "High Street", "CASTRIES, LC04  101", "SAINT LUCIA"],
			["Jane Doe", "Myers Bridge", "Choiseul Post Office", "CHOISEUL, LC10  101", "SAINT LUCIA"],
		],
		[
			"the premises and door on their own line above the street (`Block A, Apt 146`); this layout prints the unit after the street",
			"the post office line above the district and postcode (`Choiseul Post Office`)",
			"the double space inside the postcode (`LC04  101`), which belongs to the postcode's value",
		]
	),
	LI: upuDescription(
		"lie",
		"2002-7",
		"5384521a986e76e6e68532f4fddadcc7fe91bb96a0879a0c1d2c27e462426138",
		[["All the information provided for Switzerland therefore applies to"]],
		[
			"Switzerland's description (`cheEn.pdf`, 06/2024, sha256 530a9a37c2b0e953bf2c78e9d61d1d632438b0bbd69d71596b7ae7ffb1ddf7e6) prints the P.O. box below the street (`Rue de Bourgogne 5` then `Case postale 12`); this layout prints it above the street",
		]
	),
	LU: upuDescription(
		"lux",
		"2013-6",
		"294c81d3309097243d7312a7b02958fe0f235f264ce7ccec282ccb71710f105d",
		[
			["Mr. Jacques Muller", "71, route de Berlin", "L-1234 DUDELANGE", "LUXEMBOURG"],
			["Mr Jean Dupond", "5001234", "4 rue des Prés", "L-0111 Remich", "LUXEMBOURG"],
		],
		[
			"the comma after the house number in the first example (`71, route de Berlin`); the pack-up example and the national address register write none (`4 rue des Prés`)",
		]
	),
	MC: upuDescription(
		"mco",
		"2004-5",
		"c7843837a62d54c23d3bdd4946507868a43aa8c6d55c8e1442da4a060955996f",
		[["M. René Martin", "1 AVENUE DE L HERMITAGE", "98000 MONACO", "MONACO"]],
		["none: the example prints the number and street, then the bare postcode and the locality"]
	),
	MP: upuDescription(
		"mnp",
		"2005-3",
		"cb7269ae392424829693686e028d5b90275ae3fe4987ac10911b8786e423b180",
		[["Mariana Islands follow the United States of America postal system. Its state code is MP"]],
		[
			"the United States description's details this layout prints differently: no comma after the locality, and two spaces before the ZIP Code",
		]
	),
	MX: upuDescription(
		"mex",
		"2017-3",
		"66200798e706f8d186fa6fb92820e751d0258da2ee0ab78eb7c76418b13e8699",
		[
			["Sra Otilia Ramos Perez", "Urión 30", "Col. Tlatilco", "02860 MEXICO, CDMX", "MEXICO"],
			["Alonso Reyes Diáz", "Super Manzana 3 – 403", "Puerto Juarez", "77520 CANCUN, Q. ROO", "MEXICO"],
		],
		[
			"the state as its abbreviation (`CDMX`, `Q. ROO`)",
			"the apartment after the number with a dash (`Super Manzana 3 – 403`)",
		]
	),
	NE: upuDescription(
		"ner",
		"2005-3",
		"2cc297c4af6fa0c315fa01b6a179378e1a7d4d498051570a108272e5c103ea34",
		[["MONSIEUR ABDOU SOUMANA", "BP 502", "8001 NIAMEY", "NIGER"]],
		[
			"delivery to P.O. Boxes only, which the description states for every address; the layout prints the box above the street line, so a box-only row prints as the example does",
		]
	),
	NG: upuDescription(
		"nga",
		"2022-10",
		"dea227fde6f02167681caf1c8d4298ea9a50d0b7604a8adafe8b2a4a19b29ea0",
		[
			["Mr Chief Rufus", "A/33 Afin Street Adewole", "Aisegba Ekiti 370104", "EKITI STATE", "NIGERIA"],
			["Mr. Bukwa Okoro", "Okukwo Nigeria Ltd", "34 Alayande Cl", "Mokola 200212", "Ibadan", "OYO STATE", "NIGERIA"],
		],
		[
			"the postcode attached to the smallest place when a sub-province follows (`Mokola 200212` then `Ibadan`); this layout attaches it to the locality and prints the district line above",
		]
	),
	NL: upuDescription(
		"nld",
		"2016-5",
		"11b9c8174af957c1c30023e90c75ba0e5a3f0ea1e919fdb6941959348ad57b1e",
		[
			["Dr. Anna de Groot", "Drieslag 5-1", "6832 AM ARNHEM", "NETHERLANDS"],
			["Mr. Jan Jansen", "Postbus 278", "6880 AC OOSTERBEEK", "NETHERLANDS"],
		],
		[
			"the two spaces the description asks for between the postcode and the locality",
			"the building and organization-unit lines above the street (`Gebouw Westpoint Kamer 8 II`)",
		]
	),
	NO: upuDescription(
		"nor",
		"2013-1",
		"0473f73319a5639bb62fd54f340ec7de3c3937325aae5896ed2d0d62ca038d6f",
		[
			["Peder Larsen", "Karl Johansgate 25 B", "0025 OSLO", "NORWAY"],
			["Posten Norge BA", "Postboks 1181 Sentrum", "0107 OSLO", "NORWAY"],
		],
		["the building code number line above the street (`Bolignummer H0302`)"]
	),
	NP: upuDescription(
		"npl",
		"2012-6",
		"3ce369e82ba4c9f0c09e68a7a191e3ae1b8d355d62dbe4a3a2ebefda12faa872",
		[["Mr. Hari Prasad Shrestha", "102, Mitery Marg", "Baneshwore", "KATHMANDU 44601", "NEPAL"]],
		["none: the example prints the number, a comma and the street, the district, then the locality and postcode"]
	),
	OM: upuDescription(
		"omn",
		"2026-1",
		"02bc084c8650757ed9d38c1cadc588c33545119de55b7a5cb9fddc72b7e47cdf",
		[["Mr Ahmed Al-Ballushi", "P.O. Box 15", "133", "AL-KHOER", "OMAN"]],
		[
			"the district line, which this layout prints between the postcode and the locality; the examples print the postcode directly above the place they label `district`",
			"the telephone number printed below the country",
		]
	),
	PF: upuDescription(
		"pyf",
		"2011-8",
		"bd4e21097c9970c7c5781974477da97dd16f880fa5d437f77fe032f2a79b4152",
		[
			[
				"Monsieur Jean DELHOURME",
				"Chez Mireille COPEAU Appartment. 2",
				"Entrée A Bâtiment Jonquille",
				"25 RUE DE L EGLISE",
				"OROFARA",
				"98709 MAHINA TAHITI",
				"FRENCH POLYNESIA",
			],
		],
		[
			"the delivery-point and building lines above the street; this layout prints the unit after the street",
			"the island after the municipality (`98709 MAHINA TAHITI`), which this layout prints from the region slot",
		]
	),
	PL: upuDescription(
		"pol",
		"2018-8",
		"e8da0d8519a0b316a00e3507ac09f5f751e56bbaa9fe291d6abf23f487dd10e6",
		[
			["Sz. Pan", "Czesław Gżegżółka", "Ul. Kręta 15m 10", "00-950 WARSZAWA", "POLSKA / POLAND"],
			["Jadwiga Czajka", "Ul. Asfaltowa 2", "05–470 Rudzienko", "POLSKA / POLAND"],
		],
		["the apartment joined to the house number with `m` (`15m 10`)"]
	),
	PT: upuDescription(
		"prt",
		"2024-10",
		"f747ee196b78e9dcf3cce0ccfccf5dc2c60e20afc58f71f83545bb517eacd67b",
		[
			["NUNO FIGUEIREDO", "R. LEAL DA CÂMARA 31 RC ESQ", "ALGUEIRÃO", "2725–079 MEM MARTINS", "PORTUGAL"],
			["PATRICIA MARTINS", "APARTADO 42024", "LOJA CTT TELHEIRAS", "1601–801 LISBOA", "PORTUGAL"],
		],
		[
			"a second sub-locality line above the first (`BAIRRO DA PEDRA` then `MATO CHEIRINHOS`)",
			"the post office line below a P.O. box (`LOJA CTT TELHEIRAS`)",
		]
	),
	PW: upuDescription(
		"plw",
		"2014-9",
		"be9afef06aaeaac34a4bece5d6e86e82c2d7e96a1d62962ad930b08e408444b3",
		[["Palau follows the United States of America postal system. Its state code is PW and"]],
		["the island name, which the description says may be included and states no position for"]
	),
	QA: upuDescription(
		"qat",
		"2024-8",
		"cb434e07a17f0bbd2e82696c1cd04ec56fc54ec82560d55aec2cbd9e5638e950",
		[
			["Mr. Abdullah Al Muraikhi", "P.O. Box 3263", "DOHA", "QATAR"],
			["Ms. Mariam Mohamed Alhassan", "Zone 38, Street 904", "Phone: 33312826", "DOHA", "QATAR"],
		],
		[
			"the zone before the street on one line (`Zone 38, Street 904`); this layout keeps the SAFD's order, which prints the district on its own line below the street",
			"the telephone number printed as an address line",
		]
	),
	RS: upuDescription(
		"srb",
		"2025-1",
		"26f83804fbfda362dd4f36b759bea800a7853ee02e9512d2e001d92e23650a0e",
		[
			["Mr. Petar Petrovic", "Beogradska 3", "BAJMOK", "24210 BAJMOK", "PAK 456769", "SERBIA"],
			["Alfa beta d.o.o", "PP 18", "ZEMUN", "11080 BEOGRAD", "SERBIA"],
		],
		[
			"the six-digit postal address code on its own line below the post office (`PAK 456769`), which has no tag of its own; the five-digit post office number is the postcode here",
			"the flat after `stan` or `/` (`Ilije Guteše 6 stan 2`, `Avalska 37/6`)",
		]
	),
	RU: upuDescription(
		"rus",
		"2013-1",
		"adc51a438dae12a9460bdbaead50203770953e1129b077fc28eac265f9b7aa8f",
		[
			[
				"Petrov Ivan Sergeevich",
				"ul. Orehovaya, d. 25",
				"pos. Lesnoe",
				"ALEKSCEVSKIY r-n",
				"VORONEJSKAYA obl",
				"RUSSIAN FEDERATION",
				"247112",
			],
		],
		[
			"the postcode below the country line; this layout prints it above the country, as the description's UPU note recommends",
			"the sub-province line between the locality and the province (`ALEKSCEVSKIY r-n`)",
			"`d.` before the house number and `kv.` before the apartment",
		]
	),
	SC: upuDescription(
		"syc",
		"2023-7",
		"0d34f8182cfb1b659c3b8a13ef0dd23ccb9219e09b3d98a39b4b9f0d829de422",
		[
			["Assary Joshua Adam", "House N°: 207", "Lari Vavang", "Roche Caiman", "MAHE", "SEYCHELLES"],
			["Benjamin Choppy", "P.O.Box 1538", "Parcel H8102", "Sorento", "Glacis", "MAHE", "SEYCHELLES"],
		],
		[
			"the district as the locality and the island as the region (`Roche Caiman` then `MAHE`); the corpus's administrative rows label the district `region`, which this layout prints below the locality",
			"the premise on its own line above the street (`House N°: 207`)",
		]
	),
	SE: upuDescription(
		"swe",
		"2024-11",
		"f91a01689813522df9e00caadda573abdff6d1d9082d1941b90eec93f3bf822b",
		[
			["SVEN NILSSON", "NYBY 10", "123 45 LILLBYN", "SWEDEN"],
			["POSTBOLAGEN AB", "BOX 1121", "111 81 STOCKHOLM", "SWEDEN"],
		],
		["none: each example prints the street with its number, then the bare postcode and the locality"]
	),
	SG: upuDescription(
		"sgp",
		"2009-7",
		"f047111491d4b5c607baa84d0c17a6a9051eaa7153ba90ed65dbc276c8746b30",
		[
			["Ms. Tan Bee Soo", "16 Sandilands Road", "SINGAPORE 546080", "REP. OF SINGAPORE"],
			["Mr. M. Rajendran", "Blk 35 Mandalay Road", "# 13–37 Mandalay Towers", "SINGAPORE 308215", "REP. OF SINGAPORE"],
		],
		[
			"the floor and apartment with the building name on their own line below the street (`# 13–37 Mandalay Towers`); this layout prints the unit after the street",
		]
	),
	SI: upuDescription(
		"svn",
		"2016-5",
		"9758df597eb7749fe22b8fb7d65ae11aecb695694b19235758eaa218ecc2e9c9",
		[
			["Gospa", "Nada Meden", "Prešemova ul. 16", "4000 KRANJ", "SLOVENIA"],
			["Prodajalna AVTO-HIT", "p.p. 1635", "1001 LJUBLJANA", "SLOVENIA"],
		],
		["the salutation on its own line above the name (`Gospa`)"]
	),
	SK: upuDescription(
		"svk",
		"2013-1",
		"0bc13d5c066dfc4d7b0d051f80a9b607efac036bd141fa65af47943aeb1e32bd",
		[
			["Pani", "Eva Rudná", "Podtatranská 143", "058 06 POPRAD", "SLOVAKIA"],
			["Pavol Šramko", "Malinovského 4", "Vígľaš", "962 12 DETVA–SÍDLISKO", "SLOVAKIA"],
		],
		[
			"the two-character space between the postcode and the delivery office",
			"the served locality on its own line above the delivery office (`Vígľaš`), which this layout prints as the district line",
		]
	),
	SM: upuDescription(
		"smr",
		"2010-10",
		"23496230b97516c290dbb396c9644ab8f01dd1fe0b8f59606a0d4007811e29ab",
		[["Postes et Télécommunications", "Contrada Omerelli 17", "47890 SAN MARINO", "San Marino", "REP. OF SAN MARINO"]],
		[
			"the comma between the street and the number, which this layout writes (`Contrada Omerelli, 20`) from the state's own institutions' addresses and the description's coding example doesn't",
			"the castello line below the postcode and locality (`San Marino`)",
		]
	),
	TT: upuDescription(
		"tto",
		"2014-5",
		"f6a57ec8b37b7e0c6518091c2ee6d13b83b88575f9ad9330e0952a37ca18acdb",
		[
			["Mr. Siewdass", "13 Dam Road", "Longdenville", "CHAGUANAS 500234", "TRINIDAD AND TOBAGO"],
			["Lisa - Ann Joseph", "PO Box 1872", "PORT-OF-SPAIN 150123", "TRINIDAD AND TOBAGO"],
		],
		["the centered alignment of the address lines"]
	),
	TW: {
		source: ConventionSource.NationalPostalAuthority,
		url: "https://www.post.gov.tw/post/internet/Postal/index.jsp?ID=21002",
		documentDate: "2025-6",
		retrievedAt: RETRIEVED_AT,
		sha256: "06a75f3945fb04cc5d660a0e89c5830183bd57e9b334681759613baefef2cf90",
		examples: [["第1行：郵遞區號", "第2行：地址", "第3行：姓名或商號名稱"]],
		unexpressed: [
			"the country line this layout prints first, which the domestic rule leaves out",
			"the page is HTML served with per-request markup, so its bytes and sha256 change on every retrieval; the hash is one retrieval's",
		],
	},
	UA: upuDescription(
		"ukr",
		"2023-7",
		"c55c19fa409cd643dcbb68191cd8f3e4353dfcdec81f4538d36ccf3b20560cec",
		[
			["NPF Integbef", "Vul. Vatutina, 4", "KYIV", "01055", "UKRAINE"],
			[
				"Melnik Ivan Petrovitch",
				"Vul. Lisova, 2, kv.3",
				"s. Ivanovka, Semenivsky r-n,",
				"TCHERNIGIVSKA OBL.",
				"15432",
				"UKRAINE",
			],
		],
		[
			"the raion after the locality on its line (`s. Ivanovka, Semenivsky r-n,`); this layout prints no subregion",
			"the apartment after the number and a comma (`2, kv.3`)",
		]
	),
	VI: upuDescription(
		"vir",
		"2005-3",
		"e836b01e2cb43ce1e7ef9ce37b0e4027c39d8f4dabfb3c9ba06fa6ebd1bc60c4",
		[
			["Mr. John Steward", "123 Main St.", "ST THOMAS VI 00802-1222", "UNITED STATES OF AMERICA"],
			["Mr. Otis Streling", "RR 1 BOX 6601", "KINGSHILL VI 00850-9802", "UNITED STATES OF AMERICA"],
		],
		["no comma after the locality (`ST THOMAS VI`); this layout writes `St Thomas, VI`"]
	),
	VN: upuDescription(
		"vnm",
		"2021-5",
		"225e4b82535571cf33cb9ba5bc3b34ce6eb817063c349a06c9749a7a63823615",
		[
			["Ms Le Thi Binh", "No 54, Thai Thinh Street", "Nga Tu So Ward, Dong Da Dist.", "HANOI 11517", "VIET NAM"],
			["Mr Duong Vung", "Mai Ha village", "Xuan Thuy Ward, Le Thuy Dist.", "QUAN BINH PROVINCE 47816", "VIET NAM"],
		],
		[
			"the sub-district and district on one line with a comma (`Nga Tu So Ward, Dong Da Dist.`); this layout prints them on two lines",
			"`No` and a comma around the house number (`No 54, Thai Thinh Street`)",
			"the floor and building line above the street (`Room 403, B2 Block`)",
		]
	),
	ZA: upuDescription(
		"zaf",
		"2010-2",
		"f0d05962fe6c1dafe3fa2f2a6a545e320c84e10fd6670cdff33913aba362cdaa",
		[
			["Mr P. Rossouw", "442 Thirteenth Avenue", "FISH HOEK", "7975", "SOUTH AFRICA"],
			["Accounts", "Development Bank of SA Limited", "PO Box 92214", "PROTEA PARK", "0305", "SOUTH AFRICA"],
		],
		[
			"the complex line above the street (`1023 Collet Heights` then `449 Collet Drive`); this layout prints the unit after the street",
			"the suburb, which the description prints as the locality line above the postcode (`FISH HOEK`); this layout prints a district line above the locality for a row that names both",
		]
	),
}
