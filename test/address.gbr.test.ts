/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Rushendon Furlong",
	{
		// ---
		street: ["Rushendon Furlong"],
	}
)

// Valid street name in London
assert(
	// ---
	"Broadway Market, London",
	{
		// ---
		street: ["Broadway Market"],
		locality: ["London"],
	}
)

// 'The Dove', a pub on Broadway Market
assert(
	// ---
	"24-28 Broadway Market, London",
	{
		// ---
		house_number: ["24-28"],
		street: ["Broadway Market"],
		locality: ["London"],
	}
)
