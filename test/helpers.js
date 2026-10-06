import { DataFactory } from 'n3';
import ProvenanceParser from '../src/index.js';

export const BASE_IRI = 'http://example.org/';

export function parse(doc, options = {}) {
  return new ProvenanceParser({ baseIRI: BASE_IRI, blankNodePrefix: '', ...options }).parse(doc);
}
export function offset(doc, position) {
  const newline = /\r\n|\r|\n/g;
  let lineStart = 0;
  for (let line = 1; line < position.line; line++) {
    const match = newline.exec(doc);
    lineStart = match.index + match[0].length;
  }
  return lineStart + position.column;
}
export function slice(doc, range) {
  return doc.slice(offset(doc, range.start), offset(doc, range.end));
}
export function frozenInterningFactory() {
  const terms = new Map(), factory = Object.create(DataFactory);
  factory.namedNode = value => {
    let term = terms.get(value);
    if (term === undefined)
      terms.set(value, term = Object.freeze(DataFactory.namedNode(value)));
    return term;
  };
  factory.literal = (...args) => Object.freeze(DataFactory.literal(...args));
  factory.blankNode = (...args) => Object.freeze(DataFactory.blankNode(...args));
  factory.variable = (...args) => Object.freeze(DataFactory.variable(...args));
  factory.defaultGraph = () => Object.freeze(DataFactory.defaultGraph());
  factory.quad = (...args) => Object.freeze(DataFactory.quad(...args));
  return factory;
}
