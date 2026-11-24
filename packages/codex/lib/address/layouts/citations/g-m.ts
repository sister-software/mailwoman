// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The citations the GG–MN review of 2026-11-24 read, for layouts that already
 * print what the postal operator's document prints.
 *
 * `LAYOUT_CITATIONS` in `#address/layouts/citations` holds them beside the rest.
 * Each example is transcribed from the document's text layer, one string per printed line.
 */

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"
import { RETRIEVED_AT, upuDescription } from "#address/layouts/citations/upu-description"

/**
 * The United Kingdom description Guernsey and the Isle of Man defer to with `See United Kingdom`.
 */
const UNITED_KINGDOM_DESCRIPTION =
	"the United Kingdom description (`gbrEn.pdf`, 11/2011, sha256 fd1a751e7694578ac80e56c3c18fffc4163499694448b5891a5c47ddfa132b22), which this one defers to: its dependent thoroughfare and double dependent locality lines"

/**
 * The S42 template Korea approved in 2019-12.
 * It prints each example in Hangul and in Latin.
 */
export const KOREAN_TEMPLATE_URL = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/s42/korEn.pdf"

/**
 * The sha256 of {@linkcode KOREAN_TEMPLATE_URL} as retrieved.
 */
export const KOREAN_TEMPLATE_SHA256 = "f41a69788eb84e5442924499e3850ea046a21521990d64efaf29e99986fae977"

/**
 * Citations by ISO 3166-1 alpha-2.
 */
export const G_M_LAYOUT_CITATIONS: Readonly<Record<string, LayoutCitation>> = {
	GG: upuDescription(
		"ggy",
		"2005-3",
		"7a1843a2fe13abef9ec64955f06f85b7d79f905263fef0e3ac3d6994bcd21fc5",
		[
			["See United Kingdom of Great Britain and Northern Ireland."],
			[
				"Mr. A. de Garis",
				"Anybank",
				"Anybank House",
				"Le Pollet",
				"St Peter Port",
				"GUERNSEY",
				"GY1 1AA",
				"CHANNEL ISLANDS",
			],
		],
		[
			"the building name on its own line below the company (`Anybank House`)",
			"`CHANNEL ISLANDS`, which the description labels the county, in the country line's place",
			UNITED_KINGDOM_DESCRIPTION,
		]
	),
	GN: upuDescription(
		"gin",
		"2005-3",
		"928deacf07cede36196781989ace33e001c5d1ea53edccad84a7862a2220cbfd",
		[
			["Monsieur Aboubacar CAMARA", "001 BP 457 CONAKRY", "GUINEA"],
			["Monsieur Souleymane DIALLO", "100 BP 75 KINDIA", "GUINEA"],
		],
		[
			"no example prints a street: every address is a P.O. box, so the street line keeps the order libaddressinput's `%Z %A %C` states",
		]
	),
	GW: upuDescription(
		"gnb",
		"2005-3",
		"3dc3351fa085d5fa9c181acd2075495711c7860e69ecd3dbc46e4184a401ad73",
		[["Sra. Celina Soares das Gama", "Rua Justino Lopes 12C", "1000 BISSAU", "GUINEA-BISSAU"]],
		["none: the example prints the street with its number after the name, then the postcode and the locality"]
	),
	HT: upuDescription(
		"hti",
		"2017-9",
		"a4a406e751ed2bd169db92547c1c398b63188f2ba58849018703561c319661a6",
		[["Monsieur Roland REMY", "Rue Samba 1", "HT6120 DELMAS", "HAITI"]],
		[
			"none: the example prints the street with its number after the name, then `HT` joined to the postcode before the locality",
		]
	),
	IM: upuDescription(
		"imn",
		"2005-3",
		"a56a15442b55cf601b16dc592687ad9738a4f77a35e25cce7fe79899a992f8b2",
		[
			["See United Kingdom of Great Britain and Northern Ireland."],
			["Electricity Authority", "P.O. Box 177", "DOUGLAS", "IM99 1PS", "ISLE OF MAN"],
		],
		[UNITED_KINGDOM_DESCRIPTION]
	),
	IO: upuDescription(
		"iot",
		"2005-8",
		"4163abf78e95ae617ac48fafbfeeee5c41d5797e57b103c66691cabe6f2bb73c",
		[["7 alphanumeric characters below the name of the locality, with a space", "BBND 1ZZ"]],
		[
			"the street, district and locality lines, which the description prints no address to check: it states only the territory's single postcode and its place below the locality",
		]
	),
	IQ: upuDescription(
		"irq",
		"2005-3",
		"ca5409b9ee5d355c301f68ae89169cf9b87a1f21e2d1992e1bca39e168ba38cb",
		[
			["Mr Anmed Tarek", "10 Qahwa Share’a", "AL ASMAEE, AL BASRAH", "61002", "IRAQ"],
			["Mr Ibraheem Hussien", "P.O. box 654", "AL ASMAEE, AL BASRAH", "61102", "IRAQ"],
		],
		["the organization above the addressee, which no example prints; libaddressinput's `%O%n%N` order is kept"]
	),
	JM: upuDescription(
		"jam",
		"2021-5",
		"eb15ce550915abdad06ff50e46d6b33fa878ff169cd9de87d8f0f5b5e3fe62cf",
		[
			["Elvis Livingston", "15 Molynes Road", "Kingston 10", "JAMAICA W.I."],
			["Mr. Kevin Horst", "Lot 19 Mona Estate", "Bog Walk", "Bog Walk PO", "St. Catherine"],
			["Ms. Marie Samuels", "P.O. Box 300", "St. Ann's Bay PO", "St. Ann"],
		],
		[
			"the Kingston sector code after the town (`Kingston 10`), which has no tag of its own",
			"the post office line between the locality and the parish (`Bog Walk PO`)",
			"`JAMAICA W.I.` as the country line",
		]
	),
	JP: {
		source: ConventionSource.NationalPostalAuthority,
		url: "https://www.post.japanpost.jp/service/search/zipcode/zipmanual/p39.html",
		documentDate: "2026-1",
		retrievedAt: RETRIEVED_AT,
		sha256: "40c913e52ec160ce7bdd314df66500f2cbe04db556d038de2d8c795293777a6d",
		examples: [
			["100-0013", "東京都 千代田区", "霞ヶ関 1丁目3-2"],
			["790-0066", "愛媛県 松山市", "宮田町 8-5"],
		],
		unexpressed: [
			"the page prints no date; the document date is the server's `Last-Modified`, 2026-01-11",
			"the postcode without the `〒` mark; this layout prefixes it",
			"the space between the prefecture, the city and the town (`東京都 千代田区`, written with U+3000); this layout joins the run unseparated as the one-line form does",
			"the postcode on a line of its own above the prefecture, and the town and block on a third line; this layout prints the run and the block on one line",
			"the country, which this domestic page doesn't print; the UPU description (`jpnEn.pdf`, 06/2019, sha256 715dde888e7c08cc83c3d6f313559f5420389c7a2e6dde7e4b18a8a25d325865) writes it first in the largest-first order (`JAPAN 112–0001 TOKYO Bunkyo–Ku Hakusan 4–Chome 3–2`)",
		],
	},
	KH: upuDescription(
		"khm",
		"2018-11",
		"a669ccada40f39d913991046f117d403d89a8753f4cbbbc0c21c6616699c1e0c",
		[
			["Mr. Ken Vireak", "100E0 Street 118", "PHNOM PENH 120209", "CAMBODIA"],
			["Ms. Meas Khuntea", "Phoum Deum Svay", "PREY VENG 141006", "CAMBODIA"],
		],
		[
			"the province in the locality's place for a rural address (`PREY VENG 141006`), which a row labels as the region rather than the locality",
		]
	),
	KM: {
		source: ConventionSource.PostalStandardS42,
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/s42/comEn.pdf",
		documentDate: "2021-9",
		retrievedAt: RETRIEVED_AT,
		sha256: "c29f46f921728edf0bfd9173c13888d38658ee4ee00a4be7ea95e0e22e63a79d",
		examples: [
			["M. ABDOU MSILAMOU", "15, Rue Ahmed Djoumoi", "KM 30141 Moroni Hadoudja", "Union des Comores"],
			["MME NARDJISSE MKACHINTRU", "15, Rue Ahmed Djoumoi", "KM 10111 Mutsamudu centre", "Anjouan, Union des Comores"],
			["M. SAÏD MTSACHIWA", "BP 53", "KM 20110 Fomboni", "Mohéli, Union des Comores"],
		],
		unexpressed: [
			"the `KM ` the template prints before the postcode (`KM 30141`), which its mapping files under the postcode element; this layout prints the postcode value as a row holds it",
			"the floor and wing line above the building",
			"the 07/2002 UPU description (`comEn.pdf`, sha256 689c7a44f595e9ed0cb6ae8b133986c7f713db429d7c3c67717a3a7ebbf0e845), whose one example is a P.O. box with no postcode (`BP 350` / `MORONI`); the template Comoros approved in 2021-9 is the later document and prints a postcode and the island",
		],
	},
	KR: {
		source: ConventionSource.PostalStandardS42,
		url: KOREAN_TEMPLATE_URL,
		documentDate: "2019-12",
		retrievedAt: RETRIEVED_AT,
		sha256: KOREAN_TEMPLATE_SHA256,
		examples: [
			["서울특별시 서초구 서초대로 325", "홍길동", "06600"],
			["대구광역시 수성구 달구벌대로 2275-12", "101동 103호", "홍길동", "42000"],
			["인천광역시 동구 송림로 24", "2층", "(주)아모레퍼시픽", "홍길동", "22550"],
			["경상남도 창녕군 창녕읍 종로 6", "홍길동", "50322"],
		],
		unexpressed: [
			"the province, the city or district, the town and the road on one line with the building number (`서울특별시 서초구 서초대로 325`); this layout prints the road and number on a line below the administrative run, which `LINE_JOINS.KR` joins with a space",
			"the space between the district and the town (`창녕군 창녕읍`); this layout joins `%C%D` unseparated as libaddressinput's `fmt` does",
			"the building wing, floor and door on their own line below the road (`101동 103호`, `2층`); this layout prints the unit after the building number",
			"the country, which the template's Hangul lines leave out for domestic mail; this layout prints it first",
		],
	},
	KY: upuDescription(
		"cym",
		"2019-2",
		"45a913295786802a5087664b2405d8b4a6ee4f15f5d7f4288722817ac6bbb9f8",
		[
			["Mr. John James", "Acme Engineering", "P.O. Box 802", "Grand Cayman KY1-1103", "CAYMAN ISLANDS"],
			["Ms. Susan James", "General Delivery", "Bodden Town Post Office", "Grand Cayman KY1-1600", "CAYMAN ISLANDS"],
		],
		[
			"the two spaces between the island and the postcode the description requires",
			"the post office line above the island for general delivery (`Bodden Town Post Office`)",
		]
	),
	LA: upuDescription(
		"lao",
		"2025-11",
		"e9d3c3346e8db94d717ef8b4882dd64d5cfe60b11553584c9b5d86db6ad25224",
		[
			["Mr Khamsing Sengdeth", "14, rue That Louang", "01160 XAYSETHA", "LAO PEOPLE'S DEM. REP."],
			["Mr Khamsing Sengdeth", "P.O. Box", "01160 XAYSETHA", "LAO PEOPLE'S DEM. REP."],
		],
		[
			"the district name after the village on the postcode line (`Line 3: postcode, village name and district name`), which no example prints",
			"the telephone number the description recommends adding",
		]
	),
	LK: upuDescription(
		"lka",
		"2002-7",
		"e9e2453a08348560dc3eb9dc0abd968a0902eac81d38258669db3029a3b7a7aa",
		[["Mr. A. L. Perera", "201 Shanti Villa", "Silkhouse Street", "KANDY", "20000", "SRI LANKA"]],
		[
			"the house number and house name on their own line above the street (`201 Shanti Villa` then `Silkhouse Street`); this layout prints the number on the street line",
		]
	),
	LR: upuDescription(
		"lbr",
		"2017-8",
		"27b6b1b576ce5291cf44cc8a2ae150dfe32660e6a84813f5bbcb1d88440f358f",
		[
			["Mr. Peter Paul", "Water Street", "4000 Buchanan", "LIBERIA", "Telephone 0770554538"],
			["John P. Banks", "P O Box 30", "1000 Monrovia 40", "LIBERIA", "Telephone no: 0886532486"],
		],
		[
			"the telephone line below the country",
			"the house number, which no example prints; the street line keeps the order the generator's street table states",
			"the delivery zone after the locality (`1000 Monrovia 40`)",
		]
	),
	LS: upuDescription(
		"lso",
		"2004-9",
		"bde45682d91e3e128877339b3025ce043e14c94b5c8a845593a9332642f35d80",
		[["Mr. Peter Makara", "P.O. Box 500", "MASERU 100", "LESOTHO"]],
		["the centered alignment of the address lines"]
	),
	MA: upuDescription(
		"mar",
		"2014-9",
		"a1c87322771c45fb9af4679665c50f6a4374f203eb6a21cc2be71d97590bd226",
		[
			[
				"MR SAMIR ALLOUANI",
				"APARTMENT N° 13",
				"ENTRANCE C IMMEUBLE ANNADA",
				"23 BOULEVARD TAROUDANT",
				"52000 ERRACHIDIA",
				"MOROCCO",
			],
			[
				"MR. YOUSSEF SEMLALI",
				"APARTMENT NO 409",
				"RESIDENCE ANNAKHIL",
				"35 BOULEVARD ABDELKRIM KHATTABI",
				"QUARTIER ANFA",
				"20370 CASABLANCA",
				"MOROCCO",
			],
			["MR MOHAMMED IBRAHIM", "P.O 1737", "KHOURIBGA PRINCIPALE", "25005 KHOURIBGA", "MOROCCO"],
		],
		[
			"the apartment and the entrance or building on their own lines above the street; this layout prints the unit after the street",
			"the Poste Maroc agency line below the P.O. box (`KHOURIBGA PRINCIPALE`)",
		]
	),
	MD: upuDescription(
		"mda",
		"2019-4",
		"48420c0a8ec3d20c4ebba4e7b2b133a2d28f834961448be94dae951ffcea058f",
		[
			["Cucu Vasile", "Str. Eminescu, nr. 25/1, ap. 14", "MD-2012, CHISINAU", "MOLDOVA"],
			[
				"Ministerul Comunicatiilor si Informaticii",
				"Directia Principala Dezvoltare Posta",
				"Bd. Ștefan cel Mare și Sfînt, nr. 134",
				"MD-2012, CHISINAU",
				"MOLDOVA",
			],
		],
		[
			"the comma between the postcode and the locality (`MD-2012, CHISINAU`); this layout writes a space",
			"`nr.` before the house number and `ap.` before the flat (`nr. 25/1, ap. 14`)",
		]
	),
	MG: upuDescription(
		"mdg",
		"2011-8",
		"0f1c5bf057baaf89d7b879c029c81dcf346334f52d681e0d649c0cc6709bc4f0",
		[
			["Mr. Ramisera Colomb", "Lot 67 Parcelle 1139", "Ankirihiry North", "501 TOAMASINA", "MADAGASCAR"],
			["Ms. Antsoindava Aimée", "Lot 386 Cité Ambohimpo", "B.P. 536", "101 ANTANANARIVO", "MADAGASCAR"],
		],
		[
			"the P.O. box below the lot (`Lot 386 Cité Ambohimpo` then `B.P. 536`); this layout prints the box above the street",
		]
	),
	MH: upuDescription(
		"mhl",
		"2005-3",
		"c28fa3fc3ffc1526b01e0e7600fdb1e4c56fb0abc8bb1b93eeb640d4b11e50a8",
		[["Marshall Islands follow the United States of America postal system. Its state code is"]],
		[
			"the United States description's two spaces between the state and the ZIP Code (`usaEn.pdf`, 06/2010, sha256 6aaf7be56335d60b31c8fd5f88b543f6a42d4f04c0ff24b72d43a49663e0b1e1)",
		]
	),
	MK: upuDescription(
		"mkd",
		"2019-7",
		"82bbfae55ceb4d03dd1e75b1ed4fdb9ee61313db4c52b65cd9c047841f7158a6",
		[
			["Petar Petrovski", "“Ilindenska” 2/1-8", "1020 SKOPJE", "NORTH MACEDONIA"],
			["Epena Taseaska", "yl. 30 Juli 4", "Pero Čičo", "1310 Kumanovo", "NORTH MACEDONIA"],
			["AD Alkaloid", "P. fah 115", "1001 Skopje", "NORTH MACEDONIA"],
		],
		["the entrance and flat joined to the house number (`2/1-8`)"]
	),
	MN: upuDescription(
		"mng",
		"2019-1",
		"9749e7e064f29f7d508d733cdf2c92340c4496e244e4d31d4c7fb56ff681e2a8",
		[
			[
				"Baldangiin Dolgor",
				"Jigjidjav street 9-11 toot",
				"15th khoroo, Bayanzurkh Duureg",
				"ULAANBAATAR 14560",
				"MONGOLIA",
			],
			["Dorj Bat", "Sunmber Bagh, Khalkh gol sum", "DORNOD AIMAG 21011", "MONGOLIA"],
		],
		[
			"the sub-district and district on one line with a comma (`15th khoroo, Bayanzurkh Duureg`); this layout prints the district and the locality on lines of their own",
			"the capital in the province's place on the postcode line (`ULAANBAATAR 14560`): a row that labels Ulaanbaatar as the locality prints its postcode on the line below",
			"the flat after the house number (`9-11 toot`)",
		]
	),
}
