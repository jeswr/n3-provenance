# @jeswr/n3-provenance

Lexical provenance for N3.js as a separate ES module package. Adapted from
[rdfjs/N3.js#731](https://github.com/rdfjs/N3.js/pull/731) and
[jeswr/N3.js#20](https://github.com/jeswr/N3.js/pull/20), it tracks the source range
of each quad's subject, predicate, object, and graph while preserving duplicate
occurrences. It uses the public `Parser.parse` callbacks `onToken` and
`onTokenEnd` proposed in #731.

The callbacks replace the old private `_readToken` override. They are public
observation points, **not a complete public grammar-extension API**. This package
still subclasses private entity, literal, context, factory, and quad-emission
methods to associate RDF terms with individual lexical occurrences. Its index
adapter also uses N3 EntityIndex internals. This experimental package pins its N3
dependency to Git revision `a89bd27` until #731 is merged and released. Run
the integration tests when updating that pin.

## Try it

The package is not yet published to npm. Install it from GitHub:

```sh
npm install github:jeswr/n3-provenance
```

For development, use Node.js 22.18+ or 24.11+ (the pinned N3 Git dependency runs
its Babel build during installation):

```sh
git clone https://github.com/jeswr/n3-provenance.git
cd n3-provenance
npm ci
npm test
npm run lint
npm run demo
```

```js
import ProvenanceParser from '@jeswr/n3-provenance';
import { Store } from 'n3';

const source = '<s> <p> "text"@en .\n<s> <p> "text"@en .';
const { quads, provenance, prefixes } = new ProvenanceParser({
  baseIRI: 'https://example.org/',
  onQuad(quad, occurrence) {
    // Optional: complete public occurrence ranges, in parse order.
  },
}).parse(source);

const store = new Store(quads);
const rebuiltQuad = store.getQuads(null, null, null, null)[0];
console.log(provenance.get(rebuiltQuad)); // Two occurrences of this RDF quad.
```

`ProvenanceParser.parse` takes a string and returns `{ quads, provenance,
prefixes }`. Each occurrence is `{ subject, predicate, object, graph }`. A
component is either `null` (no lexical spelling) or:

```js
{
  start: { line: 1, column: 0 },
  end: { line: 1, column: 3 },
}
```

Lines are one-based and columns count zero-based UTF-16 code units. Ends are
exclusive. CRLF is one line break; CR and LF also break lines. Ranges refer to
original source spellings, including escape sequences. Literals include their
language, direction, or datatype suffix; compounds include their closing token.

## What is tracked

- Each repeated quad remains a distinct occurrence. The index groups by RDF
  value, so lookup works after a Store reconstructs the quad or deduplicates it.
- Subject/predicate abbreviations reuse the corresponding lexical ranges.
- IRIs, prefixed names, blank-node labels, literals, variables, predicate
  abbreviations, graphs, `()`, nonempty lists, property lists, formulas, and
  triple terms carry ranges.
- Parser-generated terms, such as list-tail nodes, `rdf:first`/`rdf:rest`
  predicates, and reification scaffolding, carry `null` ranges.
- N3 inverse predicates attach source ranges to the resulting quad positions.
- Frozen and interning RDF/JS factories work: source metadata is held in temporary
  occurrence wrappers rather than written onto emitted RDF/JS terms.

`ProvenanceIndex.get(quad)` returns fresh occurrence objects. `add(quad,
occurrence)` copies public range data. Iteration yields `[quad, occurrences]`
pairs. Internally, an occurrence uses 16 numeric values (four coordinates for
each component); zero line numbers encode `null`. Open compound ranges remain
pending until parsing finishes. The exported `EntityIndex` can also be shared
with `new Store({ entityIndex })`.

The package exports `ProvenanceParser` (also the default export),
`ProvenanceIndex`, `TermLocationParser`, and the provenance `EntityIndex` adapter.
The last two expose lower-level integration points with N3's private internals.

## Token lifecycle and streaming

`TermLocationParser` uses `onToken` to set the current token and extend pending
literal ranges. `onTokenEnd` clears temporary literal construction state and
records the new literal's range after the grammar has consumed the token. This
ordering handles adjacent N3 literals, where one token can both finish the
previous literal and start another.

The location parser inherits synchronous, callback, and stream input modes. Its
constructor's internal `onQuad(quad, quadId, subject, predicate, object, graph)`
receives compact, possibly still-open ranges; the facade adds indexing and
complete public occurrence notifications. The string-only facade creates a new
location parser per call, avoiding state leakage between documents. It is not
a streaming provenance facade.

A lexer error in synchronous parsing occurs before any provenance events. A
later grammar error leaves already emitted `onQuad` events intact; events waiting
for an unclosed compound are not emitted. Consumer exceptions abort immediately.
Ranges on a custom lexer's tokens are validated before provenance processing.
EOF and enabled comments are observable through the public token callbacks;
comments do not disturb pending literal provenance.

## Validation

`test/ProvenanceParser-test.js` retains the complete 112-test provenance suite,
including value-based lookup, duplicate occurrences, immutable factories,
compound ranges, literal suffixes, current N3 inverse behavior, error delivery,
and stream chunk boundaries. The suite passes with 100% statement, branch,
function, and line coverage.

The core N3 callback contract is tested separately in #731. Source files run
directly as ES modules; no Babel registration or build step is needed for this
package. `npm pack` includes `src`, this README, and the MIT license.

## License

MIT. The extracted implementation retains the N3.js contributors' copyright;
see [LICENSE.md](./LICENSE.md).
