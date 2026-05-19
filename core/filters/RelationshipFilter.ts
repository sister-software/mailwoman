/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type FilterRelation,
	type FilterRelationRule,
	Solution,
	type Solver,
	type SolverContext,
	Span,
} from "@mailwoman/core"

export class RelationshipFilter implements Solver {
	constructor(protected rules: FilterRelationRule[]) {}

	protected applyRelation(relation: FilterRelation, solutions: readonly Solution[]): Solution[] {
		return solutions.filter((solution) => {
			let predicate: undefined | ((subject: Span) => boolean)
			const matchedSubjects: Span[] = []

			for (const { span, classification } of solution.matches) {
				if (!predicate && classification === relation.object) {
					predicate =
						relation.direction === "precedes"
							? (subject) => subject.start > span.start
							: (subject) => subject.start < span.start
				}

				if (classification === relation.subject) {
					matchedSubjects.push(span)
				}
			}

			if (!predicate || matchedSubjects.length === 0) return true

			// Solution contains both object & subject classifications.

			if (!matchedSubjects.some(predicate)) return true

			// Remove the object classification from this solution.
			solution.matches = solution.matches.filter((p) => p.classification !== relation.object)

			// new Solution()
			return solution.matches.length > 0
		})
	}

	protected applyMustNotFollow(relation: FilterRelation, solutions: readonly Solution[]): Solution[] {
		return solutions.filter((solution) => {
			const [matchedObject] = solution.filter(relation.object)
			const matchedSubjects = solution.filter(relation.subject)

			if (!matchedObject || matchedSubjects.length === 0) return true
			// Solution contains both object & subject classifications.
			// Does the object comes before the subject(s)?
			if (!matchedSubjects.some((p) => p.span.start < matchedObject.span.end)) return true

			// Remove the object classification from this solution.
			solution.matches = solution.matches.filter((p) => p.classification !== relation.object)

			return solution.matches.length > 0
		})
	}

	public solve(context: SolverContext): void {
		for (const [object, direction, subject] of this.rules) {
			const relation: FilterRelation = {
				object,
				direction,
				subject,
			}

			context.solutions = this.applyRelation(relation, context.solutions)
		}
	}
}
