/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"123 Main St, New York, NY 10010",
	{
		// ---
		house_number: ["123"],
		street: ["Main St"],
		locality: ["New York"],
		region: ["NY"],
		postcode: ["10010"],
	}
)

assert(
	// ---
	"123 Main St New York, NY 10010",
	{
		// ---
		house_number: ["123"],
		street: ["Main St"],
		locality: ["New York"],
		region: ["NY"],
		postcode: ["10010"],
	}
)

assert(
	// ---
	"123 Main St New York NY 10010",
	{
		// ---
		house_number: ["123"],
		street: ["Main St"],
		locality: ["New York"],
		region: ["NY"],
		postcode: ["10010"],
	}
)

assert(
	// ---
	"123 E 21st st, Brooklyn NY 11020",
	{
		// ---
		house_number: ["123"],
		street: ["E 21st st"],
		locality: ["Brooklyn"],
		region: ["NY"],
		postcode: ["11020"],
	}
)

assert(
	// ---
	"754 Pharr Rd, Atlanta, Georgia 31035",
	{
		house_number: ["754"],
		street: ["Pharr Rd"],
		locality: ["Atlanta"],
		region: ["Georgia"],
		postcode: ["31035"],
	}
)

assert(
	// ---
	"601 21st Ave N, Myrtle Beach, South Carolina 29577",
	{
		house_number: ["601"],
		street: ["21st Ave N"],
		locality: ["Myrtle Beach"],
		region: ["South Carolina"],
		postcode: ["29577"],
	}
)

assert(
	// ---
	"425 W 23rd St, New York, NY 10011",
	{
		// ---
		house_number: ["425"],
		street: ["W 23rd St"],
		locality: ["New York"],
		region: ["NY"],
		postcode: ["10011"],
	}
)

assert(
	// ---
	"1035 Comanchee Trl, West Columbia, South Carolina 29169",
	{
		house_number: ["1035"],
		street: ["Comanchee Trl"],
		locality: ["West Columbia"],
		region: ["South Carolina"],
		postcode: ["29169"],
	}
)

assert(
	// ---
	"Texas 76013",
	{
		// ---
		region: ["Texas"],
		postcode: ["76013"],
	}
)

assert(
	// ---
	"Dallas",
	{
		// ---
		locality: ["Dallas"],
	}
)

assert(
	// ---
	"California",
	{
		// ---
		region: ["California"],
	}
)

assert(
	// ---
	"New York",
	{
		// ---
		locality: ["New York"],
	}
)

assert(
	// ---
	"New York, NY",
	{
		// ---
		locality: ["New York"],
		region: ["NY"],
	}
)

assert(
	// ---
	"New York, New York",
	{
		// ---
		locality: ["New York"],
		region: ["New York"],
	}
)

assert(
	// ---
	"Santa Monica, California 90407",
	{
		// ---
		locality: ["Santa Monica"],
		region: ["California"],
		postcode: ["90407"],
	}
)

assert(
	// ---
	"Grand canyon 86023",
	{
		// ---
		locality: ["Grand canyon"],
		postcode: ["86023"],
	}
)

assert(
	// ---
	"CT, 06410",
	{
		// ---
		region: ["CT"],
		postcode: ["06410"],
	}
)

assert(
	// ---
	"BOOM",
	{
		// ---
		locality: ["BOOM"],
	}
)

assert(
	// ---
	"Niagara Falls 76B09",
	{
		// ---
		locality: ["Niagara Falls"],
	}
)

assert(
	// ---
	"Mt Tabor Park, 6220 SE Salmon St, Portland, OR 97215, USA",
	{
		venue: ["Mt Tabor Park"],
		house_number: ["6220"],
		street: ["SE Salmon St"],
		locality: ["Portland"],
		region: ["OR"],
		postcode: ["97215"],
		country: ["USA"],
	}
)

assert(
	// ---
	"Mt",
	{
		// ---
		region: ["Mt"],
	}
)
