/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type ClassifierSchemeConfig, CompositeClassifier } from "@mailwoman/core"

const configs: ClassifierSchemeConfig[] = [
	{
		// dos Fiéis
		confidence: 0.5,
		scheme: [
			{
				is: ["stop_word"],
				not: ["directional", "intersection"],
			},
			{
				is: ["alpha", "person"],
				not: ["street", "intersection", "street_suffix"],
			},
		],
	},
	{
		// Academia das Ciências
		confidence: 0.5,
		scheme: [
			{
				is: ["alpha"],
				not: ["street", "intersection", "stop_word", "street_prefix"],
			},
			{
				is: ["stop_word"],
				not: ["directional"],
			},
			{
				is: ["alpha", "person"],
				not: ["street", "intersection", "street_suffix"],
			},
		],
	},
	{
		// du 4 septembre
		confidence: 0.5,
		scheme: [
			{
				is: ["stop_word"],
				not: ["intersection"],
			},
			{
				is: ["numeric"],
				not: ["postcode"],
			},
			{
				is: ["alpha"],
				not: ["street", "intersection", "locality"],
			},
		],
	},
	{
		// dos Fiéis de Deus
		confidence: 0.5,
		scheme: [
			{
				is: ["street_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["street_name"],
				not: ["street", "intersection"],
			},
		],
	},
]

export class CompositeStreetNameClassifier extends CompositeClassifier {
	constructor() {
		super("street_name", configs)
	}
}
