/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"
// street simple
assert(
	// ---
	"main pl",
	{
		// ---
		street: ["main pl"],
	}
)

// street directional
assert(
	// ---
	"west main st",
	{
		// ---
		street: ["west main st"],
	}
)

assert(
	// ---
	"main st west",
	{
		// ---
		street: ["main st west"],
	}
)

// street ordinal
assert(
	// ---
	"10th ave",
	{
		// ---
		street: ["10th ave"],
	}
)

// street cardinal
assert(
	// ---
	"10 ave",
	{
		// ---
		street: ["10 ave"],
	}
)

// address simple
assert(
	// ---
	"1 main pl",
	{
		// ---
		house_number: ["1"],
		street: ["main pl"],
	}
)

// address with ordinal
assert(
	// ---
	"100 10th ave",
	{
		// ---
		house_number: ["100"],
		street: ["10th ave"],
	}
)

// address with cardinal
assert(
	// ---
	"100 10 ave",
	{
		// ---
		house_number: ["100"],
		street: ["10 ave"],
	}
)

// address with directional
assert(
	// ---
	"1 north main blvd",
	{
		// ---
		house_number: ["1"],
		street: ["north main blvd"],
	}
)

assert(
	// ---
	"1 main blvd north",
	{
		// ---
		house_number: ["1"],
		street: ["main blvd north"],
	}
)

// address with directional & ordinal
assert(
	// ---
	"30 west 26th street",
	{
		// ---
		house_number: ["30"],
		street: ["west 26th street"],
	}
)

// street with directional, ordinal & admin info
assert(
	// ---
	"West 26th Street, New York, NYC, 10010",
	{
		// ---
		street: ["West 26th Street"],
		locality: ["New York"],
		postcode: ["10010"],
	}
)

// do not classify tokens preceeded by a 'place' as
// an admin classification
assert(
	// ---
	"Portland Cafe Portland OR",
	{
		// ---
		venue: ["Portland Cafe"],
		locality: ["Portland"],
		region: ["OR"],
	}
)

// trailing directional causes issue with autocomplete
assert(
	// ---
	"1 Foo St N",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St"],
	}
)

assert(
	// ---
	"1 Foo St S",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St"],
	}
)

assert(
	// ---
	"1 Foo St E",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St"],
	}
)

assert(
	// ---
	"1 Foo St W",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St"],
	}
)

// ...but we allow two letter directionals
assert(
	// ---
	"1 Foo St NW",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St NW"],
	}
)

assert(
	// ---
	"1 Foo St NE",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St NE"],
	}
)

assert(
	// ---
	"1 Foo St SW",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St SW"],
	}
)

assert(
	// ---
	"1 Foo St SE",
	{
		// ---
		house_number: ["1"],
		street: ["Foo St SE"],
	}
)

//#region Invalid solutions

assert(
	// ---
	"1 San Francisco"
)

assert(
	// ---
	"1 California"
)

assert(
	// ---
	"1 USA"
)

assert(
	// ---
	"1 San Francisco California"
)

assert(
	// ---
	"1 San Francisco USA"
)

assert(
	// ---
	"1 San Francisco California USA"
)

assert(
	// ---
	"1 California USA"
)

assert(
	// ---
	"1 90210"
)

// unit type specified with no accompanying unit number, unit type should
// be removed by the OrphanedUnitTypeDeclassifier.
assert(
	// ---
	"Apartment"
)

assert(
	// ---
	"Unit"
)

assert(
	// ---
	"Space"
)

// do not parse 'aus' as a locality if it follows a region
assert(
	// ---
	"new south wales aus",
	{
		// ---
		region: ["new south wales"],
		country: ["aus"],
	}
)

// test that we don't interpret "ga" as a street suffix
assert(
	// ---
	"jasper ga",
	{
		// ---
		locality: ["jasper"],
		region: ["ga"],
	}
)
