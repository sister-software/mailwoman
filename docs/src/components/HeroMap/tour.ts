/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The home page tour: six queries and the answers Earth gave them.
 *   Each answer was recorded from `earth.mailwoman.ai/?q=<query>` on `RECORDED_ON`.
 *   The tier is the one Earth reported, coarse ones included, so the tour shows what a lookup returns today.
 *   Re-record an entry when the gazetteer or the model changes what it returns.
 */

/**
 * The date every answer below was read from Earth.
 */
export const RECORDED_ON = "2026-10-22"

export interface TourStop {
	/**
	 * The landmark the stop is about, as a caption.
	 */
	landmark: string
	/**
	 * The text typed into Earth.
	 */
	query: string
	/**
	 * The language the map labels switch to at this stop, as a basemap `name:<lang>` code.
	 */
	lang: string
	/**
	 * The resolved coordinate, as `[longitude, latitude]`.
	 */
	coordinates: readonly [number, number]
	/**
	 * The placetype Earth resolved to, in plain words.
	 */
	tier: string
	/**
	 * The camera zoom that frames the tier: closer for an address point, wider for a city.
	 */
	zoom: number
}

/**
 * The stops in the order the tour visits them, a lap around the Earth heading east from New York.
 */
export const TourStops: readonly TourStop[] = [
	{
		landmark: "Empire State Building",
		query: "350 5th Ave, New York, NY 10118",
		lang: "en",
		coordinates: [-73.985, 40.7478],
		tier: "interpolated address, ±64 m",
		zoom: 15.5,
	},
	{
		landmark: "Buckingham Palace",
		query: "Buckingham Palace, London SW1A 1AA",
		lang: "en",
		coordinates: [-0.1416, 51.501],
		tier: "postcode",
		zoom: 15,
	},
	{
		landmark: "Notre-Dame de Paris",
		query: "6 Parvis Notre-Dame - Place Jean-Paul II, 75004 Paris",
		lang: "fr",
		coordinates: [2.3428, 48.8587],
		tier: "city",
		zoom: 12.5,
	},
	{
		landmark: "Sagrada Família",
		query: "Carrer de Mallorca, 401, 08013 Barcelona",
		lang: "es",
		coordinates: [2.1531, 41.4036],
		tier: "city",
		zoom: 12.5,
	},
	{
		landmark: "Shibuya Station",
		query: "Shibuya Station, Tokyo",
		lang: "ja",
		coordinates: [139.7539, 35.6951],
		tier: "city",
		zoom: 11.5,
	},
	{
		landmark: "Space Needle",
		query: "400 Broad St, Seattle, WA 98109",
		lang: "en",
		coordinates: [-122.3493, 47.6205],
		tier: "address point, ≤10 m",
		zoom: 16,
	},
]
