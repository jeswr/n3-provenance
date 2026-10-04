// **N3TermLocationParser** tracks lexical term occurrences while parsing and
// emits their compact source ranges alongside each quad.
import type * as RDF from '@rdfjs/types';
import { N3Parser, termToId } from './n3.js';
import N3EntityIndex from './EntityIndex.js';
import type { ParserRange } from './ProvenanceIndex.js';
import type {
  MutableRange, N3ParserOptions, ParseCallbacks, ParserValue, Token,
} from './n3-internals.js';

export type LocatedQuadCallback = (quad: RDF.Quad, quadId: number, subject: ParserRange,
  predicate: ParserRange, object: ParserRange, graph: ParserRange) => void;

export interface TermLocationParserOptions extends N3ParserOptions {
  // Called with each quad, its interned id, and its components' ranges.
  // Compound ranges stay open until their closing token has been read.
  onQuad?: LocatedQuadCallback;
  // Index to intern terms and quads in.
  entityIndex?: N3EntityIndex;
}

type SourceRange = Token | MutableRange;

const compoundContexts = new Set(['blank', 'list', 'formula', '<<(', '<<']),
    compoundTokens = new Set(['[', '(', '{', '<<(', '<<']);

class TermOccurrence {
  term: ParserValue;
  range: SourceRange | null;
  entityId: number;

  constructor(term: ParserValue, range: SourceRange | null) {
    this.term = term;
    this.range = range;
    this.entityId = 0;
  }

  get id(): string { return termToId(this.term); }
  get termType(): string | undefined { return this.term && this.term.termType; }
  get value(): string | undefined { return this.term && this.term.value; }
}

function unwrap(value: ParserValue): ParserValue {
  return value instanceof TermOccurrence ? value.term : value;
}

function locate(value: ParserValue, range: SourceRange | null): TermOccurrence {
  return new TermOccurrence(unwrap(value), range);
}

function tokenRange(token: Token, closed: boolean): MutableRange {
  return [token.line, token.start, token.endLine || token.line, token.end, closed];
}

function closeRange(range: MutableRange, token: Token): void {
  range[2] = token.endLine || token.line;
  range[3] = token.end;
  range[4] = true;
}

function occurrenceRange(value: ParserValue): SourceRange | null {
  return value instanceof TermOccurrence ? value.range : null;
}

export default class N3TermLocationParser extends N3Parser {
  private _onQuad: LocatedQuadCallback;
  private _entityIndex: N3EntityIndex;
  private _sourceRange: SourceRange | null;
  private _literalRange: MutableRange | null;
  private _constructingLiteralRange: MutableRange | null;
  private _currentToken: Token | null;
  private _blankNodeRanges: (SourceRange | null)[] | null;
  private _validateTokenRange: boolean;
  private _untrackedFactory: ParserValue;
  private _emptyListRange: MutableRange | null = null;
  private _namedGraphRange: MutableRange | null = null;

  constructor(options: TermLocationParserOptions = {}) {
    const { onQuad, entityIndex, ...parserOptions } = options;
    super(parserOptions);

    this._onQuad = onQuad || (() => {});
    this._entityIndex = entityIndex || new N3EntityIndex({ factory: this._factory });
    this._sourceRange = null;
    this._literalRange = null;
    this._constructingLiteralRange = null;
    this._currentToken = null;
    this._blankNodeRanges = null;
    this._validateTokenRange = parserOptions.lexer !== undefined;
    this._untrackedFactory = this._factory;
    this._factory = {};

    for (const name of ['namedNode', 'variable'] as const)
      this._factory[name] = (...args: ParserValue[]) => this._untrackedFactory[name](...args);
    this._factory.blankNode = (...args: ParserValue[]) => {
      const term = this._untrackedFactory.blankNode(...args),
          range = this._blankNodeRanges && this._blankNodeRanges.length ?
            this._blankNodeRanges.shift()! :
            this._currentToken && (this._currentToken.type === '[' || this._currentToken.type === '{') ?
              this._sourceRange : null;
      return range === null ? term : new TermOccurrence(term, range);
    };
    this._factory.literal = (...args: ParserValue[]) => {
      for (let i = 0; i < args.length; i++)
        args[i] = unwrap(args[i]);
      return new TermOccurrence(
        this._untrackedFactory.literal(...args), this._constructingLiteralRange || this._sourceRange,
      );
    };
    this._factory.quad = (...args: ParserValue[]) => {
      for (let i = 0; i < args.length; i++)
        args[i] = unwrap(args[i]);
      const term = this._untrackedFactory.quad(...args),
          context = this._contextStack[this._contextStack.length - 1];
      if (!context || !((context.type === '<<(' && this._currentToken!.type === ')>>') ||
                        (context.type === '<<' && this._currentToken!.type === '>>')))
        return term;
      closeRange(context.sourceRange!, this._currentToken!);
      return new TermOccurrence(term, context.sourceRange!);
    };
  }

  // The prefixes declared by the last parsed document.
  get prefixes(): Record<string, string> {
    return this._prefixes;
  }

  // A quantified entity can reuse an earlier RDF term, but each lexical use is
  // a distinct occurrence.
  protected _readEntity(token: Token, quantifier?: boolean): ParserValue {
    const blankNodeRanges = this._blankNodeRanges;
    this._blankNodeRanges = null;
    // Quantification in the core parser uses N3 terms' private IDs. Resolve
    // it here by value so external RDF/JS factories work as well.
    let term = super._readEntity(token, true);
    if (term !== undefined && !quantifier && this._n3Mode) {
      const id = termToId(unwrap(term));
      if (id in this._quantified)
        term = this._quantified[id];
    }
    this._blankNodeRanges = blankNodeRanges;
    return term === undefined || this._readCallback === this._readPrefixIRI ?
      term : locate(term, this._sourceRange);
  }

  // Predicate abbreviations resolve to parser constants, so give the constant
  // a fresh occurrence for this spelling.
  protected _readPredicate(token: Token): unknown {
    const next = super._readPredicate(token);
    if ((token.type === 'abbreviation' || token.type === 'inverse') && this._predicate !== null)
      this._predicate = locate(this._predicate, this._sourceRange);
    return next;
  }

  protected _saveContext(type: string, graph: ParserValue, subject: ParserValue,
    predicate: ParserValue, object: ParserValue): void {
    // Preserve the core parser's raw rdf:nil sentinel until its empty-list
    // identity checks have run. Only occurrence metadata leaves this adapter.
    if (type === 'item' && this._emptyListRange && object === this.RDF_NIL)
      object = locate(object, this._emptyListRange);

    super._saveContext(type, graph, subject, predicate, object);
    if (compoundContexts.has(type))
      this._contextStack[this._contextStack.length - 1].sourceRange = this._sourceRange as MutableRange;
  }

  protected _restoreContext(type: string, token: Token): unknown {
    const context = this._contextStack[this._contextStack.length - 1];
    if (context && context.type === type && context.sourceRange)
      closeRange(context.sourceRange, token);
    return super._restoreContext(type, token);
  }

  // Use the public token lifecycle; no private token dispatch override.
  parse(input: string, quadCallback?: ParseCallbacks | ((error: Error | null, quad: RDF.Quad) => void) | null,
    prefixCallback?: ((prefix: string, prefixNode: RDF.NamedNode) => void) | null,
    versionCallback?: ((version: string) => void) | null): RDF.Quad[] {
    const callbacks: ParseCallbacks = typeof quadCallback === 'function' ?
      { onQuad: quadCallback, onPrefix: prefixCallback, onVersion: versionCallback } :
      { ...quadCallback };
    const { onToken, onTokenEnd } = callbacks;
    callbacks.onToken = token => {
      this._beginToken(token);
      if (onToken) onToken(token);
    };
    callbacks.onTokenEnd = token => {
      this._endToken(token);
      if (onTokenEnd) onTokenEnd(token);
    };
    return super.parse(input, callbacks);
  }

  private _beginToken(token: Token): void {
    if (token.type === 'comment') return;
    if (this._validateTokenRange) {
      if (!Number.isFinite(token.line) || !Number.isFinite(token.start) ||
          token.endLine !== undefined && !Number.isFinite(token.endLine) ||
          !Number.isFinite(token.end))
        throw new TypeError('Lexical provenance requires lexer tokens with numeric line, start, end, and multiline endLine');
    }
    this._currentToken = token;
    this._sourceRange = compoundTokens.has(token.type) ? tokenRange(token, false) : token;

    // Plain strings are constructed while processing a later token. Keep one
    // mutable range so a language, direction, or datatype suffix is included.
    if (this._literalRange !== null &&
        (token.type === 'langcode' || token.type === 'dircode' ||
         token.type === 'type' || token.type === 'typeIRI'))
      closeRange(this._literalRange, token);

    // A dircode replaces the language-only term that was constructed for the
    // same lexical literal, so its factory call still belongs to that range.
    if (token.type === 'dircode')
      this._constructingLiteralRange = this._literalRange;
  }

  private _endToken(token: Token): void {
    if (token.type === 'comment') return;
    this._constructingLiteralRange = null;

    // Install a plain literal's pending range only after the callback. The
    // callback can first complete the preceding literal and then consume this
    // same token recursively (notably for adjacent N3 literals).
    if (token.type === 'literal')
      this._literalRange = token.prefix.length === 0 ? tokenRange(token, true) : null;
    // A language literal may still be replaced by a directional literal.
    else if (this._readCallback !== this._readDirCode)
      this._literalRange = null;
  }

  protected _completeLiteral(token: Token, component?: string): unknown {
    this._constructingLiteralRange = this._literalRange;
    try {
      return super._completeLiteral(token, component);
    }
    finally {
      this._constructingLiteralRange = null;
    }
  }

  protected _readListItem(token: Token): unknown {
    const context = this._contextStack[this._contextStack.length - 1];
    if (token.type !== ')') {
      const headRange = this._subject === null ? context.sourceRange! : null;
      this._blankNodeRanges = token.type === '[' || token.type === '{' ?
        [headRange, this._sourceRange] : [headRange];
    }

    // Empty lists use a raw singleton inside the grammar. Attach their
    // occurrence after the grammar has checked that sentinel by identity.
    // Explicit rdf:nil terms are already wrapped, even with an interning factory.
    const emptyRange = token.type === ')' && this._subject === null ? context.sourceRange! : null;
    this._emptyListRange = emptyRange;
    try {
      const next = super._readListItem(token);
      if (emptyRange) {
        for (const component of ['_subject', '_predicate', '_object'] as const)
          if (this[component] === this.RDF_NIL)
            this[component] = locate(this[component], emptyRange);
      }
      return next;
    }
    finally {
      this._blankNodeRanges = null;
      this._emptyListRange = null;
    }
  }

  protected _readFormulaTail(token: Token): unknown {
    if (token.type !== '}')
      return super._readFormulaTail(token);

    const context = this._contextStack[this._contextStack.length - 1],
        formula = this._graph,
        range = context.sourceRange!,
        empty = this._emptyFormula,
        component = context.subject === formula ? '_subject' :
                    context.predicate === formula ? '_predicate' : '_object';
    const next = super._readFormulaTail(token);
    if (empty && this._emptyFormulaAsTrue)
      this[component] = locate(this.N3_TRUE, range);
    return next;
  }

  protected _readNamedGraphLabel(token: Token): unknown {
    if (token.type === '[')
      this._namedGraphRange = this._sourceRange as MutableRange;
    return super._readNamedGraphLabel(token);
  }

  protected _readNamedGraphBlankLabel(token: Token): unknown {
    if (token.type === ']') {
      closeRange(this._namedGraphRange!, token);
      this._blankNodeRanges = [this._namedGraphRange];
    }
    try {
      return super._readNamedGraphBlankLabel(token);
    }
    finally {
      this._blankNodeRanges = null;
      this._namedGraphRange = null;
    }
  }

  private _termId(value: ParserValue): number {
    if (value instanceof TermOccurrence)
      return value.entityId || (value.entityId = this._entityIndex.intern(value.term));
    return this._entityIndex.intern(value);
  }

  protected _emit(subject: ParserValue, predicate: ParserValue, object: ParserValue, graph: ParserValue): void {
    this._emitLocated(subject, predicate, object, graph);
  }

  protected _emitInDirection(subject: ParserValue, predicate: ParserValue, object: ParserValue,
    graph: ParserValue, inversePredicate: boolean): void {
    if (inversePredicate)
      this._emitLocated(object, predicate, subject, graph);
    else
      this._emitLocated(subject, predicate, object, graph);
  }

  protected _emitCurrentInDirection(subject: ParserValue, predicate: ParserValue, object: ParserValue,
    graph: ParserValue): void {
    this._emitInDirection(subject, predicate, object, graph, this._inversePredicate);
  }

  private _emitLocated(subject: ParserValue, predicate: ParserValue, object: ParserValue, graph: ParserValue): void {
    // Nested empty lists emit their membership before _readListItem returns.
    if (this._emptyListRange && predicate === this.RDF_FIRST && object === this.RDF_NIL)
      object = locate(object, this._emptyListRange);
    graph = graph || this.DEFAULTGRAPH;
    const quad = this._untrackedFactory.quad(
      unwrap(subject), unwrap(predicate), unwrap(object), unwrap(graph),
    );
    if (!quad || quad.termType !== 'Quad')
      throw new TypeError('ProvenanceParser requires an RDF/JS-compatible data factory');

    const quadId = this._entityIndex.internQuad(
      this._termId(subject), this._termId(predicate), this._termId(object),
      graph === this.DEFAULTGRAPH ? 1 : this._termId(graph),
    );
    this._onQuad(quad, quadId,
      occurrenceRange(subject), occurrenceRange(predicate),
      occurrenceRange(object), occurrenceRange(graph));
    this._callback(null, quad);
  }
}
