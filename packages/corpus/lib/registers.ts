/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The published registers corpus rows come from, as stable ids.
 *
 *   A row's `source` names the adapter or recipe that emitted it, which answers what code ran. A
 *   row's `register` names the publication its underlying record came from, which answers whose
 *   terms govern it and how much independent supply a country has. Two adapters over one
 *   publication carry one register id, and a recipe that renders a register's fields through a
 *   template carries that register too.
 *
 *   These ids are stored on every row of a built corpus, so they are wire values. Adding one is a
 *   normal change. Changing one that has been written breaks a corpus that already exists.
 */

/**
 * The publications this repository reads.
 *
 * An aggregator is recorded as itself.
 * OpenAddresses and Overture each redistribute many national registers under terms that
 * vary per record, and the file a row came from is what names its upstream.
 *
 * Recording the aggregator states what is known without asserting a national grant the row does not carry.
 */
export const SourceRegister = {
	/**
	 * OpenAddresses, an aggregator over national and municipal address registers.
	 */
	OpenAddresses: "openaddresses",
	/**
	 * Overture Maps addresses, an aggregator whose rows carry a per-record source and license.
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
	 * This repository's own codex tables — country names, address layouts, postcode formats.
	 *
	 * A row built from these names a published fact rather than a published record.
	 * The strings are curated here, so this register points at the repository
	 * and not at an outside publisher.
	 */
	Codex: "mailwoman-codex",
	/**
	 * Facts a person read from a publisher and recorded in this repository by hand.
	 *
	 * Used where no bulk source yielded rows and a small reviewed set stands in its place.
	 * The reviewed file names the publisher it was read from.
	 */
	ReviewedByHand: "mailwoman-reviewed",
} as const

export type SourceRegister = (typeof SourceRegister)[keyof typeof SourceRegister]
