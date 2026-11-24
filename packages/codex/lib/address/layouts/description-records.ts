// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The citation behind each layout `UPU_PAS_ADDRESS_LAYOUTS` renders.
 *
 * Each record cites one country's UPU description and states the reason the table holds the country.
 * The records the L–Z review of 2026-11-24 added sit in `description-records/l-z.ts`,
 * and the MO–ZW review's in `description-records/mo-zw.ts`, which keeps each
 * module under the repository's line ceiling.
 */

// oxlint-disable max-lines -- one record per country, each quoting its description's example lines

import { ConventionSource } from "#address/convention-claims"
import { upuDescription } from "#address/layouts/citations/upu-description"
import { L_Z_DESCRIPTION_RECORDS } from "#address/layouts/description-records/l-z"
import { MO_ZW_DESCRIPTION_RECORDS } from "#address/layouts/description-records/mo-zw"
import { described, UPUAdmission, type UPUPostalAddressingRecord } from "#address/layouts/upu-pas"

const { FormatContradictsOrder, FormatOmitsLocality, NoFormat } = UPUAdmission

/**
 * Per-country description metadata.
 */
export const UPU_PAS_LAYOUT_RECORDS: Readonly<Record<string, UPUPostalAddressingRecord>> = {
	AE: {
		admittedBecause: UPUAdmission.FormatOmitsLocality,
		documentDate: "2014-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/areEn.pdf",
		sha256: "b6927cc8bae0a217610307c2346868255351a432d3f060f9a0177725e725bc4d",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["MR. OMAR HUSSAIN", "PO BOX 111", "DUBAI", "UNITED ARAB EMIRATES"]],
		postcode: "absent",
		unexpressed: [
			"delivery to P.O. Boxes only, which the description states for every address",
			"the emirates the description lists (`DUBAYY (DUBAI)`), which no example prints; libaddressinput's `%S` printed one below the city",
		],
	},
	AF: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"afg",
			"2025-7",
			"6da229192ae8d8c7b80f39728e8ec3ac7ccdd4e582b8d88036ad4b4b823933a8",
			[
				["Jawad Ahmad Niazi", "16, Ziarat-e-Abolfazl St", "Murad Khani", "100208 KABUL", "AFGHANISTAN"],
				["Jamaludin Ahmadi", "50, First Lane", "Shino Village", "265101 HESARAK", "NANGARHAR", "AFGHANISTAN"],
			],
			[
				"the header's `6 digits at the right of district name or city`, which every example contradicts by printing the postcode first (`100208 KABUL`)",
				"the urban examples' province on the postcode line (`100208 KABUL`, `postcode + province`); this layout prints the city there and the province on its own line, as the rural examples do",
				"the building line below the locality (`8, fifth floor, Bilal Wardak Plaza`)",
			]
		)
	),
	AM: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"arm",
			"2021-12",
			"3daba7e4d1b9a885ef1b979ed1faef670bceca7e412f3cfff90527161758d4ec",
			[
				["Armen Simonyan", "Saryan str 22 apt 25", "0002 YEREVAN", "ARMENIA"],
				["HayPost CJSC", "Saryan 22", "0002 YEREVAN", "ARMENIA"],
				["Armen Simonyan", "PO Box 28", "0010 YEREVAN", "ARMENIA"],
			],
			[
				"the marz (region), which no example prints; libaddressinput's `%S` printed it below the locality",
				"the recommendation to avoid full stops, dashes and commas",
			]
		)
	),
	AO: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2004-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/agoEn.pdf",
		sha256: "8a85d5bc908767cea0a5816482b8907a4abe3e86073c177060bf7252a9b9309b",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["Sr. Jõao Pembele", "Rua Frederik Engels 92 – 7 o", "LUANDA", "ANGOLA"]],
		postcode: "absent",
		unexpressed: ["the floor, printed after the house number with a dash (`92 – 7 o`)"],
	},
	AR: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"arg",
			"2002-7",
			"3dcd01d52a878d44e2ac914ba04516c29076ad27140c1199da8c431a3a395489",
			[
				["SIGNUM SRL", "JUAN LOPEZ", "SAN MARTIN 230", "PISO 4 DPTO. A", "Y5900FNF VILLA MARIA", "ARGENTINA"],
				["SR. JUAN LOPEZ", "CASILLA DE CORREOS 432", "CORREO CENTRAL", "C1000WAE CAPITAL FEDERAL", "ARGENTINA"],
			],
			[
				"the province, which no example prints and the postcode's first letter encodes; libaddressinput's `%S` printed it below the locality",
				"the floor and department on their own line below the street (`PISO 4 DPTO. A`); this layout prints the unit on the street line",
				"the post office name line below the P.O. Box (`CORREO CENTRAL`)",
			]
		)
	),
	AW: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2019-1",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/abwEn.pdf",
		sha256: "29379581a003bf1c82c75d2ea5b4dae420376f34b7da33def08eabd1963997c1",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Mr. Brown", "Sun Plaza Suite 110", "L.G. Smith Boulevard #160", "ORANJESTAD", "ARUBA"],
			["EPI College", "Sero Blanco", "ORANJESTAD", "ARUBA"],
		],
		postcode: "absent",
		unexpressed: ["the `#` written before a house number (`L.G. Smith Boulevard #160`)"],
	},
	AZ: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"aze",
			"2019-7",
			"6a582fa45f33d3855ac96cdd4639aa250b6f3e72885e9f83e3b41822043ce9f1",
			[
				["Shamsaddin Gadirov", "Zərifə Əliyeva küç., ev 9", "AZ1010 Bakı şəh.", "AZERBAIJAN"],
				[
					"Zamanli Elçin Әləddin oğlu",
					"AZ6715 Nehrəm kəndi",
					"Babək rayonu",
					"Naxçivan Muxtar Respublikasi",
					"AZERBAIJAN",
				],
				["UNIBANK Commercial Bank OJSC", "Rashid Behbudov küç. 55", "AZ1014 Baku", "AZERBAIJAN"],
			],
			[
				"the `AZ` joined to the four digits (`AZ1010`); this layout keeps libaddressinput's `AZ ` with a space, which the postcode-prefix review left in place",
				"the comma and `ev` before the house number in the home example (`Zərifə Əliyeva küç., ev 9`)",
			]
		)
	),
	BF: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"bfa",
			"2021-12",
			"2f74e36fe7f03af1b18fe408be3a964ae119ba2bb731fb1a5e70ce14060d699f",
			[
				[
					"ISSA Ibrahim",
					"Domicile 1114",
					"566 Avenue de la Nation",
					"BV 31000 OUAGA CNT",
					"10010 OUAGADOUGOU",
					"BURKINA FASO",
				],
				[
					"La Poste Burkina Faso",
					"566 Avenue de la Nation",
					"Dapoya",
					"BP 6000 OUAGA CNT",
					"10000 OUAGADOUGOU",
					"BURKINA FASO",
				],
				["ISSA YAHAYA", "BP 56", "91001 BAMA", "BURKINA FASO"],
			],
			[
				"the P.O. box with its post office below the street and neighborhood (`BP 6000 OUAGA CNT`); this layout prints the box above the street",
				"the premise line above the street (`Domicile 1114`)",
			]
		)
	),
	BI: described(
		NoFormat,
		"absent",
		upuDescription(
			"bdi",
			"2025-11",
			"07960bf5d11b37e8578267372257e8c807d6dba02fd716dbdb1bfdd1e16e580c",
			[
				["Madame NIYIBIGIRA Esther", "BP 1915", "MUKAZA", "BUJUMBURA", "BURUNDI"],
				["Monsieur KINDOLECHA KYLOUS Philemon", "BP 57", "MUYINGA", "BUHUMUZA", "BURUNDI"],
			],
			["no street address: both examples are P.O. boxes, so the number-first street line is this layout's choice"]
		)
	),
	BJ: described(
		NoFormat,
		"absent",
		upuDescription(
			"ben",
			"2025-11",
			"089a4f4dfbe94dd4adf397c19745e80f10f3cbf2b7765e207f22309f095b52b7",
			[["Mr Gérald Zanvonon", "10 BP 648", "COTONOU", "Tel: +229 61 20 80 80", "BENIN"]],
			[
				"the delivery office's two digits before the P.O. box (`10 BP 648`)",
				"the telephone line between the locality and the country",
				"no street address: the example is a P.O. box, so the number-first street line is this layout's choice",
			]
		)
	),
	BM: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"bmu",
			"2026-4",
			"1c0107c7af16d762a3d02a7926a9dcc553999c6e62cac601779b9bb4a8c1b5f2",
			[
				["Mr. & Mrs Householder", "Upper Apt # 1", "9 Leafy Lane", "SMITH'S FL 07", "BERMUDA"],
				["Mr. Boxholder", "PO Box HM 2469", "HAMILTON HM GX", "BERMUDA"],
			],
			["the postcode's first two letters repeated before the P.O. box number (`PO Box HM 2469`)"]
		)
	),
	BO: described(
		NoFormat,
		"absent",
		upuDescription(
			"bol",
			"2026-2",
			"777e1fa760f16648ecd3d4a4f8e4272faef953d390dcaed82db363fdbc518281",
			[
				["SEÑOR", "FREDDY LANDIVAR G", "CALLE AZURDUY 158", "SUCRE", "BOLIVIA"],
				[
					"La Poza del Pato",
					"Comunidad de Coimata",
					"Zona Turística en Tarija",
					"La última casa en Coimata al lado de las Pozas",
					"TARIJA",
					"BOLIVIA",
				],
			],
			[
				"the rural example's two sub-locality lines above a descriptive line (`Comunidad de Coimata`, `Zona Turística en Tarija`), of which one district line is kept",
			]
		)
	),
	BZ: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2021-5",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/blzEn.pdf",
		sha256: "a6f77003af704e7b46e30d50a2f5cfaf06f25793153968af773993a21a0cf61e",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["Mr. Jessel Monique Lauriano", "C Street Apt 2", "KINGS PARK, BELIZE CITY", "BELIZE C.A."]],
		postcode: "absent",
		unexpressed: [
			"two spaces between the street and the apartment number",
			"the country line `BELIZE C.A.`, which appends Central America",
		],
	},
	CD: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2022-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/codEn.pdf",
		sha256: "e66cfd3ae8589b582a3d79750cc43f9282d2d759c7ff5c6bb0a843dc83586c20",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			[
				"M MAKILA MUWULU Jean Fédor",
				"95, Blvd du 30 juin, Building INSS",
				"1003071 KINSHASA",
				"RÉPUBLIQUE DÉMOCRATIQUE DU CONGO",
			],
			[
				"M DUALE NKANU Béni",
				"S/c M MAKILA MUWULU Jean Fédor",
				"Avenue de la Poste N°1",
				"QUAR RESIDENTIEL 12ème Rue",
				"COM LIMETE",
				"1004131 KINSHASA",
				"RÉPUBLIQUE DÉMOCRATIQUE DU CONGO",
			],
		],
		postcode: "after-region",
		unexpressed: [
			"the urban examples' number after the street with `N°` (`Avenue de la Poste N°1`); the coding example's `95, Blvd du 30 juin` is the order kept",
			"the rural village, sector and territory lines (`Village NGIEME`, `Secteur de Niadi Nkara`, `Territoire de Bulungu`), of which one district line is kept",
		],
	},
	CF: described(
		NoFormat,
		"absent",
		upuDescription(
			"caf",
			"2022-3",
			"05c2b88912802d3beca5af348396da9a890101313ee9f091cde857af4380c631",
			[
				[
					"Mr. Mbalindou Jean Mari",
					"S/C Mr. NDOMONDJI André",
					"Telephone: (236 21) 61 32 22",
					"Evangelical Church Elim Bangui – M'Poko",
					"BP 729",
					"BANGUI",
					"CENTRAL AFRICAN REP.",
				],
			],
			[
				"the care-of, telephone and e-mail lines above the P.O. box",
				"no street address: both examples are P.O. boxes, so the number-first street line is this layout's choice",
			]
		)
	),
	CG: described(
		NoFormat,
		"absent",
		upuDescription(
			"cog",
			"2004-9",
			"4833c1280840190156fc40d5e85015ef96482a5aefe4fdab4306e2d1b2998463",
			[["M. Joseph Mbemba", "12, rue Kakamoueka", "BRAZZAVILLE", "CONGO (REP.)"]],
			["the centered alignment of the address lines"]
		)
	),
	CK: described(
		NoFormat,
		"absent",
		upuDescription(
			"cok",
			"2014-11",
			"a71a56ee4ce7227ee37366a1c9d0e044658df83c6c0b642e4c74b398136e3e8d",
			[
				["Christine Richardson", "PO Box 123", "RAROTONGA", "COOK ISLANDS"],
				["ANZ House", "Maire Nui Drive, Avarua", "RAROTONGA", "COOK ISLANDS"],
			],
			[
				"the locality after the street on one line (`Maire Nui Drive, Avarua`); this layout prints it on its own line above the island",
			]
		)
	),
	CM: described(
		NoFormat,
		"absent",
		upuDescription(
			"cmr",
			"2002-7",
			"695ccd31e39fea82cf54422c593ebe6135e0fba47f1e3d5abe3f823389595ddc",
			[["M. Pierre Marie", "BP 6000", "YAOUNDE", "CAMEROON"]],
			["no street address: the example is a P.O. box, so the number-first street line is this layout's choice"]
		)
	),
	CO: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"col",
			"2022-10",
			"5382e92b2ee99779bde90567be9a88833777b069c139e226743ad6fbd9b4aac5",
			[
				[
					"Ministerio de Tecnologias",
					"Edificio Murillo Toro",
					"Cra. 8a entre calles 12 y 13",
					"BOGOTA 111711",
					"COLOMBIA",
				],
				[
					"Sr John Guarin",
					"Calle 32a Sur Transversal 68b #5",
					"Alqueria La Fragua",
					"Localidad de Kennedy 110841",
					"BOGOTA D.C.",
				],
				["Adriana Gómez", "Arroyón", "PLANETA RICA 233057", "CORDOBA"],
			],
			[
				"the `#` before the premises number (`Transversal 68b #5`)",
				"the building line above the street (`Edificio Murillo Toro`)",
			]
		)
	),
	CR: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"cri",
			"2009-4",
			"0fef02144a8d5ed181898a1ccba4f7e375b920f96c8f4e3107dd2ba508c7b3f7",
			[
				[
					"Municipalidad de San Rafael de Heredia",
					"Ca 15 Av 37 # 55",
					"Heredia, San Rafael, San Rafael",
					"40501",
					"COSTA RICA",
				],
				["Señor Carlos Torres", "Apdo 257 – 3017", "Heredia, San Isidro, San Isidro", "3017-40601", "COSTA RICA"],
			],
			[
				"the street-and-avenue grid form (`Ca 15 Av 37 # 55`)",
				"the P.O. box's office code joined to the postcode (`3017-40601`)",
			]
		)
	),
	CU: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"cub",
			"2004-9",
			"70f892382ffbd36f8588005c50ef1b5df9951893c6eec29494fe242fafb9d334",
			[
				[
					"Ministerio Informática",
					"Ave Independencia s/n",
					"19 de Mayo y Aranguren",
					"Habana 6",
					"CP 10600 CIUDAD HABANA",
					"CUBA",
				],
				["Ministerio Informática", "6200", "Habana 6", "CP 10600 CIUDAD HABANA", "CUBA"],
			],
			[
				"the cross-streets line below the street (`19 de Mayo y Aranguren`)",
				"the province, which no example prints; libaddressinput's `%C %S` printed it after the locality",
			]
		)
	),
	CV: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"cpv",
			"2014-4",
			"c6f27544ebfd0695fd79efda3aa006ba061ec8626498814c72ff61adb1335ca6",
			[["Luis Felipe Ramos", "Rua 5 de Julho 138/Platô", "C.P. 38", "7600 PRAIA", "SANTIAGO", "CABO VERDE"]],
			["the zone joined to the number with a slash (`138/Platô`)"]
		)
	),
	CW: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2026-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/cuwEn.pdf",
		sha256: "f65a047ef09bb2615799d3924dcd47c9ae3b40f19cecaa62ecd5863aa6d7cfe6",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["John Doe", "Kaya Muizenberg 5", "WILLEMSTAD", "CURAÇAO"],
			["Acme Corporation", "Gosieweg 153", "WILLEMSTAD", "CURAÇAO"],
		],
		postcode: "absent",
		unexpressed: ["none: each example prints a street with its number, the locality and the country"],
	},
	DK: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"dnk",
			"2024-5",
			"306d35ea6a52e6c6981e67bb115c0934c8050c2841dccebdf9a4c749e7915f2f",
			[
				["Hr. Henrik Nielsen", "Kastanievej 15, 2, Agerskov", "8660 SKANDERBORG", "DENMARK"],
				["Hr. Henrik Nielsen", "Postboks 321", "8660 SKANDERBORG", "DENMARK"],
			],
			[
				"the floor after the house number with a comma (`15, 2`); this layout writes the unit after a space",
				"the P.O. box line below the street (rule 5); this layout prints the box above it",
			]
		)
	),
	DM: described(
		NoFormat,
		"absent",
		upuDescription(
			"dma",
			"2002-7",
			"4f1935283438c3f95d7074d45369279f0204dfd2018c5d7b99d1b44aef0c920f",
			[["Mr. Alvin Thomas", "Bay Front", "ROSEAU", "DOMINICA"]],
			["no house number in the example (`Bay Front`), so the number-first street line is this layout's choice"]
		)
	),
	EC: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"ecu",
			"2018-9",
			"2a516a61498559ffbb17f8add23b3fcfe70338ce8e8bf2905f6164fd5adc250e",
			[
				[
					"Sra. Julia Andrade",
					"9 de Octubre 425 y Boyacá",
					"Edificio Gran Pasaje, piso 3",
					"090306 - GUAYAQUIL",
					"ECUADOR",
				],
				[
					"Sr. José Guzmán",
					"Francisco Dalmau 547 y Calle 2",
					"Conjunto Real Audiencia, Bloque 3",
					"Conocoto",
					"170303 - QUITO",
					"ECUADOR",
				],
			],
			[
				"the intersecting street after the number (`425 y Boyacá`)",
				"the building and floor line below the street (`Edificio Gran Pasaje, piso 3`); this layout prints the unit on the street line",
			]
		)
	),
	ER: described(
		NoFormat,
		"absent",
		upuDescription(
			"eri",
			"2002-7",
			"2e35c27d9a506b2160ff7e2634ae6c0694d6de96197ec2a300481df9bc0db9a8",
			[["Mr. Samuel Habte", "Awet Street 4", "ASMARA", "ERITREA"]],
			["none: the example prints a street with its number after the name, the locality and the country"]
		)
	),
	FJ: described(
		NoFormat,
		"absent",
		upuDescription(
			"fji",
			"2004-9",
			"f17d5e82757cfbec5509ba128281b8f7bcd8430b0bfbf3058dd856d03f03350f",
			[["MR. JOHN DAVID", "14 VIRIA STREET", "VATUWAQA", "SUVA", "FIJI"]],
			["none: the example prints a street with its number first, the suburb, the town and the country"]
		)
	),
	GA: described(
		NoFormat,
		"before-locality",
		upuDescription(
			"gab",
			"2002-7",
			"6b9d452cc9c6a3810cec6c071817ab7b59451b4f3b4fd895f95c4811fc81bf3b",
			[
				["Mademoiselle Alice NGANGA", "CRP – MOULENGUI-BINDZA", "05 TCHIBANGA 01", "GABON"],
				["Monsieur Jean-Claude MAKAYA", "BP 13210", "01 LIBREVILLE–GROS-BOUQUET 03", "GABON"],
			],
			[
				"the delivery office number after the locality (`05 TCHIBANGA 01`)",
				"no street address: the home example's line is delivery information (`CRP – MOULENGUI-BINDZA`), so the number-first street line is this layout's choice",
			]
		)
	),
	GD: described(
		NoFormat,
		"absent",
		upuDescription(
			"grd",
			"2026-10",
			"b4129587d08df5da0c11d241319bab0048b2ab7a115cb864350540da09742310",
			[
				["Mr. Tom Brown", "Woburn", "ST. GEORGE'S", "GRENADA (WEST INDIES)"],
				["Sharon Bell", "P.O. BOX 1500", "ST. GEORGE'S", "GRENADA (WEST INDIES)"],
			],
			[
				"no street address: the examples print a village or a P.O. box, so the number-first street line is this layout's choice",
				"the `(WEST INDIES)` the postal authority recommends after the country name",
			]
		)
	),
	GH: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2023-3",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/ghaEn.pdf",
		sha256: "d17abceeea47c280db128fb503e36102606d0f1b8735318141b36e5813bbd764",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Mr Derick Yeboah", "No. 7 Asafoatse Nettey Road", "Accra-Central GA-183-8164", "GREATER ACCRA", "GHANA"],
			["Mr Derick Yeboah", "DTD 1234", "Sakumono GT-372", "Tema", "GREATER ACCRA", "GHANA", "Tel: +233 22 111 1122"],
		],
		postcode: "after-locality",
		unexpressed: [
			"the digital address, the postcode extended by four digits (`GA-183-8164`), which takes the postcode's place",
			"the organization example's neighborhood after the street on one line (`Abdul Diouf Road, Ridge`)",
			"a telephone number printed as the last line",
		],
	},
	GI: described(
		FormatOmitsLocality,
		"after-locality",
		upuDescription(
			"gib",
			"2013-1",
			"551dd86673040cd55e3544add1454fd7d4387c603963dcaeb31bc462d7dbf69a",
			[
				["A N Other", "109 Gardiner’s Road", "Gibraltar", "GX11 1AA", "GIBRALTAR"],
				["Hassans", "PO Box 199", "Gibraltar", "GX11 1AA", "GIBRALTAR"],
			],
			["the domestic `E/V` that replaces the postcode and the country (`PO Box 1444` / `E/V`)"]
		)
	),
	GM: described(
		NoFormat,
		"absent",
		upuDescription(
			"gmb",
			"2002-7",
			"a40c0a2bec3f05cde5ed510a2c235342d45978dddcfb9f708ee2b304bfaf6631",
			[["Mr. A. Ceesay", "21 Liberation Avenue", "BANJUL", "GAMBIA"]],
			["none: the example prints a street with its number first, the locality and the country"]
		)
	),
	GQ: described(
		NoFormat,
		"absent",
		upuDescription(
			"gnq",
			"2023-3",
			"62f981fc273a3444297c1254510e10fb501b0da91ec54e6bde8d7c950a09e363",
			[
				[
					"Mr. Ignacio Nguema",
					"Viviendas sociales vicatana",
					"Portal 5, puerta 29",
					"BIOKO NORTE, MALABO, REBOLA",
					"EQUATORIAL GUINEA",
					"Tel: +240 XXX XXXXXX",
					"Email: XXXXX",
				],
				[
					"Mr. Ignacio Nguema",
					"Apartado postal 36",
					"MALABO",
					"EQUATORIAL GUINEA",
					"Tel: +240 XXX XXXXXX",
					"Email: XXXXX",
				],
			],
			[
				"the telephone and e-mail lines after the country",
				"the P.O. box example's one place line, labeled province (`MALABO`)",
			]
		)
	),
	GT: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"gtm",
			"2025-11",
			"9d1b7fabcd13429e5a1037a063fd0a120df5f0f4b4913ae085002e0476b5e8b4",
			[
				[
					"Luis Pérez",
					`6a. Avenida "A" 10-13, zona 1`,
					"Centro Vivo, torre 2, Apartamento 608",
					"01001 - Guatemala",
					"GUATEMALA, C.A.",
				],
				[
					"Andrés Padilla",
					"Carretera a El Salvador Kilómetro 25.5",
					"Finca Parga, Lote 5",
					"01065 Villa Canales, Guatemala",
					"GUATEMALA, C.A.",
				],
			],
			[
				"the premises line below the thoroughfare (`Centro Vivo, torre 2, Apartamento 608`); this layout prints the unit on the street line",
				"the postcode written without the dash in two of the four examples (`01013 Guatemala`)",
				"the department after the municipality (`01065 Villa Canales, Guatemala`)",
				"the country line `GUATEMALA, C.A.`, which appends Central America",
			]
		)
	),
	GU: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"gum",
			"2005-3",
			"870410bb4188a7a0ae6c18a61169e9b0aad36e5fd7be7f72dbd1f4898e463731",
			[
				[
					"Guam follows the United States of America postal system. Its state code is GU and its",
					"postal code ranges from 96910 to 96931.",
				],
			],
			[
				"the United States description's form, which this description defers to and prints no example of; this layout follows Puerto Rico's `%C PR %Z`",
			]
		)
	),
	GY: described(
		NoFormat,
		"after-locality",
		upuDescription(
			"guy",
			"2025-8",
			"e842f087516d58a27907b435c29020e58be0a45196715e1417f3382fffd64184",
			[
				["Mr Thom Jones", "Room 15", "183 /185 Marja Bulding", "Lacytown", "Georgetown", "4130106", "GUYANA"],
				[
					"Mr. The Manager",
					"Best Buy Store",
					"15 Public Road Section B",
					"Non Pariel Village",
					"East Coast Demerara",
					"4212501",
					"GUYANA",
				],
			],
			["the room line above the street (`Room 15`); this layout prints the unit on the street line"]
		)
	),
	HN: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"hnd",
			"2004-5",
			"b8ac985c31c7331810dd8b9637e7b527cdb5ced0a2cdc5fa6e9435de8dc48b6c",
			[["Sr. Juan C. Martel", "CM1102 LAS LAJAS, COMAYAGUA", "HONDURAS (REP)"]],
			[
				"the description's two letters and four digits (`CM1102`), which predates the postcodes the corpus carries (`11101`)",
				"the country line `HONDURAS (REP)`",
			]
		)
	),
	ID: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"idn",
			"2013-1",
			"e0e24bc0450811082a0f5b114f82547438b14a6103636baec31aa32f30e4d7f1",
			[
				["Ibu Wisynuprapto", "Jl. Ciburial Indah No. 47", "BANDUNG 40198", "INDONESIA"],
				[
					"Sdr. Guntara Purasenjaya",
					"Jl. Sadang No. 51 RT 02/16",
					"Ciburuy",
					"Padalarang",
					"BANDUNG 40553",
					"INDONESIA",
				],
			],
			[
				"the province, which the description marks `Not used in address`; libaddressinput's `%S` printed it before the postcode",
				"the `No.` before the house number (`Jl. Ciburial Indah No. 47`)",
				"the second sub-locality line (`Ciburuy` above `Padalarang`), of which one district line is kept",
			]
		)
	),
	IL: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"isr",
			"2022-10",
			"0ffa94d2cb08202aeabe9ca714ebffc8e1c5fb4a40b74b2248f85a39157a6b30",
			[["Mr. Ploni Almoni", "16 Yafo Street", "9414219 JERUSALEM", "ISRAEL"]],
			[
				"the number before the street in the English example (`16 Yafo Street`); this layout keeps the number after the name, as Hebrew writes it, which the description prints no example of",
				"the `VIA ISRAEL` line for the Palestinian Authority",
			]
		)
	),
	IR: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"irn",
			"2023-10",
			"eec183fe7774bfbf61f425db5b4d81ca52b57c4736d08b607edf07c44ebcb343",
			[
				[
					"Mr. Ali Yazdani",
					"Tehran(city), Tehranpars",
					"West 196 street",
					"No. 12 third floor",
					"Tehran Province",
					"1619614153",
					"IRAN (ISLAMIC REP.)",
				],
				[
					"Mr. Jafar Sobhani",
					"Mahallat (township), Khurhe village",
					"Markazi Province",
					"8453193445",
					"IRAN (ISLAMIC REP.)",
				],
			],
			[
				"the premise on its own line below the street (`No. 12 third floor`); this layout prints the number on the street line",
				"the word `Province` after the province name",
				"the P.O. box form, which drops the postcode and prints the box below the province (`Fars Province` / `P.O.Box 71515-393`)",
			]
		)
	),
	JO: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"jor",
			"2004-9",
			"78e7bdc77423127e3ec09a48546bf06ace0ff4fd1288db1704c66d0b62221082",
			[
				[
					"Mr. Mohamed Moustafa Al-Auramla",
					"Habitat Abou Nosseir",
					"Ruelle 5",
					"Al Mohazab Al Halabi",
					"27–T2",
					"AMMAN 11937",
					"JORDAN",
				],
			],
			[
				"the region line above the district line (`Habitat Abou Nosseir` / `Ruelle 5`), of which one district line is kept",
				"the number and apartment on their own line below the street (`27–T2`)",
			]
		)
	),
	KE: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"ken",
			"2004-9",
			"ecca8cf3c54c2effdd8ed733723f8215b4c8edd2ce9ec22ac26a74c801f43239",
			[["MR. JOHN BWANA", "P O BOX 2784 – NAKURU GPO", "20100", "NAKURU", "KENYA"]],
			["the delivery post office after the P.O. box number (`P O BOX 2784 – NAKURU GPO`)"]
		)
	),
	KG: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"kgz",
			"2019-3",
			"3bbe1f5f962162e0f42d6ab65f66ad6327e468aeec167be351a2b9d16d655ddd",
			[
				["Kolpaeva Anara", "193, Avenue Chuy, apt. 28", "720001 BISHKEK", "KYRGYZSTAN"],
				["Kolpaeva Anara", "68, Atahan str.", "722300 BOKONBAEVO VILLAGE", "ISSYK-KUL REGION", "KYRGYZSTAN"],
			],
			["the comma before the apartment (`Avenue Chuy, apt. 28`); this layout writes the unit after a space"]
		)
	),
	RW: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2005-3",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/rwaEn.pdf",
		sha256: "6013d3bf246d19798ae3c39115834be48ac73690838ad636f36e102b79ecc1ad",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["M. Pierre Simon", "B.P. 3425", "KIGALI", "RWANDA"]],
		postcode: "absent",
		unexpressed: [
			"the one example is a P.O. Box (`B.P. 3425`); the street line takes the box's place above the locality, where every other description here prints it",
		],
	},
	KI: {
		admittedBecause: UPUAdmission.FormatContradictsOrder,
		documentDate: "2020-10",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/kirEn.pdf",
		sha256: "d6b0f0420517f1a287d5aa4c8128b2e18f05ffbe076b9f2493a4474ca33b5d42",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Mr. Teekia Rui", "Vaticano", "Butaritari KI0102", "KIRIBATI"],
			["Ms. Josephine Matiota", "PO Box 487", "Betio", "Sth Tarawa KI0108", "KIRIBATI"],
			["Ms. Meerite Toantei", "Abaunamou", "Teaoraereke", "Sth Tarawa KI0107", "KIRIBATI"],
		],
		postcode: "after-locality",
		unexpressed: [
			"the island group (Gilbert, Phoenix, Line), which no example prints; libaddressinput's `%S` printed it above the village",
			"the village or town line, which the examples label `village`, `town` or `delivery post office`; it renders here as the district line above the island",
			"the what3words line of the household example (`truly.ramping.sheriffs`)",
		],
	},
	KN: described(
		FormatContradictsOrder,
		"after-locality",
		upuDescription(
			"kna",
			"2017-12",
			"37d1733ce1694b98efd39a7a89f0345ff2f6f63d8d8b5915180faab1abd2b305",
			[
				["Clovis Doe", "Hamilton Street", "Cayon Project", "St. Kitts", "KN0602"],
				["John Doe", "2 Fern Street", "Greenlands", "Bassetere", "St Kitts", "KN0101"],
				["Shiela M. Doe", "Brown Hill", "Nevis", "KN0902"],
			],
			["the postcode as the last line with no country line after it, which an international address adds"]
		)
	),
	KW: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"kwt",
			"2002-7",
			"cf9328f4676ded754e903367241d387e805cde34055b947ec2d4af2b3dd06016",
			[
				["Hamad Abdallah Hassan", "Al-Sabbahiya", "Parcelle 4, rue 3, immeuble 11", "54404 KUWAIT", "KUWAIT"],
				["Hamad Abdallah Hassan", "Al-Sabbahiya", "B.P. 48001", "54551 KUWAIT", "KUWAIT"],
			],
			["the block, street and building numbers on the street line (`Parcelle 4, rue 3, immeuble 11`)"]
		)
	),
	KZ: described(
		FormatContradictsOrder,
		"before-locality",
		upuDescription(
			"kaz",
			"2025-7",
			"492fdb677f9ecf2ac7d6bd2e48a7c7b76f7f5739c0cfe073fc5f0ddb7e0f0a11",
			[
				["Batyrov Serik Erlanovich", "ul. Ryskulbekov, dom16, kv 224", "Z00Y5M7, g. ASTANA", "KAZAKHSTAN"],
				[
					"Sydykova Aiman Abishevna",
					"ul. Shieli, dom 15",
					"L16T0H2, selo Abay",
					"Karasayskiy raion",
					"ALMATINSKIY OBLAST",
					"KAZAKHSTAN",
				],
			],
			[
				"the `dom` and `kv` before the house and flat numbers (`ul. Ryskulbekov, dom16, kv 224`)",
				"the locality type before the name (`g. ASTANA`, `selo Abay`)",
			]
		)
	),
	LV: {
		admittedBecause: UPUAdmission.FormatContradictsOrder,
		documentDate: "2023-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/lvaEn.pdf",
		sha256: "251b08b058d31783d47b417ad7ced517f140d51de06b09df3acb0752991f8dc3",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Jānis Bērziņš", "Kr. Barona street 7, dz. 1", "RIGA, LV–1050", "LATVIA"],
			["Jānis Berziņš", "Valdemāra street 42, Ainaži,", "SALACGRIVAS NOV., LV–4035", "LATVIA"],
		],
		postcode: "after-locality",
		unexpressed: [
			"the sub-locality example's line break: `Valdemāra street 42, Ainaži,` then `SALACGRIVAS NOV., LV–4035`; the national register's one-line form (`Dzirnavu iela 1, Mazsalaca, Valmieras nov., LV-4215`) is the one kept",
			"the apartment after the number (`dz. 1`)",
			"the en dash in `LV–1050`; the postcode's `LV-` is written with the hyphen the national register prints (`LV-4215`)",
		],
	},
	RO: {
		admittedBecause: UPUAdmission.FormatContradictsOrder,
		documentDate: "2007-10",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/rouEn.pdf",
		sha256: "a59ca12648bd36f39d90be6f5f40bb50193462267d7f4e2dc3741e99f21babfa",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Posta Romana S.A.", "Calea Giulesti 6–8", "060274 BUCHAREST", "ROMANIA"],
			["ASTRA", "Drumul Taberei nr. 35, bl. F5, sc. 2, parter, ap. 23", "Sector 6", "061357 BUCHAREST", "ROMANIA"],
		],
		postcode: "before-locality",
		unexpressed: [
			"the county (județ), which no example prints; libaddressinput's `%Z %S %C` wrote it between the postcode and the locality",
			"the block, staircase, floor and apartment after the number (`bl. F5, sc. 2, parter, ap. 23`)",
		],
	},
	...L_Z_DESCRIPTION_RECORDS,
	...MO_ZW_DESCRIPTION_RECORDS,
}
