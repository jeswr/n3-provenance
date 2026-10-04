// **N3ProvenanceParser** parses a document and indexes each quad utterance by
// the locations emitted by N3TermLocationParser.
import type * as RDF from '@rdfjs/types';
import N3TermLocationParser from './TermLocationParser.js';
import N3EntityIndex from './EntityIndex.js';
import { ProvenanceIndex, materializeOccurrence } from './ProvenanceIndex.js';
import type { Occurrence, ParserRange } from './ProvenanceIndex.js';
import type { N3ParserOptions } from './n3-internals.js';

export { ProvenanceIndex };

export type QuadCallback = (quad: RDF.Quad, occurrence: Occurrence) => void;

export interface ProvenanceParserOptions extends N3ParserOptions {
  // Index to intern terms and quads in; defaults to a new one per parse.
  entityIndex?: N3EntityIndex;
  // Called with each quad and its complete occurrence ranges, in parse order.
  onQuad?: QuadCallback;
}

export interface ProvenanceParseResult {
  quads: RDF.Quad[];
  provenance: ProvenanceIndex;
  prefixes: Record<string, string>;
}

type EmittedQuad = [RDF.Quad, ParserRange, ParserRange, ParserRange, ParserRange];

function isComplete(event: EmittedQuad): boolean {
  for (let i = 1; i < event.length; i++) {
    const range = event[i];
    if (Array.isArray(range) && !range[4])
      return false;
  }
  return true;
}

export default class N3ProvenanceParser {
  private _options: ProvenanceParserOptions;

  constructor(options: ProvenanceParserOptions = {}) { this._options = options || {}; }

  parse(input: string): ProvenanceParseResult {
    if (typeof input !== 'string')
      throw new TypeError('ProvenanceParser.parse only accepts a string');

    const { entityIndex: suppliedEntityIndex, onQuad, ...parserOptions } = this._options,
        entityIndex = suppliedEntityIndex || new N3EntityIndex({ factory: parserOptions.factory }),
        provenance = new ProvenanceIndex(entityIndex),
        emitted: EmittedQuad[] | undefined = onQuad && [];
    let nextEmission = 0, callbackFailed = false;
    function flushEvents(): void {
      while (emitted && nextEmission < emitted.length && isComplete(emitted[nextEmission])) {
        const event = emitted[nextEmission++];
        try {
          onQuad!(event[0], materializeOccurrence(event[1], event[2], event[3], event[4]));
        }
        catch (error) {
          callbackFailed = true;
          throw error;
        }
      }
      if (emitted && nextEmission === emitted.length)
        emitted.length = nextEmission = 0;
    }
    const parser = new N3TermLocationParser({
      ...parserOptions,
      entityIndex,
      onQuad: (quad, quadId, subject, predicate, object, graph) => {
        provenance._add(quadId, subject, predicate, object, graph);
        if (emitted) {
          emitted.push([quad, subject, predicate, object, graph]);
          flushEvents();
        }
      },
    });
    let quads: RDF.Quad[];
    try {
      quads = parser.parse(input);
    }
    catch (error) {
      if (!callbackFailed)
        flushEvents();
      throw error;
    }
    provenance._finalizeAll();
    flushEvents();
    return { quads, provenance, prefixes: parser.prefixes };
  }
}
