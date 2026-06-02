# Going multi-locale starts with finding out what's actually broken (2026-06-02)

You have a parser trained on US and French addresses, and you want it to read German ones. The
tempting move is to grab a pile of German data and retrain. Don't. Not yet. First find out what's
actually broken, because "it doesn't work on German" hides at least three different failures, and
two of them aren't the parser's fault at all.

This is the write-up of that finding-out, done as a night-shift before committing a single GPU-hour.

## The resolver was never the problem

The first thing that looked like a catastrophe turned out to be a measurement bug. Run a German
address through the end-to-end resolver and it lands in _North America_: `Berlin` resolves to a
20,000-person Berlin in Connecticut instead of the 3.6-million-person one in Germany, a great-circle
error of about 5,940 km.

That looks like the resolver being hopelessly US-centric, and for about ten minutes I believed it.
Then I found the eval harness hardcoded `defaultCountry: "US"`, which the lookup applies as a _hard
filter_, so every German address was restricted to US places before ranking ever ran. German Berlin was never even a candidate. Fix the
one string and the same resolver, against the same global gazetteer, puts German Berlin first on
population alone: coordinate error collapses from 5,940 km to **10 km**. The ranking was fine the
whole time. (The full autopsy is in the resolver-vs-eval-artifact notes; the short version is: when
a finding feels like a crisis, check whether you're holding the instrument upside down.)

So the resolver and the gazetteer already handle German. The gap is narrower than it looked, and it
lives in the parser.

## What the parser actually gets wrong, and why

Here is the neural parser on real German addresses, next to the rule-based `v0`:

| input                               | neural                 | the bug                                 |
| ----------------------------------- | ---------------------- | --------------------------------------- |
| `Straußstraße 27`                   | street=`Strau`         | truncated at the ß                      |
| `Hauptstraße 5`                     | street=`Hauptstraße 5` | house number swallowed into the street  |
| `Prenzlauer Allee 36, 10405 Berlin` | postcode=`36`          | the house number tagged as the postcode |

None of these are random. They are all one thing: **order**. The model learned addresses where the
house number comes _first_ (`350 5th Ave`) and the postcode comes _after_ the city (`New York, NY
10118`). German runs the other way: house number _after_ the street (`Hauptstraße 5`), postcode
_before_ the city (`10405 Berlin`). Shown a German address, the model keeps applying the American
grammar, and the tags land in the wrong slots. The `36` looks like a postcode because in the
positions the model trusts, that's where a number like it would sit.

That's a coverage gap. But before spending money closing it, there's a cheaper thing it _could_ have
been, and you have to rule it out.

## The gate: is the tokenizer the wall?

`Straußstraße → Strau` is suspicious. The span dies exactly at the `ß`. If the tokenizer can't
represent German orthography, if `ß` and the long compound street names fall apart into pieces the
model can't reassemble, then no amount of training data will help, and the right move is a
tokenizer change, which is a much bigger, more expensive decision.

So that's the gate, and it's an afternoon's work, not a GPU run. Feed the v0.6.0-a0 SentencePiece
tokenizer a batch of German streets and check the round-trip:

```
Straußstraße  →  "▁Strau" "ß" "straße"   →  "Straußstraße"   (lossless)
Karl-Liebknecht-Straße, München, Köln, Düsseldorf, Schöneberg  →  all lossless (10/10)
```

The tokenizer is fine. `ß` gets its own clean piece, sitting right next to its street stem. So the
`Strau` truncation is the model's own doing: out of distribution, it takes that piece boundary as a
convenient exit and ends the street span early. That's exactly the kind of mistake more training
data fixes.

Gate passed. The wall is coverage, and coverage is cheap.

## Teaching the order

The fix is a small supplement shard that shows the model German order, and the trick is to not
synthesize German street names, because German morphology is hard to fake and you'll teach the model
your own mistakes. Instead, take _real_ OpenAddresses tuples (Berlin and Saxony, 1.2 million of them) and
re-render each one in idiomatic German order. The rendering is free: the OpenCage `DE` template
already knows the convention.

```
{street: "Straußstraße", house_number: "27", postcode: "12623", locality: "Berlin"}
   → "Straußstraße 27, 12623 Berlin"
```

The aligner turns that into exactly the BIO signal the model is missing: house number _after_ the
street, postcode _before_ the city:

```
Straußstraße/B-street  27/B-house_number  12623/B-postcode  Berlin/B-locality
```

Five thousand of those, weighted at 0.2 (a supplement, not a flood), continue-trained on top of
v0.7.2. One variable changed against the previous recipe.

## The baseline, and an honest stopping point

Here's the "before," measured on a held-out German set the model has never seen:

| tag          | v0.7.2 (out of distribution) |
| ------------ | ---------------------------- |
| street       | **19.1%**                    |
| house_number | **14.6%**                    |
| locality     | 72.5%                        |
| postcode     | 89.0%                        |

street and house_number are the floor, the two tags that depend on order. locality and postcode are
already decent, because a city name and a five-digit number are recognizable wherever they sit. The
shard targets the floor.

The retrain itself is staged but not run as of this writing. Launching it mutates the shared
training corpus manifest, the kind of irreversible, shared-state change that deserves a human's yes
rather than an autonomous one. Everything is one approval away: the shard is built and
uploaded, the config is committed, the before/after harness is wired. When it runs, the test is
simple and pre-registered: street and house_number should climb, US and French should not move more
than a point (the interference tripwire), and the German resolver coordinate error should hold.

If German costs US accuracy, the shard comes back out. That's the whole discipline: you don't get to
_hope_ a locale is free, you measure whether it was.
