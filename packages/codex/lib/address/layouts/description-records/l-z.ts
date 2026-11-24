// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The description records the L–Z review of 2026-11-24 added, one per layout
 * it wrote into `UPU_PAS_ADDRESS_LAYOUTS`.
 *
 * `UPU_PAS_LAYOUT_RECORDS` in `#address/layouts/description-records` holds them beside the rest.
 */

import { upuDescription } from "#address/layouts/citations/upu-description"
import { described, UPUAdmission, type UPUPostalAddressingRecord } from "#address/layouts/upu-pas"

const { FormatContradictsOrder, FormatOmitsLocality, NoFormat } = UPUAdmission

/**
 * The note of a description whose examples print no street, so the street line
 * keeps the order the generator's street table states.
 */
const NO_STREET_EXAMPLE =
	"no example prints a street, so the street line keeps the order the generator's street table states"

/**
 * Records by ISO 3166-1 alpha-2.
 */
export const L_Z_DESCRIPTION_RECORDS: Readonly<Record<string, UPUPostalAddressingRecord>> = {
	LT: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"ltu",
			"2018-6",
			"88d892eefe71232dbc5ddf4a6750d2ed5f675300f6786c0167ad77844b1d70d2",
			[
				["Gerb p. Jonui Jonaičiui", "Laisvės pr. 40-12", "LT–04340 Vilnius", "LITHUANIA"],
				["Gerb p. Jonui Jonaičiui", "Plento g. 17-66", "Ariogala", "LT–60249 RASEINIU R. SAV.", "LITHUANIA"],
			],
			[
				"the form for a locality that isn't its municipality's seat, which prints the locality on its own line and the municipality after the postcode (`Ariogala` then `LT–60249 RASEINIU R. SAV.`); libaddressinput's `%Z %C %S` printed the region after the locality on one line, which no example does",
				"the apartment joined to the house number by a hyphen (`40-12`)",
				"the en dash in `LT–04340`; the postcode's `LT-` keeps the hyphen the prefix table states",
			]
		)
	),
	LY: described(
		NoFormat,
		"absent",
		upuDescription(
			"lby",
			"2012-2",
			"25b705a8e94089fa723365d6ff2a52f337ae815cd8d7b2a5af9232aff266e65b",
			[["Mr. Mohamed Ali Khalifa", "Av. Al Ghazaly 12", "TRIPOLI", "LIBYA"]],
			["none: the example prints the street with its number after the name, then the locality"]
		)
	),
	ML: described(
		NoFormat,
		"absent",
		upuDescription(
			"mli",
			"2002-7",
			"a63b5dfa07c5a61714dadf40d437b599966aa8e44fd0c88b54a72716cd42445f",
			[
				["M. Kalilou Sissoko", "Rue 406 – porte 39", "Magnabougou", "BAMAKO", "MALI"],
				["M. Seydou Diarra", "quartier no 1", "N'GOUMA", "MALI"],
			],
			["the door number written after the street with a dash (`Rue 406 – porte 39`)"]
		)
	),
	MM: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"mmr",
			"2022-11",
			"06eef48608a1419be8cdb2bc18a9e71dca25b22a8ac670b4a36172940c3d40b2",
			[
				[
					"Mr Tun Tun",
					"No. 5/60, Aye Myittar street,",
					"Sa Quarter,",
					"Pyigyitagon Township, 0505001",
					"Mandalay",
					"MYANMAR",
				],
				["Ms Ko Ko", "Sataw Village", "Banmauk", "Sagaing, 0213202", "Southern Shan State", "MYANMAR"],
			],
			["the trailing commas the examples print at the end of the street and quarter lines"]
		)
	),
	MR: described(
		NoFormat,
		"absent",
		upuDescription(
			"mrt",
			"2005-3",
			"6fc7fb104d02be2406722e1e4d429aaaaa1c23034cce30f777e86c7bc37d0c62",
			[["B.P. 35", "NOUAKCHOTT", "MAURITANIA"]],
			[`the one example is a P.O. Box; ${NO_STREET_EXAMPLE}`]
		)
	),
	MT: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"mlt",
			"2013-1",
			"04870897f406e56b67f6ccbc9de8993c6bcf73ca7f7cf828d63d57186e1e5afe",
			[
				["Mr Gorg Mallia", "38 Triq it-Tempji Neolitici", "IL-HAMRUN", "HMR 1428", "MALTA"],
				["Ms Samara Debono", "Kaxxa Postali 85", "TAS-SLIEMA", "SLM 1000", "MALTA"],
			],
			[
				"the house name on its own line above the street (`27 Andilina` then `Triq San Guzepp`)",
				"the postcode's own line is a soft break, so one line writes `IL-HAMRUN HMR 1428` as GB writes its postcode",
			]
		)
	),
	MU: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"mus",
			"2026-1",
			"040bf5ce822b39d9572ec05ec0aa1eecfbc9084bad8edaf1a05963585a0ea387",
			[
				["Mr Jean Sagittaire", "10, rue Claude Delaître", "Les Guibies", "PORT LOUIS 11213", "MAURITIUS"],
				["Port Mathurin Pharmacie", "Johnston Street", "RODRIGUEZ R0000", "MAURITIUS"],
			],
			["the island name in the locality's place for Rodrigues (`RODRIGUEZ R0000`)"]
		)
	),
	MW: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"mwi",
			"2021-1",
			"b40040654fec56d93064c24ca00e6434030b20174c86b69e4dcbad08bf0a4053",
			[
				["Mr Burnet Namacha", "21 Dunduzu Avenue", "102010 KASUNGU", "MALAWI"],
				["Mr Pastor Bennie Saka", "Unit A Comesa House", "12 Kamuzu Highway", "Chichiri", "309070 BLANTYRE", "MALAWI"],
			],
			[
				"the rural form, which prints the Traditional Authority as the locality and the district after the postcode (`T/A Chakhaza` then `204101 DOWA`)",
				"the unit and building line above the street (`Unit A Comesa House`)",
			]
		)
	),
	MZ: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"moz",
			"2005-3",
			"3a556d1f8b38af7d35369be4d8cdc28c40892b1ba00e0149f99e0b7e5f9a61d5",
			[
				["José Matola", "Av. Mártires da Machava", "252, 5o andar, flat 3", "1100 MAPUTO", "MAPUTO", "MOZAMBIQUE"],
				["A. Ade Simo", "P.O Box 20", "3314 MECULA", "NIASSA", "MOZAMBIQUE"],
			],
			["the house number, floor and flat on their own line below the street (`252, 5o andar, flat 3`)"]
		)
	),
	NI: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"nic",
			"2014-5",
			"9a714a3219f8b2dc01f62e66ed90f3eb6745d11a63d1e5d1806626ff84ef5013",
			[["Sr. Marvin Ramírez", "Residencial Bello Horizonte C-IV-45", "11147", "Managua, Managua", "NICARAGUA"]],
			[
				"the traditional landmark address, which writes directions from a landmark in place of a street and number (`Portón Cementerio General 1c Este, 1/2c Norte.`)",
			]
		)
	),
	NR: described(
		FormatOmitsLocality,
		"after-locality",
		upuDescription(
			"nru",
			"2026-8",
			"10fd36826eb4b09c907c83f61681bc192bb252cf3c2cf0697c2462396497009d",
			[["Mr John James", "BOE DISTRICT", "NRU68", "NAOERO"]],
			[
				"the village, which the description says addresses leave out; the locality line renders only for a row that names one",
			]
		)
	),
	NU: described(
		NoFormat,
		"after-locality",
		upuDescription(
			"niu",
			"2017-9",
			"445045a64ab96d82ed0a3990ac78261b051f6c1154e9076025878fe60df36c0c",
			[
				["Ms Dehlia Houdson", "Tapeu-Porritt Rd", "Alofi", "9974", "NIUE"],
				["Mr. Ken McCleskey", "Fualahi", "Fonuakula", "9974", "NIUE"],
			],
			["none: each example prints the street or sub-locality, the locality, then the single postcode on its own line"]
		)
	),
	PE: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"per",
			"2013-1",
			"99e02b78c737100ebebb202777c7251a6f8edad9b76a859c97b9d733c1e5f699",
			[["Sr. José Galvez Lora", "Av. Larco 1301, Miraflores", "15074", "LIMA", "PERU"]],
			[
				"the district (`Miraflores`) after a comma on the street line; this layout prints the locality on its own line above the postcode",
				"`N°` between a street name ending in a number and the house number (`Calle 10 Nº 985`)",
			]
		)
	),
	PS: described(
		NoFormat,
		"after-locality",
		upuDescription(
			"pse",
			"2025-5",
			"ad65f19985eb4b441f2712a28f67fc86901e3adfb21229dd94b1298ce6d992c3",
			[
				["Mr. Mahmoud Ameer", "Dahiyat al Bareed", "Gabriel Almataran", "Ar Ram", "JERUSALEM P126xxxx", "PALESTINE"],
				["Company ABC", "Mr. Chairman", "P.O. Box 123456", "Abu Dis", "JERUSALEM P144xxxx", "PALESTINE"],
			],
			[
				"the line labels: the description calls the line above the street `locality`, the town line `town` and the governorate line `locality + postcode`; this layout reads them as the district, the locality and the region",
				"the four-character delivery point the postcode ends with (`xxxx`)",
				"the house number, which no example prints; the street line keeps the number-first order the generator writes for a country its street table omits",
			]
		)
	),
	SA: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"sau",
			"2025-4",
			"d2ff2e0fc7976fe3271e1aa01df2b57cc93cf5d14d4d7069a8d12da5fa1ee1bc",
			[
				["Mr. Abdullah Nasser", "3909 Abdullhamid Alkatib St", "7318 Azahrah Dist.", "12987", "RIYADH", "SAUDI ARABIA"],
				["Mr. Abdullah Nassir", "P.O. Box 15501", "21454", "MAKKAH", "SAUDI ARABIA"],
			],
			[
				"the additional number before the district name (`7318 Azahrah Dist.`)",
				"the short address line below the addressee (`RAGI2929`)",
			]
		)
	),
	SB: described(
		NoFormat,
		"absent",
		upuDescription(
			"slb",
			"2005-3",
			"723617488b998f84fba2a127502591e045cc100deb1c3a8f3d27b9db696d558e",
			[["Ms. R. Pana", "P.O. Box 1925", "HONIARA", "SOLOMON ISLANDS"]],
			[`the one example is a P.O. Box; ${NO_STREET_EXAMPLE}`]
		)
	),
	SD: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"sdn",
			"2003-7",
			"bba55eb190ce3ec4ed4e8671d809672a7f77f1fb097734a2e5177ec2d4d2579a",
			[
				[
					"Mr. Mohamed Ahmed Ali",
					"Immeuble de la fraternité",
					"Rue Al-Comhouriya",
					"B.P. 211",
					"11111",
					"KHARTOUM",
					"SUDAN",
				],
			],
			[
				"the building line above the street (`Immeuble de la fraternité`)",
				"the P.O. box below the street (`B.P. 211`); this layout prints it above the street",
			]
		)
	),
	SL: described(
		NoFormat,
		"absent",
		upuDescription(
			"sle",
			"2002-7",
			"6f9b102f170ce8652ce57f19bbb32834aa4037b8b9c82ef392e2a4725336cfbb",
			[["Mr. John Kamara", "7A Ross Road Cline", "FREETOWN", "SIERRA LEONE"]],
			["the neighborhood written after the street on its line (`7A Ross Road Cline`)"]
		)
	),
	SS: described(
		NoFormat,
		"absent",
		upuDescription(
			"ssd",
			"2013-1",
			"bbe165f8a9bb65b2ee0ccebf07032b618b5e56dfccceb9b491918a0b25620b24",
			[
				[
					"Director for Postal Services",
					"Ministry of Telecommunications and",
					"Postal Services",
					"POST OFFICE BOX 33",
					"JUBA",
					"SOUTH SUDAN (REP.)",
				],
			],
			[`the only address printed is the operator's contact block; ${NO_STREET_EXAMPLE}`]
		)
	),
	ST: described(
		NoFormat,
		"absent",
		upuDescription(
			"stp",
			"2004-9",
			"0fdc05271d429a719742085e8d0a0d61772b0c349511c95264c8aa12201a179c",
			[["Sra. Eugenia Fernandes", "RIBEIRA AFONSO", "SAO TOME AND PRINCIPE"]],
			[`the one example prints the locality alone below the addressee; ${NO_STREET_EXAMPLE}`]
		)
	),
	SV: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"slv",
			"2019-5",
			"97ab4a4a8d4aad14e352440b092ddeeeca1baf8437fba81396e92a4d8dc2bbc7",
			[
				["JOSE ANTONIO PEREZ", "6a AVENIDA NORTE 165", "2201 SAN SALVADOR", "EL SALVADOR"],
				["JOSE ANTONIO PEREZ", "VILLA SANTA CECILIA", "CANTON LLANO DE LA LAGUNA", "2101 AHUACHAPAN", "EL SALVADOR"],
				[
					"Señor José Antonio Pérez",
					"Pasaje 7 23 H",
					"Colonia San Fernando",
					"1120 SOYAPANGO, SAN SALVADOR",
					"EL SALVADOR",
				],
			],
			[
				"the building name above the sub-locality in the rural example (`VILLA SANTA CECILIA`)",
				"the post office line below a P.O. box (`SUCURSAL SOPAYANGO`)",
			]
		)
	),
	SY: described(
		NoFormat,
		"before-locality",
		upuDescription(
			"syr",
			"2004-9",
			"c37a66c0487dad603b0304775d877449b71c495a503b74fc50776ec836c08b96",
			[
				[
					"Mr. Mohamed Ali",
					"01 02/0091",
					"Rue Youssef Al Azamah, no 25",
					"06/Saroufa",
					"0100 DAMASCUS",
					"SYRIAN ARAB REP.",
				],
			],
			[
				"the floor, apartment and building line above the street (`01 02/0091`)",
				"the district number before its name (`06/Saroufa`)",
				"`no` before the house number (`Rue Youssef Al Azamah, no 25`); the description states the postcode system was still being developed",
			]
		)
	),
	TD: described(
		NoFormat,
		"absent",
		upuDescription(
			"tcd",
			"2004-9",
			"adb7c6c18ccb3d3986ca1c4cfe18ca30ca847df92a4d92e91db9bec2368b94a9",
			[["Ms HALIME ABDELKADER", "BP 4148", "NDJAMENA", "CHAD"]],
			[`the one example is a P.O. Box; ${NO_STREET_EXAMPLE}`]
		)
	),
	TG: described(
		NoFormat,
		"absent",
		upuDescription(
			"tgo",
			"2005-3",
			"c9211c7ca05fbd72cb24fa76dc92d51a564664a35b359a349b4d3c302509c23e",
			[["M. Nicolas Ayi Patatu", "B.P. 526", "LOME", "TOGO"]],
			[`the one example is a P.O. Box; ${NO_STREET_EXAMPLE}`]
		)
	),
	TH: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"tha",
			"2017-9",
			"3c77aa2896327efba3defb199695de70f77938ba042b46a146eae6a465990311",
			[
				[
					"Mr. Kosin Trainikom",
					"491 Rangsit-Nakhon Nayok 4 Road, Prachathipat",
					"Amphoe Tanyaburi, Pathumthani",
					"12130",
					"THAILAND",
				],
				["Mr. Jafar Sobhani", "151 Moo 4, Tambon Paikongdin", "Amphoe Bangplama, Suphanburi", "72150", "THAILAND"],
			],
			[
				"the sub-district after a comma on the street line (`491 Rangsit-Nakhon Nayok 4 Road, Prachathipat`); this layout prints it on its own line",
				"the postcode's own line is a soft break, so one line writes `Pathumthani 12130`",
				"the Thai-script order, which the description doesn't print; the Latin table keeps libaddressinput's `lfmt`",
			]
		)
	),
	TK: described(
		NoFormat,
		"absent",
		upuDescription(
			"tkl",
			"2005-3",
			"19e3d5d9abbd54006dc927401140cc313223245e99b7a649aa34a3b1c3588fb4",
			[["See New Zealand."]],
			[
				"New Zealand's postcode, which New Zealand's description (`nzlEn.pdf`, 08/2014) prints after the locality and which no Tokelau atoll has",
				"the rural delivery line New Zealand's description prints below the street (`RD 2`)",
			]
		)
	),
	TL: described(
		NoFormat,
		"after-locality",
		upuDescription(
			"tls",
			"2026-8",
			"569613b0df32690fc0c46cbc21d5523fe39e65308fea201317efe4fa8f288f3f",
			[["Mr. Mateus da Costa", "TRAVESSA LAVANDARIA NO.12", "BAIRO PITE – DILI TL11212", "PO Box 201", "TIMOR-LESTE"]],
			[
				"the P.O. box below the locality line (`PO Box 201`); this layout prints it above the street",
				"`NO.` before the house number (`TRAVESSA LAVANDARIA NO.12`)",
				"the mobile telephone number the description lists as line 5",
			]
		)
	),
	TM: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"tkm",
			"2020-12",
			"fb32d14611b6b080a822632d608ec9f47d658b2ed84a29aff460e52a475f0234",
			[
				["Komekova Tatyana Gurbanowna", "j. 19 otag 1", "kv. 122", "sh. BALKANABAT", "BALKAN wel.", "745100"],
				[
					"Hekimov Rovshen Gurbangeldiyevich",
					"koche Amyderya, j. 24",
					"oba Yokary-shor, sh-che Beshir",
					"HOJAMBAZ etr.",
					"LEBAP wel.",
					"746150",
				],
			],
			[
				"`j.` before the building number and `otag` before the apartment (`koche Amyderya, j. 24`)",
				"the sub-province line between the locality and the province (`HOJAMBAZ etr.`)",
				"the telephone number the examples print below the postcode",
			]
		)
	),
	TO: described(
		NoFormat,
		"absent",
		upuDescription(
			"ton",
			"2002-7",
			"148463a7eeefe60d86fb2549dfb32f330edea557977dcd28767481883a66972d",
			[["Tonga Post", "General Post Office", "NUKU’ALOFA", "TONGA"]],
			[`the only address printed is the operator's contact block; ${NO_STREET_EXAMPLE}`]
		)
	),
	TR: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"tur",
			"2022-7",
			"5a4ba8333d75decf67ec88b5ea71eeb45db8c3587a50809dece217a50779b005",
			[
				["Hasan Taşkin", "Doğanbey Mah.", "Şehitteğmenkalmaz Cad. 28/A", "06101 ULUS/ANKARA", "TÜRKİYE"],
				["Hasan Taşkin", "İstasyon Mah.", "Sağlik Sok. No:5", "06850 HASANOĞLAN/ELMADAĞ", "TÜRKİYE"],
			],
			[
				"the sub-locality written at the start of the street line (`Doğanbey Mah. Posta Cad. 18`), which this layout prints on its own line",
				"the sub-locality number after the postcode (`06050-01`)",
				"`No:` before the house number (`Sağlik Sok. No:5`)",
			]
		)
	),
	TV: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"tuv",
			"2023-8",
			"4f23a29cd93337be23a1fb16f66f56c25a56de78e03edfcd3cd52d33bb68fdf5",
			[
				["Mr. Mose Boreham", "Te Vao Road", "TUV150 Vaiaku", "Funafuti", "TUVALU"],
				["Mr. Faoo Kalotu", "TUV710 Lolua", "Nanumea", "TUVALU"],
			],
			[
				"the postcode's stated form, `6 digits`, which the examples write as `TUV` and three digits",
				"the house number on its own line (`House No.20`)",
			]
		)
	),
	TZ: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"tza",
			"2013-6",
			"aa6220c9b4af3ca2f16cc1868b92db37532a6b52985a37ffb438d49971b7bbd1",
			[
				["Mr. Joseph Mwamwaja", "Protea Apt 12", "22 Ally Hassan Mwinyi", "14111 MSASANI", "DAR ES SALAM", "TANZANIA"],
				["Managing Director", "Sangara Ltd", "P.O. Box 3002", "33100 MWANZA", "MWANZA", "TANZANIA"],
			],
			[
				"the district line between the postcode and the region in rural addresses (`25204 MACHAME KUSINI` then `HAI`)",
				"the apartment line above the street (`Protea Apt 12`)",
			]
		)
	),
	UY: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"ury",
			"2018-6",
			"9e1d30c880cb2eca0245c7c819c2a35071057ed3d877475bac6e51078f960782",
			[
				["Dr. Augusto Rodríguez", "Chaná 1215, apto. 152", "70200 – ROSARIO, COLONIA", "URUGUAY"],
				[
					"Lorena Díaz Martínez",
					"Calle 3 4575, Block 14, Apto. 103",
					"Complejo Habitacional - Millán y Raffo",
					"12900 – MONTEVIDEO",
					"URUGUAY",
				],
			],
			[
				"the supplementary-data line below the street (`Esquina Américo Ricaldoni`)",
				"the comma between the house number and the apartment (`Chaná 1215, apto. 152`)",
			]
		)
	),
	VC: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"vct",
			"2021-5",
			"c82f0791f9ee6587ce004f5edfd59019b2e8d473c0437678f17cdf564f7d865b",
			[
				["MS JESSICA FLETCHER", "HALIFAX STREET", "KINGSTOWN", "VC0120", "SAINT VINCENT AND THE GRENADINES"],
				["MR. JOHN HENRY", "P.O BOX BQ400", "BEQUIA", "VC0400", "SAINT VINCENT AND THE GRENADINES"],
			],
			[
				"the post office line between the locality and the postcode in rural addresses (`CALLIAQUA P.O.`)",
				"the postcode's own line is a soft break, so one line writes `KINGSTOWN VC0120`",
			]
		)
	),
	VG: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"vgb",
			"2007-2",
			"8222d048b8697a1183a97382816606f11d0c85c60031ccd62aa8f26a821f65b8",
			[["Mr. W.D. Smith", "P.O. Box 787", "#10 Road Town", "TORTOLA VG1110", "BRITISH VIRGIN ISLANDS"]],
			[
				"the `#` before the building number (`#10 Road Town`)",
				"the island in the locality's place (`TORTOLA VG1110`), with the town on the street line",
			]
		)
	),
	VU: described(
		NoFormat,
		"absent",
		upuDescription(
			"vut",
			"2005-3",
			"50cdc807d74d40913e43ffa028e3d0e05ce03905459808ce06a301751b228020",
			[["Vanuatu Post Limited", "P.O. Box 43", "PORT VILA", "VANUATU"]],
			[`the only address printed is the operator's contact block; ${NO_STREET_EXAMPLE}`]
		)
	),
	WS: described(
		NoFormat,
		"after-locality",
		upuDescription(
			"wsm",
			"2014-5",
			"fdb04fc6c4325a160b7bddd0c928017c89372cf3274c699d6df4d5433e8be213",
			[
				["Simi Siaki", "Manono Tai", "Manono WS1190", "SAMOA"],
				["Simi Siaki", "PO Box 301", "Manono Tai", "Manono WS1190", "SAMOA"],
			],
			[
				"the P.O. box above the sub-locality (`PO Box 301` then `Manono Tai`); this layout prints the box above the street, which the examples print none of",
			]
		)
	),
	YE: described(
		NoFormat,
		"absent",
		upuDescription(
			"yem",
			"2005-3",
			"a6bfa419ec3939f371f46cb829b5ab4f40e6f036ced30c9f76a3849ed9a03b9a",
			[["See contact address"], ["Organisme général des postes", "B.P. 1993", "SANA'A", "YEMEN"]],
			[`the only address printed is the operator's contact block, a P.O. Box; ${NO_STREET_EXAMPLE}`]
		)
	),
	ZM: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"zmb",
			"2013-1",
			"68ed14ab0a822b8a23e0700402b89a265c3cafdba88e5dedb3ade60f7adf6a9a",
			[
				["Mr. Mwelwa Mwansa", "21 Independence Avenue", "KITWE 23456", "ZAMBIA"],
				["Mwila Mwila", "Flat 23A Walcourt Estate", "456 8th Street", "Northmead", "LUSAKA 12345", "ZAMBIA"],
			],
			[
				"the header's `5 digits to the left of the locality name`, which every one of the eleven examples contradicts; the description also states the postcodes weren't yet assigned",
				"the flat and building line above the street (`Flat 23A Walcourt Estate`)",
			]
		)
	),
}
