/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Korunní 810, Praha",
	{
		// ---
		street: ["Korunní"],
		house_number: ["810"],
		locality: ["Praha"],
	}
)

assert(
	// ---
	"Kájovská 68, Český Krumlov",
	{
		// ---
		street: ["Kájovská"],
		house_number: ["68"],
		locality: ["Český Krumlov"],
	}
)

assert(
	// ---
	"Beethovenova 641/9, Brno",
	{
		// ---
		street: ["Beethovenova"],
		house_number: ["641/9"],
		locality: ["Brno"],
	}
)
