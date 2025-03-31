# Mailwoman

A natural language classification engine for geocoding.

![GitHub License](https://img.shields.io/github/license/sister-software/mailwoman)
![GitHub commit activity](https://img.shields.io/github/commit-activity/m/sister-software/mailwoman)

```js
// npx mailwoman debug "Mt Tabor Park, 6220 SE Salmon St, Portland, OR 97215, USA"

;[
	{ venue: "Mt Tabor Park", confidence: 0.8, offset: 0, penalty: 0 },
	{ house_number: "6220", confidence: 0.9, offset: 15, penalty: 0 },
	{ street: "SE Salmon St", confidence: 0.98, offset: 20, penalty: 0 },
	{ locality: "Portland", confidence: 1, offset: 34, penalty: 0 },
	{ region: "OR", confidence: 1, offset: 44, penalty: 0 },
	{ postcode: "97215", confidence: 1, offset: 47, penalty: 0 },
	{ country: "USA", confidence: 0.9, offset: 54, penalty: 0 },
]
```

## Quick Start

A quick and easy way to get started with the library is to use the command-line interface:

```
npx mailwoman parse "West 26th Street, New York, NYC, 10010"
```

# Architecture Description

## Tokenization

Tokenization is the process of splitting text into individual words.

The splitting process used by the engine maintains token positions, so it's able to 'remember' where each character was in the original input text.

> Tokenization is coloured `blue` on the command-line.

### Span

The most primitive element is called a `span`, this is essentially just a single string of text with some metadata attached.

The terms `word`, `phrase` and `section` (explained below) are all just ways of using a `span`.

### Section Boundaries

Some parsers like [libpostal](https://github.com/openvenues/libpostal) ignore characters such as `comma`, `tab`, `newline` and `quote`.

While it's unrealistic to expect commas always being present, it's very useful to record their positions when they are.

These boundary positions help to avoid parsing errors for queries such as `Main St, East Village` being parsed as `Main St East` in `Village`.

Once sections are established there is no 'bleeding' of information between sections, avoiding the issue above.

### Word Splitting

Each section is then split in to individual `words`, by default this simply considers whitespace as a word boundary.

As per the `section`, the original token positions are maintained.

### Phrase Generation

May terms such as 'New York City' span multiple words, these multi-word tokens are called `phrases`.

In order to be able to classify `phrase` terms, permutations of adjacent words are generated.

Phrase generation is performed per-section, so it will not generate a `phrase` which contains words from more than one `section`.

Phrase generation is controlled by a configuration which specifies things like the minimum & maximum amount of words allowed in a `phrase`.

### Token Graph

A graph is used to associate `word`, `phrase` and `section` elements to each other.

The graph is free-form, so it's easy to add a new relationship between terms in the future, as required.

Graph Example:

```js
// Find the next word in this section
word.next

// Find all words in this phrase
phrase.children
```

## Classification

Classification is the process of establishing that a `word` or `phrase` represents a 'concept' (such as a street name).

Classification can be based on:

- Dictionary matching (usually with normalization applied)
- Pattern matching (such as regular expressions)
- Composite matching (such as relative positioning)
- External API calls (such as calling other services)
- Other semantic matching techniques

> Classification is coloured `green` and `red` on the command-line.

### Classifier Types

The library comes with three generic classifiers which can be extended in order to create a new `classifier`:

- WordClassifier
- PhraseClassifier
- SectionClassifier

### Classifiers

The library comes bundled with a range of classifiers out-of-the box.

You can find them in the `/classifier` directory, dictionary-based classifiers usually store their data in the `/resources` directory.

Example of some of the included classifiers:

- Word Classifiers
  - `house_number`
  - `postcode`
  - `street_prefix`
  - `street_suffix`
  - `compound_street`
  - `directional`
  - `ordinal`
  - `stop_word`
- Phrase Classifiers
  - `intersection`
  - `person`
  - `given_name`
  - `surname`
  - `personal_suffix`
  - `personal_title`
  - `chain`
  - `place`
  - `whos_on_first`

## Solvers

Solving is the final process, where `solutions` are generated based on all the classifications that have been made.

Each parse can contain multiple `solutions`, each is provided with a `confidence` score and is displayed sorted from highest scoring solution to lowest scoring.

The core of this process is the `ExclusiveCartesianSolver` module.

This `solver` generates all the possible permutations of the different classifications while taking care to:

- ensure the same `span` position is not used more than once
- ensure that the same `classification` is not used more than once.

After the `ExclusiveCartesianSolver` has run there are additional solvers which can:

- filter the `solutions` to remove inconsistencies
- add new `solutions` to provide additional functionality (such as intersections)

### Solution Masks

It is possible to produce a simple `mask` for any generated solution, this is useful for comparing the `solution` to the original text:

```
VVV VVVV NN SSSSSSS AAAAAA PPPPP
Foo Cafe 10 Main St London 10010 Earth
```

# Contributing

Please fork and pull request against upstream master on a feature branch. Pretty please; provide unit tests.

## Unit tests

You can run the unit test suite using the command:

```sh
$ npm test
```

# License

Mailwoman is distributed under the AGPL-3.0 license. Generally,
this means that you can use the software for free, but you must share
any modifications you make to the software.

Unmodified portions of Mailwoman derived from Pelias Parser remain under the
MIT license.

For more information on commercial usage licensing, please contact us at
`hello@sister.software`

# Acknowledgements

This project was made possible by contributions of the Pelias community.
