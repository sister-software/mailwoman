/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type ClassifierSchemeConfig, CompositeClassifier } from "@mailwoman/core"

const configs: ClassifierSchemeConfig[] = [
	{
		// Main Street
		confidence: 0.82,
		scheme: [
			{
				is: ["alpha"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_suffix"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// Rue Montmartre or Boulevard Charles De Gaulle
		confidence: 0.88,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha", "person", "street_name"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// 26th Street
		confidence: 0.87,
		scheme: [
			{
				is: ["ordinal"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_suffix"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// 26 Street
		confidence: 0.86,
		scheme: [
			{
				is: ["numeric"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_suffix"],
				not: ["street", "intersection", "road_type"],
			},
		],
	},
	{
		// The Stables
		confidence: 0.82,
		scheme: [
			{
				is: ["stop_word"],
				not: ["street", "intersection"],
			},
			{
				is: ["place"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// SW 26th
		confidence: 0.77,
		scheme: [
			{
				is: ["directional"],
				not: ["street", "intersection"],
			},
			{
				is: ["ordinal"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// St Kilda Road
		confidence: 0.85,
		scheme: [
			{
				is: ["personal_suffix"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_suffix"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// N Main
		confidence: 0.98,
		scheme: [
			{
				is: ["directional"],
				not: ["intersection", "street"],
			},
			{
				is: ["street"],
				not: ["intersection", "directional"],
			},
		],
	},
	{
		// Martin Luther King Blvd.
		confidence: 0.82,
		scheme: [
			{
				is: ["person"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_suffix"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// Martin Luther King Jr. Blvd.
		confidence: 0.81,
		scheme: [
			{
				is: ["person"],
				not: ["street", "intersection"],
			},
			{
				is: ["personal_suffix"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_suffix"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// Rue De Paris
		confidence: 0.8,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["stop_word"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha", "person"],
				not: ["street", "street_prefix"],
			},
		],
	},
	{
		// Boulevard De La Paix
		confidence: 0.79,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["stop_word"],
				not: ["street", "intersection"],
			},
			{
				is: ["stop_word"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha"],
				not: ["street", "street_prefix"],
			},
		],
	},
	{
		// Rue Saint Anne
		confidence: 0.91,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["personal_title"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha", "given_name", "person"],
				not: ["street", "street_prefix"],
			},
		],
	},
	{
		// Aleja Wojska Polskiego
		confidence: 0.91,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["place"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha", "given_name", "person"],
				not: ["street", "street_prefix"],
			},
		],
	},
	{
		// Aleja 11 Listopada
		confidence: 0.84,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["numeric"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha", "given_name", "person"],
				not: ["street", "street_prefix"],
			},
		],
	},
	{
		// Boulevard du Général Charles De Gaulle
		confidence: 0.81,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["stop_word"],
				not: ["street", "intersection"],
			},
			{
				is: ["personal_title"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha", "given_name", "person"],
				not: ["street", "street_prefix"],
			},
		],
	},
	{
		// Avenue Aristide Briand or Allée Victor Hugo
		confidence: 0.92,
		scheme: [
			{
				is: ["street_prefix"],
				not: ["street", "intersection"],
			},
			{
				is: ["given_name", "alpha"],
				not: ["street", "intersection"],
			},
			{
				is: ["surname"],
				not: ["street", "street_prefix"],
			},
		],
	},
	{
		// Broadway Market
		confidence: 0.8,
		scheme: [
			{
				is: ["street_proper_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_suffix"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// Broadway
		confidence: 0.82,
		scheme: [
			{
				is: ["street_proper_name"],
				not: ["street", "intersection"],
			},
		],
	},
	{
		// +++ Main Street
		confidence: 0.84,
		scheme: [
			{
				is: ["alpha"],
				not: ["street", "intersection", "stop_word"],
			},
			{
				is: ["street"],
				not: ["directional"],
			},
		],
	},
	{
		// Highway 27
		confidence: 0.84,
		scheme: [
			{
				is: ["road_type", "toponym"],
			},
			{
				is: ["numeric"],
			},
		],
	},
	{
		// +++ +++ Main Street
		confidence: 0.84,
		scheme: [
			{
				is: ["alpha"],
				not: ["street", "intersection", "stop_word"],
			},
			{
				is: ["street"],
				not: ["directional"],
			},
		],
	},
	{
		// Main Street West
		confidence: 0.88,
		scheme: [
			{
				is: ["street"],
				not: ["directional"],
			},
			{
				is: ["directional"],
				not: ["street", "intersection", "end_token_single_character"],
			},
		],
	},
	{
		// West Main Street
		confidence: 0.88,
		scheme: [
			{
				is: ["directional"],
				not: ["street", "intersection", "end_token_single_character"],
			},
			{
				is: ["street"],
				not: ["directional"],
			},
		],
	},
]

export class CompositeStreetClassifier extends CompositeClassifier {
	constructor() {
		super("street", configs)
	}
}
