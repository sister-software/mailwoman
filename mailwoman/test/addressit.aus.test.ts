/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"2649 Logan Road, Eight Mile Plains, QLD 4113",
	{
		house_number: ["2649"],
		street: ["Logan Road"],
		locality: ["Eight Mile Plains"],
		region: ["QLD"],
		postcode: ["4113"],
	}
)

assert(
	// ---
	"2649 Logan Road Eight Mile Plains, QLD 4113",
	{
		house_number: ["2649"],
		street: ["Logan Road"],
		locality: ["Eight Mile Plains"],
		region: ["QLD"],
		postcode: ["4113"],
	}
)

assert(
	// ---
	"1 Queen Street, Brisbane 4000",
	{
		// ---
		house_number: ["1"],
		street: ["Queen Street"],
		locality: ["Brisbane"],
		postcode: ["4000"],
	}
)

assert(
	// ---
	"754 Robinson Rd West, Aspley, QLD 4035",
	{
		house_number: ["754"],
		street: ["Robinson Rd West"],
		locality: ["Aspley"],
		region: ["QLD"],
		postcode: ["4035"],
	}
)

assert(
	// ---
	"Sydney 2000",
	{
		// ---
		locality: ["Sydney"],
		postcode: ["2000"],
	}
)

assert(
	// ---
	"Perth",
	{
		// ---
		locality: ["Perth"],
	}
)

assert(
	// ---
	"1/135 Ferny Way, Ferny Grove 4054",
	{
		// ---
		house_number: ["1/135"],
		street: ["Ferny Way"],
		locality: ["Ferny Grove"],
		postcode: ["4054"],
	}
)

assert(
	// ---
	"Eight Mile Plains 4113",
	{
		// ---
		locality: ["Eight Mile Plains"],
		postcode: ["4113"],
	}
)

assert(
	// ---
	"8/437 St Kilda Road Melbourne, VIC ",
	{
		// ---
		house_number: ["8/437"],
		street: ["St Kilda Road"],
		locality: ["Melbourne"],
		region: ["VIC"],
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
	"Eight Mile Plains 9999",
	{
		// ---
		locality: ["Eight Mile Plains"],
		postcode: ["9999"],
	}
)
