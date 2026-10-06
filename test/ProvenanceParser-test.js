import { Lexer, Parser, Store, DataFactory } from 'n3';
import ProvenanceParser, { ProvenanceIndex, EntityIndex, TermLocationParser as N3TermLocationParser } from '../src/index.js';
import rdfDataModel from '@rdfjs/data-model';
import { isomorphic } from 'rdf-isomorphic';
import { EventEmitter } from 'node:events';
import { BASE_IRI, parse, texts, frozenInterningFactory } from './helpers.js';

describe('ProvenanceParser', () => {
  describe('utterance multiset semantics', () => {
    it('packs occurrence data directly for duplicate utterances', () => {
      const doc = '<s> <p> <o> .\n<s> <p> <o> .\n<s> <p> <o> .';
      const { quads, provenance } = parse(doc);
      expect(provenance.get(quads[0])).toHaveLength(3);
      const occurrences = Object.values(provenance._quadOccurrences)[0];
      expect(occurrences).toHaveLength(48);
      expect(occurrences.every(value => typeof value === 'number')).toBe(true);
    });
  });

  describe('value-keyed lookup', () => {
    it('allows occurrences to be added through the public API', () => {
      const provenance = new ProvenanceIndex();
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      const occurrence = { subject: [], predicate: [], object: [], graph: [] };
      provenance.add(quad, occurrence);
      expect(provenance.get(quad)).toEqual([occurrence]);
      provenance.add(quad, occurrence);
      expect(provenance.get(quad)).toHaveLength(2);
    });

    it('snapshots public additions and returns fresh occurrence values', () => {
      const provenance = new ProvenanceIndex();
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      const occurrence = {
        subject: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 3 } }],
        predicate: [],
        object: [],
        graph: [],
      };
      provenance.add(quad, occurrence);
      occurrence.subject[0].start.column = 99;
      occurrence.subject.push({ start: { line: 2, column: 0 }, end: { line: 2, column: 3 } });
      const first = provenance.get(quad);
      first[0].subject[0].start.column = 88;
      expect(provenance.get(quad)[0].subject)
        .toEqual([{ start: { line: 1, column: 0 }, end: { line: 1, column: 3 } }]);
    });

    it('does not retain partial data when a public occurrence is malformed', () => {
      const provenance = new ProvenanceIndex(), quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      expect(() => provenance.add(quad, {
        subject: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 3 } }],
      })).toThrow();
      expect([...provenance]).toEqual([]);

      const occurrence = { subject: [], predicate: [], object: [], graph: [] };
      provenance.add(quad, occurrence);
      expect(provenance.get(quad)).toEqual([occurrence]);
    });

    it('does not allocate an entity ID for an unknown lookup', () => {
      const entityIndex = new EntityIndex(), provenance = new ProvenanceIndex(entityIndex);
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      const allocatedIds = entityIndex._id;
      expect(provenance.get(quad)).toEqual([]);
      expect(entityIndex._id).toBe(allocatedIds);
    });

    it('returns no occurrences for a known but unrecorded quad', () => {
      const entityIndex = new EntityIndex(), provenance = new ProvenanceIndex(entityIndex);
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      entityIndex.intern(quad);
      expect(provenance.get(quad)).toEqual([]);
    });

    it('appends pending parser data after an existing public occurrence', () => {
      const entityIndex = new EntityIndex(), provenance = new ProvenanceIndex(entityIndex);
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      const occurrence = { subject: [], predicate: [], object: [], graph: [] };
      provenance.add(quad, occurrence);
      const range = [1, 0, 1, 3, false], quadId = entityIndex.lookup(quad);
      provenance._add(quadId, range, null, null, null);
      expect(provenance.get(quad)).toHaveLength(2);
    });

    it('groups multiple pending occurrences before compacting them', () => {
      const entityIndex = new EntityIndex(), provenance = new ProvenanceIndex(entityIndex);
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      const quadId = entityIndex.intern(quad), range = [1, 0, 1, 3, false];
      provenance._add(quadId, range, null, null, null);
      provenance._add(quadId, range, null, null, null);
      range[4] = true;
      expect(provenance.get(quad)).toHaveLength(2);
    });

    it('finalizes pending data behind an existing compact occurrence', () => {
      const entityIndex = new EntityIndex(), provenance = new ProvenanceIndex(entityIndex);
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      provenance.add(quad, { subject: [], predicate: [], object: [], graph: [] });
      const range = [1, 0, 1, 3, false];
      provenance._add(entityIndex.lookup(quad), range, null, null, null);
      range[4] = true;
      provenance._finalizeAll();
      expect(provenance.get(quad)).toHaveLength(2);
    });

    it('keeps closed occurrences behind an earlier pending occurrence', () => {
      const entityIndex = new EntityIndex(), provenance = new ProvenanceIndex(entityIndex);
      const quad = DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      );
      const quadId = entityIndex.intern(quad), range = [1, 2, 1, 5, false];
      provenance._add(quadId, range, null, null, null);
      provenance._add(quadId, null, null, null, null);
      range[4] = true;
      expect(provenance.get(quad).map(({ subject }) => subject.map(range => range.start.column)))
        .toEqual([[2], []]);
    });

    it('resolves quads reconstructed by a store', () => {
      const doc = '<s> <p> "lit" .';
      const { quads, provenance } = parse(doc);
      const store = new Store(quads);
      const rebuilt = store.getQuads(null, null, null)[0];
      expect(rebuilt).not.toBe(quads[0]);
      expect(provenance.get(rebuilt)).toHaveLength(1);
    });

    it('shares compact numeric quad identities with an N3 entity index', () => {
      const entityIndex = new EntityIndex();
      const { quads, provenance } = parse('<s> <p> "lit" .', { entityIndex });
      const allocatedIds = entityIndex._id;
      const quadId = entityIndex._termToNumericId(quads[0]);
      expect(quadId).toEqual(expect.any(Number));
      expect(Object.getPrototypeOf(provenance._quadOccurrences)).toBeNull();
      expect(provenance._quadOccurrences[quadId]).toHaveLength(16);

      const store = new Store({ entityIndex });
      store.addQuads(quads);
      expect(entityIndex._id).toBe(allocatedIds);
      expect(provenance.get(store.getQuads(null, null, null)[0])).toHaveLength(1);
    });
  });

  describe('coverage of span-less and exotic terms', () => {
    it('constructs without options', () => {
      const { quads } = new ProvenanceParser().parse('<http://x/s> <http://x/p> <http://x/o> .');
      expect(quads).toHaveLength(1);
    });

    it('iterates over utterance lists without exposing counts', () => {
      const { provenance } = parse('<s> <p> <o> .\n<s> <p> <o2> .');
      const entries = [...provenance];
      expect(entries.map(([, occurrences]) => occurrences.length)).toEqual([1, 1]);
      expect(entries[0][0].termType).toBe('Quad');
      expect(provenance).not.toHaveProperty('size');
      expect(provenance).not.toHaveProperty('utteranceCount');
      expect(new ProvenanceIndex().get(DataFactory.quad(
        DataFactory.namedNode('x:s'), DataFactory.namedNode('x:p'), DataFactory.namedNode('x:o'),
      ))).toEqual([]);
    });
  });

  describe('occurrence tracking', () => {
    it('gives implicit reification terms no ranges', () => {
      const { quads, provenance } = parse('<s> <p> <o> ~ .');
      const reifies = quads.find(q => q.predicate.value.endsWith('#reifies'));
      expect(reifies).toBeDefined();
      expect(Object.getOwnPropertySymbols(reifies)).toHaveLength(0);
      expect(Object.getOwnPropertySymbols(reifies.subject)).toHaveLength(0);
      expect(Object.getOwnPropertySymbols(reifies.object)).toHaveLength(0);
      expect(provenance.get(reifies)[0].subject).toEqual([]);
      expect(provenance.get(reifies)[0].object).toEqual([]);
    });

    it('does not attach private metadata to emitted terms', () => {
      const { quads } = parse('<s> <p> <o> .');
      expect(Object.getOwnPropertySymbols(quads[0])).toHaveLength(0);
      expect(Object.getOwnPropertySymbols(quads[0].subject)).toHaveLength(0);
      expect(Object.getOwnPropertySymbols(quads[0].predicate)).toHaveLength(0);
      expect(Object.getOwnPropertySymbols(quads[0].object)).toHaveLength(0);
    });

    it('locates interned terms independently without mutating them', () => {
      const factory = frozenInterningFactory();

      const doc = '<x> <x> <x> .';
      const { quads, provenance } = parse(doc, { factory });
      expect(quads[0].subject).toBe(quads[0].predicate);
      expect(quads[0].predicate).toBe(quads[0].object);
      const occurrence = provenance.get(quads[0])[0];
      expect([occurrence.subject, occurrence.predicate, occurrence.object]
        .map(([range]) => [range.start.column, range.end.column]))
        .toEqual([[0, 3], [4, 7], [8, 11]]);
      expect(Object.getOwnPropertySymbols(quads[0].subject)).toHaveLength(0);
    });

    it('supports quantified terms from an RDF/JS factory without internal IDs', () => {
      const doc = '@forAll <x>. <x> <p> <o> .',
          { quads, provenance } = parse(doc, { format: 'text/n3', factory: rdfDataModel }),
          quad = quads[quads.length - 1];
      expect(quad.subject.termType).toBe('Variable');
      expect(quad.predicate.value).toBe(`${BASE_IRI}p`);
      expect(quad.object.value).toBe(`${BASE_IRI}o`);
      expect(texts(doc, provenance.get(quad)[0].subject)).toEqual(['<x>']);
    });

    it('passes raw factory terms to inherited prefix callbacks', () => {
      const prefixes = [];
      new N3TermLocationParser({ factory: rdfDataModel }).parse(
        '@prefix ex: <http://example.com/>. ex:s ex:p ex:o.',
        { onPrefix: (...args) => prefixes.push(args) },
      );
      expect(prefixes).toEqual([['ex', rdfDataModel.namedNode('http://example.com/')]]);
    });

    it('preserves custom factory receivers and method arities', () => {
      function recordingFactory(calls) {
        const factory = Object.create(DataFactory);
        for (const name of ['namedNode', 'blankNode', 'variable', 'literal', 'defaultGraph', 'quad']) {
          Object.defineProperty(factory, name, {
            value(...args) {
              calls.push({ name, arity: args.length, receiver: this });
              return DataFactory[name](...args);
            },
          });
        }
        return factory;
      }

      const doc = '<s> <p> [ <q> "value" ] .\n<s> <p> <<( <x> <y> _:z )>> .';
      const plainCalls = [], trackedCalls = [];
      new Parser({ baseIRI: BASE_IRI, blankNodePrefix: '', factory: recordingFactory(plainCalls) }).parse(doc);
      const trackedFactory = recordingFactory(trackedCalls);
      parse(doc, { factory: trackedFactory });
      expect(trackedCalls.map(({ name, arity }) => ({ name, arity })))
        .toStrictEqual(plainCalls.map(({ name, arity }) => ({ name, arity })));
      expect(trackedCalls.every(({ receiver }) => receiver === trackedFactory)).toBe(true);

      const variableCalls = [], variableFactory = recordingFactory(variableCalls);
      parse('?s <p> <o> .', { format: 'text/n3', factory: variableFactory });
      expect(variableCalls.find(({ name }) => name === 'variable').receiver).toBe(variableFactory);
    });

    it('uses the custom factory when reconstructing indexed quads', () => {
      class CustomNamedNode {
        constructor(value) { this.termType = 'NamedNode'; this.value = value; }
      }
      const factory = Object.create(DataFactory);
      factory.namedNode = value => new CustomNamedNode(value);
      const { provenance } = parse('<s> <p> <o> .', { factory });
      const [[quad]] = provenance;
      expect(quad.subject).toBeInstanceOf(CustomNamedNode);
      expect(quad.predicate).toBeInstanceOf(CustomNamedNode);
      expect(quad.object).toBeInstanceOf(CustomNamedNode);
    });

    it('rejects a non-RDF/JS quad factory with a clear error', () => {
      const factory = {
        namedNode: value => value,
        blankNode: value => `_:${value || 'b'}`,
        variable: value => `?${value}`,
        literal: value => `"${value}"`,
        defaultGraph: () => '',
        quad: (s, p, o, g) => ({ s, p, o, g }),
      };
      expect(() => parse('<s> <p> <o> .', { factory }))
        .toThrow('ProvenanceParser requires an RDF/JS-compatible data factory');
    });

    it('does not change what the parser emits', () => {
      const doc = '@prefix ex: <http://ex.example/>.\nex:s ex:p [ ex:q (1 2) ], "x"@en--ltr .';
      // anonymous blank node labels come from a global counter, so compare
      // with labels normalized by order of first appearance
      function normalize(quads) {
        const seen = new Map();
        function label(l) {
          if (!seen.has(l)) seen.set(l, `bn${seen.size}`);
          return seen.get(l);
        }
        return quads.map(q => JSON.stringify(q.toJSON(), (k, v, o) => v))
          .map((s, i) => JSON.parse(s))
          .map(j => JSON.parse(JSON.stringify(j), (k, v) =>
            v && v.termType === 'BlankNode' ? { ...v, value: label(v.value) } : v));
      }
      const plain = new Parser({ baseIRI: BASE_IRI, blankNodePrefix: '' }).parse(doc);
      const tracked = parse(doc);
      expect(normalize(tracked.quads)).toEqual(normalize(plain));
    });
  });

  describe('facade behavior', () => {
    it('constructs with null options', () => {
      expect(new ProvenanceParser(null).parse('<s> <p> <o> .').quads).toHaveLength(1);
    });

    it('rejects streaming input immediately', () => {
      expect(() => new ProvenanceParser().parse({ on() {} }))
        .toThrow('ProvenanceParser.parse only accepts a string');
    });

    it.each(['line', 'start', 'end'])('rejects custom lexer tokens without a numeric %s coordinate', field => {
      const lexer = {
        tokenize(input) {
          return new Lexer().tokenize(input).map(token => {
            const copy = { ...token };
            delete copy[field];
            return copy;
          });
        },
      };
      expect(() => parse('<s> <p> <o> .', { lexer }))
        .toThrow('Lexical provenance requires lexer tokens with numeric line, start, end, and multiline endLine');
    });

    it('rejects a non-numeric custom-lexer endLine', () => {
      const lexer = {
        tokenize(input) {
          return new Lexer().tokenize(input).map(token => ({ ...token, endLine: 'invalid' }));
        },
      };
      expect(() => parse('<s> <p> <o> .', { lexer }))
        .toThrow('Lexical provenance requires lexer tokens with numeric line, start, end, and multiline endLine');
    });

    it('accepts N3Lexer itself as a custom lexer for multiline tokens', () => {
      const doc = '<s> <p> """a\nb""" .', { quads, provenance } = parse(doc, { lexer: new Lexer() });
      expect(texts(doc, provenance.get(quads[0])[0].object)).toEqual(['"""a\nb"""']);
    });

    it('validates coordinates on every custom-lexer token', () => {
      const lexer = {
        tokenize(input) {
          const tokens = new Lexer().tokenize(input).map(token => ({ ...token }));
          delete tokens[1].start;
          return tokens;
        },
      };
      expect(() => parse('<s> <p> <o> .', { lexer }))
        .toThrow('Lexical provenance requires lexer tokens with numeric line, start, end, and multiline endLine');
    });

    it('can be reused without carrying prefixes or occurrences across parses', () => {
      const parser = new ProvenanceParser({ baseIRI: BASE_IRI });
      const first = parser.parse('@prefix ex: <http://ex/>. ex:s ex:p ex:o.');
      const second = parser.parse('<s> <p> <o>.');
      expect(first.prefixes.ex).toBe('http://ex/');
      expect(second.prefixes.ex).toBeUndefined();
      expect(second.provenance.get(first.quads[0])).toEqual([]);
    });

    it('calls onQuad in parse order with complete public ranges', () => {
      const events = [], doc = '[ <p> <o> ] <q> <r> .';
      const result = parse(doc, { onQuad: (quad, occurrence) => events.push([quad, occurrence]) });
      expect(events.map(([quad]) => quad)).toEqual(result.quads);
      expect(texts(doc, events[0][1].subject)).toEqual(['[', ']']);
    });

    it('emits completed quads before a later parse error', () => {
      const events = [];
      expect(() => new ProvenanceParser({
        baseIRI: BASE_IRI,
        onQuad: (...args) => events.push(args),
      }).parse('<s> <p> <o> . <unfinished>')).toThrow();
      expect(events).toHaveLength(1);
      expect(events[0][0].subject.value).toBe(`${BASE_IRI}s`);
    });

    it('emits a completed compound range before a later parse error', () => {
      const events = [];
      expect(() => new ProvenanceParser({
        baseIRI: BASE_IRI,
        format: 'text/n3',
        onQuad: (...args) => events.push(args),
      }).parse('[ <p> <o> ] . <unfinished>')).toThrow();
      expect(events).toHaveLength(1);
      expect(events[0][1].subject).toEqual([
        { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        { start: { line: 1, column: 10 }, end: { line: 1, column: 11 } },
      ]);
    });

    it('stops emitting when an onQuad callback throws', () => {
      const error = new Error('stop'), events = [];
      expect(() => parse('[ <p> <o> ] <q> <r> .', {
        onQuad: quad => {
          events.push(quad);
          throw error;
        },
      })).toThrow(error);
      expect(events).toHaveLength(1);
    });

    it('supports the inherited callback path in the internal location parser', done => {
      const events = [];
      new N3TermLocationParser({ onQuad: (...args) => events.push(args) })
        .parse('<s> <p> <o> .', (error, quad) => {
          if (error)
            return done(error);
          if (quad)
            return;
          expect(events).toHaveLength(1);
          done();
        });
    });

    it('constructs the internal location parser without options', () => {
      expect(new N3TermLocationParser().parse('<s> <p> <o> .')).toHaveLength(1);
    });
  });
});


describe('Callback-based provenance integration', () => {
  it.each([
    ['turtle', '(() ()) <p> <o>.'],
    ['text/n3', '(() ()) <p> <o>.'],
    ['text/n3', '<s> () ().'],
    ['text/n3', '(()!<p> ()^<q>) <r> <o>.'],
  ])('keeps lexical empty lists distinct from synthetic rdf:nil in %s: %s', (format, doc) => {
    const { quads, provenance } = parse(doc, { format });
    expect(isomorphic(quads, new Parser({ baseIRI: BASE_IRI, format }).parse(doc))).toBe(true);
    const occurrences = quads.map(quad => [quad, provenance.get(quad)[0]]);
    const lexical = occurrences.flatMap(([quad, occurrence]) =>
      ['subject', 'predicate', 'object'].filter(component => occurrence[component].length > 0 &&
        quad[component].value.endsWith('#nil')).map(component => texts(doc, occurrence[component])));
    expect(lexical).toContainEqual(['(', ')']);
    const tails = occurrences.filter(([quad]) => quad.predicate.value.endsWith('#rest') &&
      quad.object.value.endsWith('#nil'));
    expect(tails.map(([, occurrence]) => occurrence.object)).toEqual(tails.map(() => []));
  });

  it.each([
    '[ <p> <o>; is <q> of <r> ] <a> <b>.',
    '{ <s> is <p> of <o>; <q> <r> }.',
    '<s> is <p> of <o> {| <q> <r> |}.',
    '<a> <b> <<( <s> is <p> of <o> )>>.',
    '<s> <- (<a>) <o>.',
  ])('preserves current N3 inverse semantics and term locations: %s', doc => {
    const { quads, provenance } = parse(doc, { format: 'text/n3' });
    expect(isomorphic(quads, new Parser({ baseIRI: BASE_IRI, format: 'text/n3' }).parse(doc))).toBe(true);
    for (const quad of quads) {
      const occurrence = provenance.get(quad)[0];
      const lexical = ['subject', 'predicate', 'object'].filter(component =>
        occurrence[component].length > 0 && quad[component].termType === 'NamedNode' &&
        quad[component].value.startsWith(BASE_IRI));
      expect(lexical.map(component => texts(doc, occurrence[component])))
        .toEqual(lexical.map(component => [`<${quad[component].value.slice(BASE_IRI.length)}>`]));
    }
  });

  it('composes public observers and comments without losing literal suffix ranges', () => {
    const doc = '<s> <p> "text" # between\n @en--rtl .', before = [], after = [], comments = [];
    const parser = new N3TermLocationParser({ baseIRI: BASE_IRI });
    const quads = parser.parse(doc, {
      onToken: token => before.push(token),
      onTokenEnd: token => after.push(token),
      onComment: comment => comments.push(comment),
    });
    expect(quads[0].object.direction).toBe('rtl');
    expect(before).toEqual(after);
    expect(comments).toEqual([' between']);
  });

  it('keeps locations identical across every two-chunk split', () => {
    const doc = '\uFEFF<g> { [ <p> """a\r\nb"""@en--rtl ] <q> (() <x>) . }';
    const expected = parse(doc, { format: 'trig' });
    const expectedRanges = expected.quads.map(quad => expected.provenance.get(quad)[0]);
    for (let split = 0; split <= doc.length; split++) {
      const input = new EventEmitter(), entityIndex = new EntityIndex(),
          index = new ProvenanceIndex(entityIndex), quads = [];
      new N3TermLocationParser({
        baseIRI: BASE_IRI, format: 'trig', entityIndex,
        onQuad: (quad, id, ...ranges) => index._add(id, ...ranges),
      }).parse(input, (error, quad) => {
        if (error) throw error;
        if (quad) quads.push(quad);
      });
      input.emit('data', doc.slice(0, split));
      input.emit('data', doc.slice(split));
      input.emit('end');
      expect(isomorphic(quads, expected.quads)).toBe(true);
      expect(quads.map(quad => index.get(quad)[0])).toEqual(expectedRanges);
    }
  });

  it('supports resolving unknown IDs and interning a default-graph tuple', () => {
    const index = new EntityIndex();
    expect(index.resolve(999)).toBeUndefined();
    const term = DataFactory.namedNode('urn:value'), id = index.intern(term);
    const quadId = index.internQuad(id, id, id);
    expect(index.resolve(quadId)).toEqual(DataFactory.quad(term, term, term));
  });
});
