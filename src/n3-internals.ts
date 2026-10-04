// Types for the N3.js runtime members this package relies on. N3.js ships no
// type declarations, and these include private members, so they are declared
// here rather than taken from @types/n3.
import type * as RDF from '@rdfjs/types';

// A lexer token. `start` and `end` are UTF-16 columns; `endLine` is set when
// the token spans several lines.
export interface Token {
  type: string;
  value?: string;
  prefix: string;
  line: number;
  start: number;
  end: number;
  endLine?: number;
}

export type TokenCallback = (token: Token) => void;

// A readable stream of document text, such as a Node.js stream.
export interface ParseInputStream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  setEncoding?(encoding: string): unknown;
}

export type ParseInput = string | ParseInputStream;

// Receives each quad, then `(null, null, prefixes)` once the document is
// complete, or the error that stopped parsing.
export type QuadParseCallback = (error: Error | null, quad?: RDF.Quad | null,
  prefixes?: Record<string, string>) => void;

export type PrefixCallback = (prefix: string, prefixNode: RDF.NamedNode) => void;

export type VersionCallback = (version: string) => void;

export interface ParseCallbacks {
  onQuad?: QuadParseCallback | null;
  onPrefix?: PrefixCallback | null;
  onComment?: (comment: string) => void;
  onVersion?: VersionCallback | null;
  onDirective?: (...args: never[]) => void;
  onToken?: TokenCallback;
  onTokenEnd?: TokenCallback;
}

// Callbacks that only observe a synchronous parse.
export type ObserverCallbacks = Omit<ParseCallbacks, 'onQuad'> & { onQuad?: null };

// Callbacks that receive the quads, so the parse reports through them.
export type QuadCallbacks = ParseCallbacks & { onQuad: QuadParseCallback };

export interface N3ParserOptions {
  format?: string;
  factory?: RDF.DataFactory;
  baseIRI?: string;
  blankNodePrefix?: string;
  isImpliedBy?: boolean;
  emptyFormulaAsTrue?: boolean;
  lexer?: unknown;
  [option: string]: unknown;
}

// The parser keeps terms, and the occurrence wrappers this package hands it,
// in its private state, so values read from that state are loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParserValue = any;

export type ReadCallback = (token: Token) => unknown;

export interface ParserContext {
  type: string;
  subject: ParserValue;
  predicate: ParserValue;
  object: ParserValue;
  sourceRange?: MutableRange;
}

// A compound term's range: start line and column, end line and column, and
// whether the closing token has been seen.
export type MutableRange = [number, number, number, number, boolean];

export declare class N3Parser {
  constructor(options?: N3ParserOptions);
  // Without a quad callback, parses a string synchronously and returns its quads.
  parse(input: string, callbacks?: ObserverCallbacks | null, prefixCallback?: PrefixCallback | null,
    versionCallback?: VersionCallback | null): RDF.Quad[];
  // With a quad callback, parses a string or stream and reports through it.
  parse(input: ParseInput, callbacks: QuadCallbacks | QuadParseCallback,
    prefixCallback?: PrefixCallback | null, versionCallback?: VersionCallback | null): void;

  protected _factory: ParserValue;
  protected _contextStack: ParserContext[];
  protected _prefixes: Record<string, string>;
  protected _quantified: Record<string, ParserValue>;
  protected _n3Mode: boolean;
  protected _readCallback: ReadCallback;
  protected _subject: ParserValue;
  protected _predicate: ParserValue;
  protected _object: ParserValue;
  protected _graph: ParserValue;
  protected _inversePredicate: boolean;
  protected _emptyFormula: boolean;
  protected _emptyFormulaAsTrue: boolean;
  protected _callback: QuadParseCallback;
  protected RDF_NIL: RDF.NamedNode;
  protected RDF_FIRST: RDF.NamedNode;
  protected N3_TRUE: RDF.Literal;
  protected DEFAULTGRAPH: RDF.DefaultGraph;

  protected _readEntity(token: Token, quantifier?: boolean): ParserValue;
  protected _readPredicate(token: Token): unknown;
  protected _saveContext(type: string, graph: ParserValue, subject: ParserValue,
    predicate: ParserValue, object: ParserValue): void;
  protected _restoreContext(type: string, token: Token): unknown;
  protected _completeLiteral(token: Token, component?: string): unknown;
  protected _readListItem(token: Token): unknown;
  protected _readFormulaTail(token: Token): unknown;
  protected _readNamedGraphLabel(token: Token): unknown;
  protected _readNamedGraphBlankLabel(token: Token): unknown;
  protected _readPrefixIRI(token: Token): unknown;
  protected _readDirCode(token: Token): unknown;
}

export interface N3EntityIndexOptions {
  factory?: RDF.DataFactory;
}

export declare class N3EntityIndex {
  constructor(options?: N3EntityIndexOptions);
  protected _id: number;
  protected _ids: Record<string, number>;
  protected _entities: Record<number | string, string>;
  protected _termToNumericId(term: RDF.Term): number | undefined;
  protected _termToNewNumericId(term: RDF.Term): number;
  protected _termFromId(id: string): RDF.Term;
}
