/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stable ids for the publications that corpus rows come from.
 */

/**
 * The publications this repository reads, keyed by stable id.
 *
 * A row's `source` identifies the adapter or recipe that emitted it.
 * A row's `register` identifies the publication behind its record.
 * That publication determines the governing terms.
 *
 * Built corpora store these ids on every row, so an existing id must never change.
 *
 * An aggregator such as OpenAddresses or Overture is recorded as itself,
 * because its per-record upstream and terms vary.
 */
export const SourceRegister = {
	/**
	 * OpenAddresses, an aggregator over national and municipal address registers.
	 */
	OpenAddresses: "openaddresses",
	/**
	 * Overture Maps addresses, an aggregator whose rows include a per-record source and license.
	 */
	Overture: "overture",
	/**
	 * Who's On First, the gazetteer of places and postal codes.
	 */
	WhosOnFirst: "whos-on-first",
	/**
	 * OpenStreetMap.
	 */
	OpenStreetMap: "openstreetmap",
	/**
	 * GeoNames, the place-name gazetteer.
	 */
	GeoNames: "geonames",
	/**
	 * GeoNames postal-code tables, published separately from the place gazetteer.
	 */
	GeoNamesPostal: "geonames-postal",
	/**
	 * France's Base Adresse Nationale.
	 */
	BaseAdresseNationale: "fr-ban",
	/**
	 * Kartverket's `Matrikkelen - Adresse`, the Norwegian cadastre's address table.
	 *
	 * The prefix is the publisher's own country, as `fr-ban`'s is, and the dataset
	 * covers Svalbard beside the mainland.
	 */
	MatrikkelenAdresse: "no-matrikkelen-adresse",
	/**
	 * The INSPIRE Addresses theme of the Czech Office for Surveying, Mapping and Cadastre.
	 *
	 * ČÚZK publishes one zipped GML per municipality, 6,258 of them, through an ATOM service.
	 */
	CuzkInspireAddresses: "cz-cuzk-inspire-addresses",
	/**
	 * Suomen ympäristökeskus' Ryhti built-environment system. Its building address data
	 * covers Åland's sixteen municipalities beside the Finnish mainland in one national file.
	 *
	 * The prefix is the publisher's own country, as `fr-ban`'s is.
	 */
	RyhtiBuildingAddress: "fi-ryhti-building-address",
	/**
	 * Klimadatastyrelsen's INSPIRE Addresses theme for Denmark, published as a GeoPackage.
	 *
	 * One address is a join across five tables rather than a row.
	 */
	DKInspireAddresses: "dk-inspire-addresses",
	/**
	 * Estonia's Aadressiandmete süsteem, served as the INSPIRE Addresses theme by Maa- ja Ruumiamet.
	 *
	 * The tail is the system the theme is served out of.
	 */
	EstoniaADS: "ee-ads-aadress",
	/**
	 * The municipal EMUiA address registers, reaching the INSPIRE Addresses theme through
	 * the Państwowy Rejestr Granic and served by Główny Urząd Geodezji i Kartografii.
	 */
	PolandEMUiA: "pl-emuia-adresy",
	/**
	 * The INSPIRE Addresses theme of agentschap Digitaal Vlaanderen.
	 *
	 * Coverage is the Flemish Region rather than Belgium.
	 * Brussels and Wallonia publish the theme through their own services,
	 * so a Belgian build reads three registers.
	 */
	VlaanderenInspireAddresses: "be-vlaanderen-inspire-ad",
	/**
	 * The INSPIRE Addresses theme of the Service public de Wallonie, out of its ICAR register.
	 *
	 * Coverage is the Walloon Region.
	 * Flanders and Brussels publish the theme through their own services,
	 * so a Belgian build reads three registers.
	 */
	WallonieInspireAddresses: "be-wallonie-inspire-ad",
	/**
	 * The INSPIRE Addresses theme of the Brussels Regional Informatics Center, out of UrbIS.
	 *
	 * Coverage is the Brussels-Capital Region.
	 * The address-source register holds no row for this publisher, so no license is elected
	 * and `createIneligibilityReader` refuses every row the adapter emits.
	 *
	 * The id exists so the adapter can name its publication once a row is written.
	 */
	BrusselsInspireAddresses: "be-brussels-inspire-ad",
	/**
	 * The INSPIRE Addresses theme of Kadaster, the Dutch cadastre.
	 *
	 * One ATOM entry serves the whole country as a single gzipped GML.
	 */
	KadasterInspireAddresses: "nl-kadaster-inspire-ad",
	/**
	 * The INSPIRE Addresses theme the Ministerstvo vnútra Slovenskej republiky serves
	 * out of the national address register, as a paged WFS 2.0.
	 */
	SlovakiaInspireAddresses: "sk-minv-inspire-ad",
	/**
	 * The INSPIRE Addresses theme of the Dirección General del Catastro.
	 *
	 * Coverage is Spain outside the foral cadastres: 52 of the 55 entries in the national
	 * ATOM feed, one province feed each, listing one zipped GML per municipality.
	 * The other three entries link the publications below.
	 *
	 * Each of those states its own terms.
	 * Spain therefore needs four registers.
	 */
	CatastroInspireAddresses: "es-catastro-inspire-ad",
	/**
	 * The INSPIRE Addresses theme of the Diputación Foral de Bizkaia.
	 *
	 * Coverage is the province of Bizkaia, as 112 municipality archives.
	 * The archives hold addresses only, and the features they reference are served
	 * by the publisher's WFS rather than by the ATOM feed.
	 */
	BizkaiaInspireAddresses: "es-bizkaia-inspire-ad",
	/**
	 * The INSPIRE Addresses theme of the Diputación Foral de Gipuzkoa.
	 *
	 * One ATOM entry serves the whole province as a single zipped GML.
	 */
	GipuzkoaInspireAddresses: "es-gipuzkoa-inspire-ad",
	/**
	 * The INSPIRE Addresses theme of the Gobierno de Navarra.
	 *
	 * The province is split across 272 zipped GML partitions, each titled `Address Navarra`
	 * The title states no municipality.
	 */
	NavarraInspireAddresses: "es-navarra-inspire-ad",
	/**
	 * BD-Adresses, the georeferenced address file the Administration du cadastre et de
	 * la topographie publishes for Luxembourg through `data.public.lu`.
	 *
	 * The publisher describes it as a subset of the national register of localities and streets,
	 * enriched with coordinates, so the publication is narrower than that register.
	 */
	BDAdresses: "lu-act-bd-adresses",
	/**
	 * The OCDS release Autorità Nazionale Anticorruzione publishes for Italy's National Database
	 * of Public Contracts, reached through the Open Contracting Partnership's Data Registry.
	 *
	 * Every address in the release belongs to a contracting authority or a paying office,
	 * because the `supplier` role holds no address object.
	 */
	ANACContracts: "it-anac-ocds-contracts",
	/**
	 * Romania's school network, the Ministry of Education's list of every education unit and its address.
	 */
	ReteaScolara: "ro-edu-retea-scolara",
	/**
	 * FINESS, the health ministry's register of health and social establishments,
	 * read from its establishment extract on data.gouv.fr.
	 */
	FINESS: "fr-finess",
	/**
	 * The education ministry's Annuaire de l'éducation, the directory of schools and education offices.
	 */
	AnnuaireEducation: "fr-annuaire-education",
	/**
	 * The CORDIS organization files for the participants in the EU's research framework programmes
	 * (FP7, Horizon 2020, Horizon Europe), published by the Publications Office of the European Union.
	 *
	 * Each address is the one a participating legal entity registered with the participant register.
	 */
	CORDISParticipants: "eu-cordis-participants",
	/**
	 * Latvia's State Address Register (Valsts adrešu reģistrs), the open data Valsts zemes
	 * dienests publishes as the data.gov.lv dataset `varis-atvertie-dati`.
	 */
	VARIS: "lv-varis",
	/**
	 * GLEIF's Level 1 LEI golden copy: the legal and headquarters addresses of every LEI holder.
	 */
	GLEIFGoldenCopy: "gleif-lei-golden-copy",
	/**
	 * HM Land Registry Price Paid Data, England and Wales.
	 */
	LandRegistryPricePaid: "gb-hm-land-registry-ppd",
	/**
	 * Australia's Geocoded National Address File.
	 */
	GNAF: "au-gnaf",
	/**
	 * The United States Census Bureau's TIGER/Line road and address-range files.
	 */
	CensusTIGER: "us-census-tiger",
	/**
	 * The National Address Database, published by the US Department of Transportation.
	 */
	NationalAddressDatabase: "us-dot-nad",
	/**
	 * The FCC Broadband Data Collection location fabric.
	 */
	FCCBroadbandData: "us-fcc-bdc",
	/**
	 * The National Plan and Provider Enumeration System.
	 */
	NPPES: "us-nppes",
	/**
	 * HRSA's Federally Qualified Health Center file.
	 */
	HRSAHealthCenters: "us-hrsa-fqhc",
	/**
	 * The IMLS Public Libraries Survey.
	 */
	IMLSPublicLibraries: "us-imls-pls",
	/**
	 * The IRS Business Master File of tax-exempt organizations.
	 */
	IRSBusinessMasterFile: "us-irs-bmf",
	/**
	 * SAMHSA's behavioral health treatment services locator.
	 */
	SAMHSATreatmentLocator: "us-samhsa-treatment-locator",
	/**
	 * Hawaii Department of Education's school directory.
	 */
	HawaiiSchools: "us-hi-doe-schools",
	/**
	 * New York State's notary public register.
	 */
	NewYorkNotaries: "us-ny-notaries",
	/**
	 * Texas's notary public register.
	 */
	TexasNotaries: "us-tx-notaries",
	/**
	 * Iowa's Active Construction Contractor Registrations.
	 */
	IowaContractors: "us-ia-contractor-registrations",
	/**
	 * This repository's curated codex tables, such as country names, address layouts and postcode formats.
	 */
	Codex: "mailwoman-codex",
	/**
	 * Facts that a person read from a publisher and recorded here by hand.
	 *
	 * The reviewed file records the publisher.
	 */
	ReviewedByHand: "mailwoman-reviewed",
	/**
	 * A tuple extract under `$MAILWOMAN_DATA_ROOT/corpus/tuples/` whose upstream publication is unknown.
	 *
	 * A recipe whose tuples record their upstream passes that register instead.
	 */
	DerivedTuples: "mailwoman-derived-tuples",
} as const

/**
 * One of the {@link SourceRegister} ids.
 */
export type SourceRegister = (typeof SourceRegister)[keyof typeof SourceRegister]
