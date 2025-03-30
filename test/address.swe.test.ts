// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Gamla Varmdovagen 6",
	{
		// ---
		street: ["Gamla Varmdovagen"],
		house_number: ["6"],
	}
)

assert(
	// ---
	"Gamla Varmdovägen 6",
	{
		// ---
		street: ["Gamla Varmdovägen"],
		house_number: ["6"],
	}
)

assert(
	// ---
	"Gamla Varmdo vägen 6",
	{
		// ---
		street: ["Gamla Varmdo vägen"],
		house_number: ["6"],
	}
)

assert(
	// ---
	"Ångermannagatan 80, Vällingby",
	{
		// ---
		street: ["Ångermannagatan"],
		house_number: ["80"],
	}
)
