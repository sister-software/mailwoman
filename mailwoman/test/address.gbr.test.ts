// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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
