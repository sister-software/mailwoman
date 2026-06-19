# @mailwoman/classifiers

**Mailwoman rule-based classifiers** — a library of deterministic token classifiers
that assign `Classification` labels to address tokens using pattern matching,
dictionaries, and heuristics.

These are the v0 rules engine's individual classifiers, each responsible for one
grammatical category (house numbers, street suffixes, postcodes, place names, etc.).
They're composed into a `CompositeClassifier` that runs them in priority order.
The neural classifier (`@mailwoman/neural`) largely supersedes these for
production parsing, but they remain valuable for:

- **Bootstrapping and corpus labeling**
- **Fallback classification** for token types the model struggles with
- **Arbitration** — comparing rule output against neural output to detect regressions
- **Diagnostic tooling** — understanding _why_ a token was classified a certain way

```ts
import { CompositeClassifier } from "@mailwoman/classifiers"

const classifier = new CompositeClassifier()
const classification = classifier.classify(tokens)
// tokens[0].classification → { house_number: "1600" }
// tokens[1].classification → { street: "Amphitheatre" }
```

## Included classifiers

| Classifier                            | Detects                                            |
| ------------------------------------- | -------------------------------------------------- |
| `HouseNumberClassifier`               | Numeric house/building numbers                     |
| `PostcodeClassifier`                  | Postcode/ZIP patterns per locale                   |
| `RoadTypeClassifier`                  | Street suffixes (St, Ave, Rd, Blvd, etc.)          |
| `DirectionalClassifier`               | Cardinal directions (N, S, NE, Southwest, etc.)    |
| `PlaceClassifier`                     | Locality/region/country names (via WOF dictionary) |
| `IntersectionClassifier`              | Intersection connectors (&, at, and, @)            |
| `CompoundStreetClassifier`            | Multi-word street names                            |
| `CompoundUnitDesignatorClassifier`    | Unit designators (Apt, Ste, Unit, #, etc.)         |
| `OrdinalClassifier`                   | Ordinal numbers (1st, 2nd, 3rd floor)              |
| `LevelClassifier`                     | Floor/level numbers                                |
| `AlphaNumericClassifier`              | Alphanumeric identifiers                           |
| `StopWordClassifier`                  | Filler/stop words                                  |
| `PersonClassifier`                    | Person name components                             |
| `GivenNameClassifier`                 | Given/first names                                  |
| `MiddleInitialClassifier`             | Middle initials                                    |
| `PersonalTitleClassifier`             | Titles (Mr, Mrs, Dr, etc.)                         |
| `PersonalSuffixClassifier`            | Name suffixes (Jr, Sr, III, etc.)                  |
| `ChainClassifier`                     | Chain/business name patterns                       |
| `CentralEuropeanStreetNameClassifier` | Central European street name conventions           |
| `AdjacencyClassifier`                 | Adjacency-based disambiguation                     |

## API

```ts
// Compose all classifiers with default priority
import { CompositeClassifier } from "@mailwoman/classifiers"
const composite = new CompositeClassifier()

// Or pick specific classifiers
import { HouseNumberClassifier, PostcodeClassifier } from "@mailwoman/classifiers"

// Base class for custom classifiers
import { Classifier } from "@mailwoman/classifiers"

// Type adapter for pipeline integration
import { classifierAdapter } from "@mailwoman/classifiers"
```

## Related

- [`@mailwoman/core`](../core) — `Classification`, `ClassificationMap`, token types
- [`@mailwoman/neural`](../neural) — the neural classifier that replaces these for production use
- [`@mailwoman/codex`](../codex) — postal reference data consumed by several classifiers
- [Rule-Based Classifiers concepts](https://mailwoman.sister.software/articles/concepts/rule-based-classifiers/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
