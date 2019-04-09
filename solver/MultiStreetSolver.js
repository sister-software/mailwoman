const HashMapSolver = require('./super/HashMapSolver')

class MultiStreetSolver extends HashMapSolver {
  solve (tokenizer) {
    let map = this.generateHashMap(tokenizer, true)

    // sanity checking
    if (!map.hasOwnProperty('multistreet')) { return }
    if (!map.hasOwnProperty('street') || map.street.length < 2) { return }

    let multi = map.multistreet.pair[0]
    let candidates = map.street.copy()

    // add the second street to existing solutions
    for (let s = 0; s < tokenizer.solution.length; s++) {
      let sol = tokenizer.solution[s].copy() // make a copy

      // remove any pairs which are more granular than street (not applicable for intersections)
      sol.pair = sol.pair.filter(p => p.classification.constructor.name !== 'HouseNumberClassification')

      let success = false

      for (let i = 0; i < candidates.pair.length; i++) {
        let s = candidates.pair[i]
        if ((
          s.span.intersects(multi.span) &&
          !sol.pair.some(sp => sp.span.intersects(s.span))
        )) {
          sol.pair.push(s)
          success = true
          break
        }
      }
      if (success) {
        sol.computeScore(tokenizer)
        tokenizer.solution.push(sol)
        candidates.pair = candidates.pair.filter(c => c === sol[sol.length - 1])
      }
    }

    // sort results by score desc
    tokenizer.solution.sort((a, b) => b.score - a.score)

    // sort by span start
    tokenizer.solution.forEach(s => s.pair.sort((a, b) => a.span.start - b.span.start))
  }
}

module.exports = MultiStreetSolver
