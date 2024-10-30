/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassifierSchemeConfig } from "../../classification/Classification.js"
import GivenNameClassification from "../../classification/GivenNameClassification.js"
import PersonClassification from "../../classification/PersonClassification.js"

const configs: ClassifierSchemeConfig[] = [
	{
		// Anne Marie
		confidence: 0.25,
		Class: GivenNameClassification,
		scheme: [
			{
				is: ["GivenNameClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["GivenNameClassification"],
				not: ["StreetClassification", "StreetPrefixClassification", "StopWordClassification"],
			},
		],
	},
	{
		// Georges Bizet
		confidence: 0.5,
		Class: PersonClassification,
		scheme: [
			{
				is: ["GivenNameClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["SurnameClassification"],
				not: ["StreetClassification", "StreetPrefixClassification", "StopWordClassification"],
			},
		],
	},
	{
		// Rose de Lima
		confidence: 0.5,
		Class: PersonClassification,
		scheme: [
			{
				is: ["GivenNameClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["StopWordClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["SurnameClassification"],
				not: ["StreetClassification", "StreetPrefixClassification", "StopWordClassification"],
			},
		],
	},
	{
		// Raul Leite Magalhães (first name, middle name, family name)
		// Donald W. Reynolds
		confidence: 0.5,
		Class: PersonClassification,
		scheme: [
			{
				is: ["GivenNameClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["GivenNameClassification", "SurnameClassification", "MiddleInitialClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["SurnameClassification"],
				not: ["StreetClassification", "StreetPrefixClassification", "StopWordClassification"],
			},
		],
	},
	{
		// Unknown surname
		confidence: 0.1,
		Class: PersonClassification,
		scheme: [
			{
				is: ["GivenNameClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["AlphaClassification"],
				not: ["StreetClassification", "StreetPrefixClassification", "StopWordClassification"],
			},
		],
	},
	{
		// Unknown surname
		confidence: 0.1,
		Class: PersonClassification,
		scheme: [
			{
				is: ["GivenNameClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["StopWordClassification"],
				not: ["StreetClassification", "IntersectionClassification"],
			},
			{
				is: ["AlphaClassification"],
				not: ["StreetClassification", "StreetPrefixClassification", "StopWordClassification"],
			},
		],
	},
]

export default configs
