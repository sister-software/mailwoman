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
	 * Suomen ympäristökeskus' Ryhti built-environment system, whose building address data
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
