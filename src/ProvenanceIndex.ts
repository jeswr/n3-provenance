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

// The source ranges of one quad occurrence. A component is `null` when it has
// no lexical spelling.
export interface Occurrence {
  subject: Range | null;
  predicate: Range | null;
  object: Range | null;
  graph: Range | null;
}

// A range as the parser reports it: a closed token, or a compound term's
// range that may still be waiting for its closing token.
export type ParserRange = Pick<Token, 'line' | 'start' | 'end' | 'endLine'> | MutableRange | null;

type PendingOccurrence = [ParserRange, ParserRange, ParserRange, ParserRange];

const components = ['subject', 'predicate', 'object', 'graph'] as const;
const valuesPerRange = 4;
const valuesPerOccurrence = components.length * valuesPerRange;

function writeRange(target: number[], offset: number, range: ParserRange): void {
  if (range === null) {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 0;
    return;
  }
  if (Array.isArray(range)) {
    target[offset] = range[0];
    target[offset + 1] = range[1];
    target[offset + 2] = range[2];
    target[offset + 3] = range[3];
  }
  else {
    target[offset] = range.line;
    target[offset + 1] = range.start;
    target[offset + 2] = range.endLine || range.line;
    target[offset + 3] = range.end;
  }
}

function appendRanges(target: number[], subject: ParserRange, predicate: ParserRange,
  object: ParserRange, graph: ParserRange): void {
  const offset = target.length;
  writeRange(target, offset, subject);
  writeRange(target, offset + valuesPerRange, predicate);
  writeRange(target, offset + valuesPerRange * 2, object);
  writeRange(target, offset + valuesPerRange * 3, graph);
}

function isClosedRange(range: ParserRange): boolean {
  return range === null || !Array.isArray(range) || range[4];
}

function appendPending(target: number[], pending: PendingOccurrence[]): void {
  for (const occurrence of pending)
    appendRanges(target, occurrence[0], occurrence[1], occurrence[2], occurrence[3]);
}

function readRange(source: number[], offset: number): Range | null {
  return source[offset] === 0 ? null : {
    start: { line: source[offset], column: source[offset + 1] },
    end: { line: source[offset + 2], column: source[offset + 3] },
  };
}

function materializeRange(range: ParserRange): Range | null {
  if (range === null)
    return null;
  return Array.isArray(range) ? {
    start: { line: range[0], column: range[1] },
    end: { line: range[2], column: range[3] },
  } : {
    start: { line: range.line, column: range.start },
    end: { line: range.endLine || range.line, column: range.end },
  };
}

export function materializeOccurrence(subject: ParserRange, predicate: ParserRange,
  object: ParserRange, graph: ParserRange): Occurrence {
  return {
    subject: materializeRange(subject),
    predicate: materializeRange(predicate),
    object: materializeRange(object),
    graph: materializeRange(graph),
  };
}

function readOccurrences(source: number[]): Occurrence[] {
  const occurrences = new Array<Occurrence>(source.length / valuesPerOccurrence);
  for (let offset = 0, index = 0; offset < source.length; offset += valuesPerOccurrence, index++) {
    occurrences[index] = {
      subject: readRange(source, offset),
      predicate: readRange(source, offset + valuesPerRange),
      object: readRange(source, offset + valuesPerRange * 2),
      graph: readRange(source, offset + valuesPerRange * 3),
    };
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
    for (const component of components) {
      const range = occurrence[component];
      if (range === null)
        packed.push(0, 0, 0, 0);
      else
        packed.push(range.start.line, range.start.column, range.end.line, range.end.column);
    }

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
