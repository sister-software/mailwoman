/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   generated — do not edit by hand. Sample localities and postcodes for each US state whose code is also
 *   another country's ISO 3166-1 alpha-2 code: the three most populous current localities under the state's
 *   region record in Who's On First's admin database, each with the postcode nearest its point among those
 *   whose parent is that locality in the US postcode database. The states are the codex-computed
 *   US_STATE_CODES_READ_AS_COUNTRIES.
 *   Regenerate with: mailwoman dev generate corpus-us-abbrev-region-samples
 */

/**
 * USPS state code → the sample localities and the postcode paired with each one, index for index.
 */
export const US_ABBREV_REGION_SAMPLES: Readonly<
	Record<string, { readonly localities: readonly string[]; readonly postcodes: readonly string[] }>
> = {
	AL: { localities: ["Huntsville", "Birmingham", "Montgomery"], postcodes: ["35816", "35225", "36106"] },
	AR: { localities: ["Little Rock", "Fort Smith", "Jonesboro"], postcodes: ["72204", "72901", "72467"] },
	AZ: { localities: ["Phoenix", "Tucson", "Mesa"], postcodes: ["85022", "85710", "85213"] },
	CA: { localities: ["Los Angeles", "San Diego", "San Jose"], postcodes: ["90071", "92134", "95112"] },
	CO: { localities: ["Denver", "Colorado Springs", "Aurora"], postcodes: ["80264", "80907", "80017"] },
	DE: { localities: ["Wilmington", "Dover", "Newark"], postcodes: ["19801", "19902", "19717"] },
	GA: { localities: ["Atlanta", "Columbus", "Augusta"], postcodes: ["31132", "31900", "30812"] },
	ID: { localities: ["Boise", "Meridian", "Nampa"], postcodes: ["83706", "83646", "83687"] },
	IL: { localities: ["Chicago", "Aurora", "Joliet"], postcodes: ["60607", "60505", "60435"] },
	IN: { localities: ["Indianapolis", "Fort Wayne", "Evansville"], postcodes: ["46204", "46805", "47739"] },
	KY: { localities: ["Louisville", "Lexington", "Bowling Green"], postcodes: ["40214", "40505", "42102"] },
	LA: { localities: ["New Orleans", "Baton Rouge", "Shreveport"], postcodes: ["70128", "70883", "71103"] },
	MA: { localities: ["Boston", "Worcester", "Springfield"], postcodes: ["02110", "01608", "01114"] },
	MD: { localities: ["Baltimore", "Columbia", "Germantown"], postcodes: ["21211", "21045", "20876"] },
	ME: { localities: ["Portland", "Lewiston", "Bangor"], postcodes: ["04101", "04240", "04401"] },
	MN: { localities: ["Minneapolis", "St. Paul", "Rochester"], postcodes: ["55400", "55101", "55901"] },
	MO: { localities: ["Kansas City", "St. Louis", "Springfield"], postcodes: ["64128", "63196", "65806"] },
	MS: { localities: ["Jackson", "Gulfport", "Southaven"], postcodes: ["39235", "39507", "38672"] },
	MT: { localities: ["Billings", "Missoula", "Great Falls"], postcodes: ["59102", "59801", "59401"] },
	NC: { localities: ["Charlotte", "Raleigh", "Greensboro"], postcodes: ["28207", "27605", "27395"] },
	NE: { localities: ["Omaha", "Lincoln", "Bellevue"], postcodes: ["68132", "68503", "68005"] },
	PA: { localities: ["Philadelphia", "Pittsburgh", "Allentown"], postcodes: ["19132", "15232", "18101"] },
	SC: { localities: ["Charleston", "Columbia", "North Charleston"], postcodes: ["29403", "29207", "29404"] },
	SD: { localities: ["Sioux Falls", "Brookings", "Yankton"], postcodes: ["57195", "57006", "57079"] },
	TN: { localities: ["Nashville", "Memphis", "Knoxville"], postcodes: ["37219", "38111", "37955"] },
	VA: { localities: ["Virginia Beach", "Chesapeake", "Arlington"], postcodes: ["23454", "23322", "22204"] },
}
