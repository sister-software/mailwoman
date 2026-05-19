/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Rua Raul Leite Magalhães, 65, Tapiraí - SP, 18180-000, Brazil",
	{
		street: ["Rua Raul Leite Magalhães"],
		house_number: ["65"],
		locality: ["Tapiraí"],
		region: ["SP"],
		postcode: ["18180-000"],
		country: ["Brazil"],
	}
)
