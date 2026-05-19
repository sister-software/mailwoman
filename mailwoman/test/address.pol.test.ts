// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/sdk/test"

assert(
	"Szewska 6, Kraków",
	// ---
	{
		street: ["Szewska"],
		house_number: ["6"],
		locality: ["Kraków"],
	}
)

assert(
	// ---
	"aleja Wojska Polskiego 178",
	{
		// ---
		street: ["aleja Wojska Polskiego"],
		house_number: ["178"],
	}
)

assert(
	// ---
	"aleja 29 listopada 11",
	{
		// ---
		street: ["aleja 29 listopada"],
		house_number: ["11"],
	}
)

assert(
	// ---
	"aleja Wojska 178",
	{
		// ---
		street: ["aleja Wojska"],
		house_number: ["178"],
	}
)

assert(
	// ---
	"Ulica Strzelecka 12, Nowy Sącz",
	{
		// ---
		street: ["Ulica Strzelecka"],
		house_number: ["12"],
		locality: ["Nowy Sącz"],
	}
)

assert(
	// ---
	"Żorska 11, 47-400",
	{
		// ---
		street: ["Żorska"],
		house_number: ["11"],
		postcode: ["47-400"],
	}
)
