import { Store } from 'n3';
import ProvenanceParser from '../src/index.js';

const source = '<s> <p> "text"@en .\n<s> <p> "text"@en .';
const { quads, provenance } = new ProvenanceParser({ baseIRI: 'https://example.org/' }).parse(source);
const store = new Store(quads);
console.log(JSON.stringify(provenance.get(store.getQuads(null, null, null, null)[0]), null, 2));
