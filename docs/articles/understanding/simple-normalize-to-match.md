---
sidebar_position: 31
title: Normalize to match
tags:
  - domain
  - hubris
  - rule-based
  - en-us
---

# Normalize to match

The simplest geocoder doesn't parse addresses at all. It normalizes them — strips punctuation, lowercases, expands abbreviations — and matches the result against a known database of addresses. The "parser" is a fuzzy string matcher. The "resolver" is a hash table lookup.

## The approach

You have a database of known addresses — your customers, your delivery points, your properties. Each entry has a canonical form: `123 Main St, Springfield, IL 62701`. When a user types `123 main street springfield illinois 62701`, you don't parse it. You normalize both strings to a common form and compare.

The normalization pipeline:

1. **Lowercase everything.** `Springfield` and `springfield` are the same.
2. **Strip punctuation.** `St.` and `St` are the same. `62701-1234` and `62701` are the same (if you only care about the 5-digit ZIP).
3. **Expand abbreviations.** `St` → `Street`, `IL` → `Illinois`, `Ave` → `Avenue`. This makes `123 Main St` match `123 Main Street`.
4. **Remove noise tokens.** Apartment numbers, "Attn:" lines, floor numbers — if your database doesn't have them, strip them from the input.
5. **Fuzzy match.** After normalization, compute edit distance or Jaccard similarity between the input and each candidate. Return the best match above a threshold.

This is not parsing. It is not understanding address structure. It is string normalization plus similarity matching. It works surprisingly well when your universe of possible addresses is bounded.

## When it works

- **You have a known address database.** A logistics company with 10,000 delivery points. A utility company with 500,000 service addresses. A retailer with a customer address book. The universe is finite and you control it.
- **Your input is messy but recognizable.** Customers typing their own addresses make spelling errors, use abbreviations, omit ZIP+4, add apartment numbers. Normalization absorbs these variations.
- **You don't need component-level output.** You don't need to know which token is the street and which is the city. You just need to know "this input matches address ID #4572."
- **Your addresses are in one country.** US addresses have a small set of standard abbreviations (USPS Pub 28 defines them all). Expanding `St` → `Street` and `IL` → `Illinois` covers the common cases. International addresses have no such standard abbreviation table.
- **You need to ship today.** Normalization is a hundred lines of code. No training data, no model, no gazetteer. Ship in an afternoon.

## What you lose

- **Any address not in your database.** A new customer, a new delivery point, a one-time destination — the normalizer can only match against known entries. If the address is not in the database, the normalizer returns nothing.
- **Ambiguity between similar addresses.** `123 Main St, Springfield, IL` and `123 Main St, Springfield, MA` normalize to nearly identical strings. If both are in your database, the fuzzy matcher picks the higher-similarity score — which may be the wrong one.
- **International addresses.** French `rue de la République` abbreviates nothing like US `Republic St`. UK postcodes (`SW1A 1AA`) don't normalize like US ZIP codes. The abbreviation table is per-country and grows without bound.
- **New construction.** A building built last month is not in your database. A customer who moved last week is at an address you don't have. The normalizer returns nothing for addresses that didn't exist when the database was built.
- **Structural errors.** `123 Main St, Springfield` and `123 Springfield St, Main` normalize to similar strings if "Main" and "Springfield" both appear in both strings. The fuzzy matcher doesn't know that the street and city are different fields — it just sees word overlap.
- **No confidence signal.** The fuzzy matcher returns a similarity score, not a confidence. A 0.85 similarity might mean "this is the right address with a typo" or "this is a different address in the same city." The downstream system cannot distinguish.

## Where Mailwoman fits

Normalize-to-match and Mailwoman's parser are complementary, not competing. A system that normalizes against a known database can use Mailwoman to **ingest new addresses** into that database:

1. A new customer signs up. Their address is not in the database.
2. Mailwoman parses `123 Main St, Springfield, IL 62701` into `{house_number: 123, street: Main St, locality: Springfield, region: IL, postcode: 62701}`.
3. The parsed components are normalized (`St` → `Street`, `IL` → `Illinois`) and stored as a canonical form.
4. Future inputs that normalize to the same canonical form match the existing entry.

The parser handles the cold-start problem — adding new addresses to the database. The normalizer handles the hot path — matching subsequent inputs against known entries. This is the architecture behind most address verification services (USPS AMS, SmartyStreets, Melissa Data): a parsing step to normalize the input, a matching step against a known database, and a confidence score for the match quality.

## See also

- [Postcode-only geocoding](./simple-postcode-only.md) — the simplest geographic approach
- [Regex-anchored fields](./simple-regex-fields.md) — when you care about a few specific components
- [The database fallacy](./the-database-fallacy.md) — why no database contains all addresses
- [How humans break addresses](./how-humans-break-addresses.md) — the failure modes normalization absorbs
