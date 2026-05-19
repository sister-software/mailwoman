/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type ClassifierSchemeConfig, CompositeClassifier } from "@mailwoman/core"

const configs: ClassifierSchemeConfig[] = [
	{
		// SW 6th & Pine
		scheme: [
			{
				is: ["directional"],
				not: ["intersection", "street_suffix"],
			},
			{
				is: ["alpha", "numeric", "ordinal"],
				not: ["intersection", "street_suffix"],
			},
			{
				is: ["intersection"],
				not: ["street", "street_suffix"],
			},
			{
				is: ["alpha", "numeric", "ordinal"],
				not: ["intersection"],
			},
		],
	},
	{
		// Foo St and Bar St
		scheme: [
			{
				is: ["alpha", "numeric", "ordinal"],
				not: ["intersection", "street_suffix"],
				confidence: 0.81,
				classification: "street",
			},
			{
				is: ["intersection"],
				not: ["street", "street_suffix"],
			},
			{
				is: ["alpha", "numeric", "ordinal"],
				not: ["intersection"],
				confidence: 0.82,
				classification: "street",
			},
		],
	},
	{
		// Foo and Bar St
		scheme: [
			{
				is: ["alpha"],
				not: ["intersection", "street", "street_suffix"],
				confidence: 0.53,
				classification: "street",
			},
			{
				is: ["intersection"],
				not: ["street", "street_suffix"],
			},
			{
				is: ["alpha", "numeric", "ordinal"],
				not: ["intersection"],
			},
		],
	},
	{
		// Foo St and Bar
		scheme: [
			{
				is: ["alpha", "numeric", "ordinal"],
				not: ["intersection"],
			},
			{
				is: ["intersection"],
				not: ["street", "street_suffix"],
			},
			{
				is: ["alpha", "numeric", "ordinal"],
				not: ["intersection", "street"],
				confidence: 0.56,
				classification: "street",
			},
		],
	},
	{
		// Foo and Bar
		scheme: [
			{
				is: ["alpha"],
				not: ["intersection", "street", "street_suffix"],
				confidence: 0.57,
				classification: "street",
			},
			{
				is: ["intersection"],
				not: ["street", "street_suffix"],
			},
			{
				is: ["alpha"],
				not: ["intersection", "street", "street_suffix"],
				confidence: 0.58,
				classification: "street",
			},
		],
	},
]

export class CompositeIntersectionClassifier extends CompositeClassifier {
	constructor() {
		super("multistreet", configs)
	}
}
