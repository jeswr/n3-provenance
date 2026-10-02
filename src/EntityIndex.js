// Keep provenance's indexing API outside the core N3 Store.
import { EntityIndex } from 'n3';

export default class ProvenanceEntityIndex extends EntityIndex {
  lookup(term) {
    return this._termToNumericId(term);
  }

  intern(term) {
    return this._termToNewNumericId(term);
  }

  resolve(id) {
    const termId = this._entities[id];
    return termId === undefined ? undefined : this._termFromId(termId);
  }

  internQuad(subject, predicate, object, graph = 1) {
    const key = graph === 1 ? `.${subject}.${predicate}.${object}` :
      `.${subject}.${predicate}.${object}.${graph}`;
    return this._ids[key] || (this._ids[this._entities[++this._id] = key] = this._id);
  }
}
