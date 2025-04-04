/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Rua Luis de Camoes",
	{
		// ---
		street: ["Rua Luis de Camoes"],
	}
)

assert(
	// ---
	"Rua Padre Cruz 31 3060-187 Cantanhede",
	{
		// ---
		street: ["Rua Padre Cruz"],
		house_number: ["31"],
		postcode: ["3060-187"],
		locality: ["Cantanhede"],
	}
)

assert(
	// ---
	"Tv. da Horta 27A",
	{
		// ---
		street: ["Tv. da Horta"],
		house_number: ["27A"],
	}
)

assert(
	// ---
	"R Academia das Ciências 17C 1200-030 Lisboa",
	{
		// ---
		street: ["R Academia das Ciências"],
		house_number: ["17C"],
		postcode: ["1200-030"],
		region: ["Lisboa"],
	}
)

assert(
	// ---
	"Rua do Sol a Santa Catarina 17B, 1200-452 Lisboa",
	{
		// ---
		street: ["Rua do Sol a Santa Catarina"],
		house_number: ["17B"],
		postcode: ["1200-452"],
		region: ["Lisboa"],
	}
)

assert(
	// ---
	"Tv. dos Fiéis de Deus 12C Lisboa Portugal",
	{
		// ---
		street: ["Tv. dos Fiéis de Deus"],
		house_number: ["12C"],
		region: ["Lisboa"],
		country: ["Portugal"],
	}
)

assert(
	// ---
	"rua godinho de faria 1200",
	{
		// ---
		street: ["rua godinho de faria"],
		house_number: ["1200"],
	}
)

assert(
	// ---
	"rua godinho de faria 1200 porto",
	{
		// ---
		street: ["rua godinho de faria"],
		house_number: ["1200"],
		locality: ["porto"],
	}
)
