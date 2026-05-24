---
sidebar_position: 36
title: Human-in-the-loop geocoding
tags:
  - domain
  - hubris
  - locality
  - venue
  - international
---

# Human-in-the-loop geocoding

Don't parse. Don't resolve. Don't guess. Show the user what you think they meant and let them confirm. The parser is a suggestion engine, not an authority. The user is the ground truth.

## The approach

1. **Accept free-text input.** A single text field. No separate boxes for street, city, state, and ZIP. The user types whatever they have: `350 5th Ave, NYC`, `Empire State Building`, `90210`, `my house`.
2. **Run a fuzzy geocoder on the input.** Postcode extraction, gazetteer lookup, normalize-to-match against a known database — whatever combination of simple approaches works for your address universe. The geocoder returns candidates, not a single answer.
3. **Show the user the candidates.** A dropdown or map with the top 3-5 matches. "Did you mean: 350 5th Ave, New York, NY 10118 (Empire State Building)?" The user picks.
4. **The user's selection is canonical.** The selected address is stored as the canonical form for that user. Future inputs from the same user can match against their saved addresses without re-guessing.

This is how Google Maps, Apple Maps, and every ride-sharing app work. The user types a few characters, the system suggests completions, the user taps one. The system never has to parse a free-text address with high confidence — it only has to suggest plausible completions from a known universe.

## When it works

- **Interactive applications.** A checkout form, a delivery address entry, a search box. The user is present and can confirm. The cost of a wrong guess is a bad suggestion, not a misdelivered package.
- **You have an autocomplete index.** A database of known addresses (Google's Places API, your own customer database, a gazetteer). The system suggests from the index, not from free-text parsing.
- **Your user base is typing their own addresses.** They know where they live. They will recognize the correct suggestion when they see it. The system doesn't need to be right — it needs to be close enough that the right answer is in the top 5.
- **You serve ambiguous addresses.** `Springfield` — the system suggests the top 3 Springfields by proximity to the user's IP or previous addresses. The user picks the right one. No AI needed.
- **You are building a product, not infrastructure.** The geocoding is a UX feature, not a backend pipeline. The user's selection is the output. The system doesn't need to geocode in batch without human oversight.

## What you lose

- **Batch processing.** You cannot show suggestions to a million addresses in a CSV file. Human-in-the-loop requires a human. Batch geocoding requires a parser that works without one.
- **Automation.** Every address that needs human confirmation is a step in a workflow that could have been automatic. If 95% of addresses are unambiguous and 5% need confirmation, the 5% drives your support costs.
- **The user's patience.** `Springfield, IL` has one obvious candidate. Showing a dropdown of 34 Springfields is noise. The system should recognize when there's a single high-confidence match and skip the confirmation. Knowing when to skip requires a confidence signal — which requires a parser.
- **The user who doesn't know their address.** A gift recipient, a new mover, a tourist. The user types what they think the address is. It might be wrong. The system shows candidates. The user picks the one that looks right. It's wrong. There is no ground truth in the loop — only two layers of guesses.
- **Addresses not in the autocomplete index.** The user types a new construction address that isn't in any database. The autocomplete returns nothing. The user cannot proceed. The system needs a fallback — free-text parsing — for addresses outside the index.

## Where Mailwoman fits

Mailwoman is the **backend for the autocomplete index.** The parser extracts structured components from free-text input. The resolver returns candidates with confidence scores. The autocomplete UI shows the top candidates. The user confirms.

Mailwoman does not replace the human-in-the-loop. It feeds it. The parser tells the UI: "I'm 95% sure this is 350 5th Ave, New York, NY 10118, and 4% sure it's 350 5th Ave, Brooklyn, NY 11215." The UI shows one suggestion (high confidence) or two (ambiguity). The user either confirms or corrects. The correction feeds back into the training corpus.

This is the architecture behind the Phase 5 Studio: a web UI where humans correct parses, corrections become training data, and the model improves. The human-in-the-loop is not an alternative to the parser. It is how the parser gets better.

## See also

- [Normalize to match](./simple-normalize-to-match.md) — the backend for the autocomplete index
- [Gazetteer-first geocoding](./simple-gazetteer-first.md) — another suggestion-engine approach
- [How humans break addresses](./how-humans-break-addresses.md) — the failure modes the human corrects
- [How it will work](./how-it-will-work.md) — Phase 5 Studio, the human-correction feedback loop
