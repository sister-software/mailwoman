/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassifierSchemeConfig, CompositeClassifier } from "@mailwoman/core"

const configs: ClassifierSchemeConfig[] = [
	{
		// University Hospital
		confidence: 0.9,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street"],
			},
			{
				is: ["place", "venue"],
				not: ["street"],
			},
		],
	},

	{
		// +++ Park
		confidence: 0.7,
		scheme: [
			{
				is: ["alpha"],
				not: ["street", "intersection", "stop_word"],
			},
			{
				is: ["place", "venue"],
				not: ["street"],
			},
		],
	},

	{
		// Mt +++ Park
		confidence: 0.8,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street"],
			},
			{
				is: ["place", "venue"],
				not: [],
			},
		],
	},

	{
		// Air & Space Museum
		confidence: 0.8,
		scheme: [
			{
				is: ["alpha"],
				not: ["street", "intersection", "stop_word"],
			},
			{
				is: ["stop_word"],
				not: ["street"],
			},
			{
				is: ["place", "venue"],
				not: [],
			},
		],
	},

	{
		// National Air & Space Museum
		confidence: 0.8,
		scheme: [
			{
				is: ["alpha"],
				not: ["street", "intersection", "stop_word"],
			},
			{
				is: ["place", "venue"],
				not: [],
			},
		],
	},

	{
		// Stop 10792
		confidence: 0.8,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street", "intersection", "stop_word"],
			},
			{
				is: ["numeric"],
				not: [],
			},
		],
	},

	{
		// University of Somewhere
		confidence: 0.8,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street"],
			},
			{
				is: ["stop_word"],
				not: ["street"],
			},
			{
				is: ["area"],
				not: ["street"],
			},
		],
	},

	{
		// Ecole Jules Vernes
		confidence: 0.8,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street"],
			},
			{
				is: ["person"],
				not: ["street"],
			},
		],
	},

	{
		// Donald W Reynolds Stadium
		// boost confidence slightly above street for "Donald W"
		confidence: 0.82,
		scheme: [
			{
				is: ["person"],
				not: ["street"],
			},
			{
				is: ["place", "venue"],
				not: ["street"],
			},
		],
	},

	{
		// ZAC du Pré
		confidence: 0.8,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street"],
			},
			{
				is: ["street_name"],
				not: ["street"],
			},
		],
	},

	{
		// ZAC de la Tuilerie
		confidence: 0.8,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street"],
			},
			{
				is: ["stop_word"],
				not: ["street"],
			},
			{
				is: ["street_name"],
				not: ["street"],
			},
		],
	},

	{
		// ZA Entraigues
		confidence: 0.7,
		scheme: [
			{
				is: ["place", "venue"],
				not: ["street"],
			},
			{
				is: ["alpha"],
				not: ["street"],
			},
		],
	},

	// {
	// 	// 'BUFFALO FAMILY HEALTH CLINIC
	// 	confidence: 1,
	// 	scheme: [
	// 		{
	// 			is: ["alpha", "start_token", "locality"],
	// 			not: ["unit", "numeric", "street", "intersection", "stop_word"],
	// 		},
	// 		{
	// 			is: ["alpha"],
	// 			not: ["numeric", "street", "intersection", "stop_word"],
	// 		},
	// 		{
	// 			is: ["alpha", "place"],
	// 			not: ["locality", "region", "country"],
	// 		},
	// 	],
	// },
]

export class CompositeVenueClassifier extends CompositeClassifier {
	constructor() {
		super("venue", configs)
	}
}
