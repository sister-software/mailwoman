/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassifierSchemeConfig, CompositeClassifier } from "@mailwoman/core"

const configs: ClassifierSchemeConfig[] = [
	{
		// Anne Marie
		classification: "given_name",
		confidence: 0.25,
		scheme: [
			{
				is: ["given_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["given_name"],
				not: ["street", "street_prefix", "stop_word"],
			},
		],
	},
	{
		// Georges Bizet
		confidence: 0.5,
		scheme: [
			{
				is: ["given_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["surname"],
				not: ["street", "street_prefix", "stop_word"],
			},
		],
	},
	{
		// Rose de Lima
		confidence: 0.5,
		scheme: [
			{
				is: ["given_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["stop_word"],
				not: ["street", "intersection"],
			},
			{
				is: ["surname"],
				not: ["street", "street_prefix", "stop_word"],
			},
		],
	},
	{
		// Raul Leite Magalhães (first name, middle name, family name)
		// Donald W. Reynolds
		confidence: 0.5,
		scheme: [
			{
				is: ["given_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["given_name", "surname", "middle_initial"],
				not: ["street", "intersection"],
			},
			{
				is: ["surname"],
				not: ["street", "street_prefix", "stop_word"],
			},
		],
	},
	{
		// Unknown surname
		confidence: 0.1,
		scheme: [
			{
				is: ["given_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha"],
				not: ["street", "street_prefix", "stop_word"],
			},
		],
	},
	{
		// Unknown surname
		confidence: 0.1,
		scheme: [
			{
				is: ["given_name"],
				not: ["street", "intersection"],
			},
			{
				is: ["stop_word"],
				not: ["street", "intersection"],
			},
			{
				is: ["alpha"],
				not: ["street", "street_prefix", "stop_word"],
			},
		],
	},
]

export class CompositePersonClassifier extends CompositeClassifier {
	constructor() {
		super("person", configs)
	}
}
