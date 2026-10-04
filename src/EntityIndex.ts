// Keep provenance's indexing API outside the core N3 Store.
import type * as RDF from '@rdfjs/types';
import { N3EntityIndex } from './n3.js';

export default class ProvenanceEntityIndex extends N3EntityIndex {
  lookup(term: RDF.Term): number | undefined {
    return this._termToNumericId(term);
  }

  intern(term: RDF.Term): number {
    return this._termToNewNumericId(term);
  }

  resolve(id: number | string): RDF.Term | undefined {
    const termId = this._entities[id];
    return termId === undefined ? undefined : this._termFromId(termId);
  }

  internQuad(subject: number, predicate: number, object: number, graph = 1): number {
    const key = graph === 1 ? `.${subject}.${predicate}.${object}` :
      `.${subject}.${predicate}.${object}.${graph}`;
    return this._ids[key] || (this._ids[this._entities[++this._id] = key] = this._id);
  }
}
