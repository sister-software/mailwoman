/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"6000, NSW, Australia",
	{
		// ---
		postcode: ["6000"],
		region: ["NSW"],
		country: ["Australia"],
	}
)

assert(
	// ---
	"Unit 12/345 Main St",
	{
		// ---
		unit_designator: ["Unit"],
		unit: ["12"],
		house_number: ["345"],
		street: ["Main St"],
	}
)

assert(
	// ---
	"U 12 345 Main St",
	{
		// ---
		unit_designator: ["U"],
		unit: ["12"],
		house_number: ["345"],
		street: ["Main St"],
	}
)

assert(
	// ---
	"Apartment 12/345 Main St",
	{
		// ---
		unit_designator: ["Apartment"],
		unit: ["12"],
		house_number: ["345"],
		street: ["Main St"],
	}
)

assert(
	// ---
	"Apt 12/345 Main St",
	{
		// ---
		unit_designator: ["Apt"],
		unit: ["12"],
		house_number: ["345"],
		street: ["Main St"],
	}
)

assert(
	// ---
	"Lot 12/345 Main St",
	{
		// ---
		unit_designator: ["Lot"],
		unit: ["12"],
		house_number: ["345"],
		street: ["Main St"],
	}
)

assert(
	// ---
	"U12/345 Main St",
	{
		// ---
		unit_designator: ["U"],
		unit: ["12"],
		house_number: ["345"],
		street: ["Main St"],
	}
)

assert(
	// ---
	"Lot 12/345 Illawarra Road Marrickville NSW 2204",
	{
		unit_designator: ["Lot"],
		unit: ["12"],
		house_number: ["345"],
		street: ["Illawarra Road"],
		locality: ["Marrickville"],
		region: ["NSW"],
		postcode: ["2204"],
	}
)

assert(
	// ---
	"Lot 2, Burrows Avenue, EDMONDSON PARK, NSW, Australia",
	{
		unit_designator: ["Lot"],
		unit: ["2"],
		street: ["Burrows Avenue"],
		locality: ["EDMONDSON PARK"],
		region: ["NSW"],
		country: ["Australia"],
	}
)
