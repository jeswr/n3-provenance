// Type tests for the public API; `npm run lint` type-checks this file.
import { Readable } from 'node:stream';
import type * as RDF from '@rdfjs/types';
import ProvenanceParser, { TermLocationParser } from '../../src/index.js';
import type { Occurrence, ProvenanceParseResult } from '../../src/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function expectType<T extends true>(): void {}

const parser = new TermLocationParser();

// Without a quad callback, parsing a string returns its quads.
const quads = parser.parse('<s> <p> <o> .');
expectType<Equal<typeof quads, RDF.Quad[]>>();

// With a quad callback, parsing returns nothing. The callback receives no quad
// on completion or error.
const fromCallback = parser.parse('<s> <p> <o> .', (error, quad, prefixes) => {
  expectType<Equal<typeof error, Error | null>>();
  expectType<Equal<typeof quad, RDF.Quad | null | undefined>>();
  expectType<Equal<typeof prefixes, Record<string, string> | undefined>>();
});
expectType<Equal<typeof fromCallback, void>>();

// Streams are accepted together with a quad callback.
const fromStream = parser.parse(Readable.from(['<s> <p> <o> .']), {
  onQuad(error, quad) {
    // @ts-expect-error the quad is absent on completion and on error
    void quad.subject;
  },
  onPrefix(prefix, iri) {
    expectType<Equal<typeof iri, RDF.NamedNode>>();
  },
});
expectType<Equal<typeof fromStream, void>>();

// Callbacks that only observe a string parse leave it synchronous.
const observed = parser.parse('<s> <p> <o> .', {
  onToken() {},
  onPrefix() {},
  onDirective(name) {
    expectType<Equal<typeof name, string>>();
  },
});
expectType<Equal<typeof observed, RDF.Quad[]>>();
const withNullQuadCallback = parser.parse('<s> <p> <o> .', { onQuad: null });
expectType<Equal<typeof withNullQuadCallback, RDF.Quad[]>>();

// @ts-expect-error streams cannot be parsed synchronously
parser.parse(Readable.from(['<s> <p> <o> .']));
// @ts-expect-error streams need a quad callback
parser.parse(Readable.from(['<s> <p> <o> .']), {});
// @ts-expect-error streams need a quad callback, not only observers
parser.parse(Readable.from(['<s> <p> <o> .']), { onToken() {} });

// ProvenanceParser parses strings synchronously.
const result = new ProvenanceParser({
  baseIRI: 'https://example.org/',
  onQuad(quad, occurrence) {
    expectType<Equal<typeof quad, RDF.Quad>>();
    expectType<Equal<typeof occurrence, Occurrence>>();
  },
}).parse('<s> <p> <o> .');
expectType<Equal<typeof result, ProvenanceParseResult>>();
expectType<Equal<ReturnType<typeof result.provenance.get>, Occurrence[]>>();
// @ts-expect-error ProvenanceParser only parses strings
new ProvenanceParser().parse(Readable.from(['<s> <p> <o> .']));
