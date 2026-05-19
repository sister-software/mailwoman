/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Bulevardul Iuliu Maniu, Bucharest",
	{
		// ---
		street: ["Bulevardul Iuliu Maniu"],
		locality: ["Bucharest"],
	}
)

assert(
	// ---
	"Bdul Iuliu Maniu 111 Bucharest",
	{
		// ---
		street: ["Bdul Iuliu Maniu"],
		house_number: ["111"],
		locality: ["Bucharest"],
	}
)

assert(
	// ---
	"Splaiul Independenței 313",
	{
		// ---
		street: ["Splaiul Independenței"],
		house_number: ["313"],
	}
)

assert(
	// ---
	"15 Strada Doctor Carol Davila",
	{
		// ---
		house_number: ["15"],
		street: ["Strada Doctor Carol Davila"],
	}
)

assert(
	// ---
	"Calea Victoriei 54 Bucharest ",
	{
		// ---
		street: ["Calea Victoriei"],
		house_number: ["54"],
		locality: ["Bucharest"],
	}
)
