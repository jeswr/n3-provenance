// **N3ProvenanceIndex** stores and resolves the locations of quad occurrences.
import type * as RDF from '@rdfjs/types';
import N3EntityIndex from './EntityIndex.js';
import type { MutableRange, Token } from './n3-internals.js';

// A one-based line and a zero-based UTF-16 column.
export interface Position {
  line: number;
  column: number;
}

// A source range; `end` is exclusive.
export interface Range {
  start: Position;
  end: Position;
}

// The source ranges of one quad occurrence. A component's ranges spell it, in
// document order: none when it has no lexical spelling, one for a simple term,
// and for a compound term -- [ ... ], ( ... ), { ... }, <<( ... )>>, << ... >>
// -- its opening and its closing delimiter. The terms written between those
// are located by their own quads.
export interface Occurrence {
  subject: Range[];
  predicate: Range[];
  object: Range[];
  graph: Range[];
}

// A range as the parser reports it: a closed token, or a compound term's
// range that may still be waiting for its closing token.
export type ParserRange = Pick<Token, 'line' | 'start' | 'end' | 'endLine'> | MutableRange | null;

type PendingOccurrence = [ParserRange, ParserRange, ParserRange, ParserRange];

const components = ['subject', 'predicate', 'object', 'graph'] as const;
const valuesPerRange = 4;

// A compound range carries its closing token's coordinates after the flag.
function hasClosingToken(range: MutableRange): boolean {
  return range.length > 5;
}

function rangeCount(range: ParserRange): number {
  return range === null ? 0 : Array.isArray(range) && hasClosingToken(range) ? 2 : 1;
}

function pushRange(target: number[], range: ParserRange): void {
  if (range === null)
    return;
  if (Array.isArray(range)) {
    target.push(range[0], range[1], range[2], range[3]);
    if (hasClosingToken(range))
      target.push(range[5], range[6], range[7], range[8]);
  }
  else
    target.push(range.line, range.start, range.endLine || range.line, range.end);
}

// An occurrence is stored as each component's range count, then four
// coordinates per range.
function appendRanges(target: number[], subject: ParserRange, predicate: ParserRange,
  object: ParserRange, graph: ParserRange): void {
  target.push(rangeCount(subject), rangeCount(predicate), rangeCount(object), rangeCount(graph));
  pushRange(target, subject);
  pushRange(target, predicate);
  pushRange(target, object);
  pushRange(target, graph);
}

function isClosedRange(range: ParserRange): boolean {
  return range === null || !Array.isArray(range) || range[4];
}

function appendPending(target: number[], pending: PendingOccurrence[]): void {
  for (const occurrence of pending)
    appendRanges(target, occurrence[0], occurrence[1], occurrence[2], occurrence[3]);
}

function readRange(source: number[], offset: number): Range {
  return {
    start: { line: source[offset], column: source[offset + 1] },
    end: { line: source[offset + 2], column: source[offset + 3] },
  };
}

function materializeRanges(range: ParserRange): Range[] {
  if (range === null)
    return [];
  if (!Array.isArray(range))
    return [{
      start: { line: range.line, column: range.start },
      end: { line: range.endLine || range.line, column: range.end },
    }];
  const ranges: Range[] = [{
    start: { line: range[0], column: range[1] },
    end: { line: range[2], column: range[3] },
  }];
  if (hasClosingToken(range))
    ranges.push({
      start: { line: range[5], column: range[6] },
      end: { line: range[7], column: range[8] },
    });
  return ranges;
}

export function materializeOccurrence(subject: ParserRange, predicate: ParserRange,
  object: ParserRange, graph: ParserRange): Occurrence {
  return {
    subject: materializeRanges(subject),
    predicate: materializeRanges(predicate),
    object: materializeRanges(object),
    graph: materializeRanges(graph),
  };
}

function readOccurrences(source: number[]): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (let offset = 0; offset < source.length;) {
    const counts = source.slice(offset, offset + components.length);
    offset += components.length;
    const occurrence: Occurrence = { subject: [], predicate: [], object: [], graph: [] };
    for (let i = 0; i < components.length; i++)
      for (let n = 0; n < counts[i]; n++, offset += valuesPerRange)
        occurrence[components[i]].push(readRange(source, offset));
    occurrences.push(occurrence);
  }
  return occurrences;
}

export class ProvenanceIndex {
  private _entityIndex: N3EntityIndex;
  private _quadOccurrences: Record<string, number[]>;
  private _pendingOccurrences: Record<string, PendingOccurrence[]>;

  constructor(entityIndex: N3EntityIndex = new N3EntityIndex()) {
    this._entityIndex = entityIndex;
    this._quadOccurrences = Object.create(null);
    this._pendingOccurrences = Object.create(null);
  }

  // Adds public occurrence data by value. Later changes to `occurrence` do not
  // alter the index.
  add(quad: RDF.Quad, occurrence: Occurrence): void {
    // Pack first so malformed public input cannot partially mutate the index.
    const packed: number[] = [];
    for (const component of components)
      packed.push(occurrence[component].length);
    for (const component of components)
      for (const range of occurrence[component])
        packed.push(range.start.line, range.start.column, range.end.line, range.end.column);

    const quadId = this._entityIndex.intern(quad);
    this._finalize(quadId);
    const stored = this._quadOccurrences[quadId];
    if (stored === undefined)
      this._quadOccurrences[quadId] = packed;
    else
      stored.push(...packed);
  }

  // Adds the parser's compact, mutable range references. Compound ranges are
  // finalized when parsing finishes, once their closing token is known.
  _add(quadId: number, subject: ParserRange, predicate: ParserRange,
    object: ParserRange, graph: ParserRange): void {
    const pending = this._pendingOccurrences[quadId];
    if (pending !== undefined) {
      pending.push([subject, predicate, object, graph]);
      return;
    }

    if (isClosedRange(subject) && isClosedRange(predicate) &&
        isClosedRange(object) && isClosedRange(graph)) {
      let stored = this._quadOccurrences[quadId];
      if (stored === undefined)
        stored = this._quadOccurrences[quadId] = [];
      appendRanges(stored, subject, predicate, object, graph);
      return;
    }

    this._pendingOccurrences[quadId] = [[subject, predicate, object, graph]];
  }

  private _finalize(quadId: number): void {
    const pending = this._pendingOccurrences[quadId];
    if (pending === undefined)
      return;

    let stored = this._quadOccurrences[quadId];
    if (stored === undefined)
      stored = this._quadOccurrences[quadId] = [];
    appendPending(stored, pending);
    delete this._pendingOccurrences[quadId];
  }

  _finalizeAll(): void {
    const allPending = this._pendingOccurrences;
    this._pendingOccurrences = Object.create(null);
    for (const quadId in allPending) {
      let stored = this._quadOccurrences[quadId];
      if (stored === undefined)
        stored = this._quadOccurrences[quadId] = [];
      appendPending(stored, allPending[quadId]);
    }
  }

  get(quad: RDF.Quad): Occurrence[] {
    const quadId = this._entityIndex.lookup(quad);
    if (quadId === undefined)
      return [];
    this._finalize(quadId);
    const occurrences = this._quadOccurrences[quadId];
    return occurrences === undefined ? [] : readOccurrences(occurrences);
  }

  *[Symbol.iterator](): IterableIterator<[RDF.Quad, Occurrence[]]> {
    this._finalizeAll();
    for (const quadId in this._quadOccurrences)
      yield [this._entityIndex.resolve(quadId) as RDF.Quad, readOccurrences(this._quadOccurrences[quadId])];
  }
}
