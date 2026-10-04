// Typed handles on the N3.js runtime exports this package builds on.
import { EntityIndex, Parser, termToId as untypedTermToId } from 'n3';
import type * as RDF from '@rdfjs/types';
import type { N3EntityIndex as EntityIndexType, N3Parser as ParserType } from './n3-internals.js';

export const N3EntityIndex = EntityIndex as typeof EntityIndexType;
export const N3Parser = Parser as typeof ParserType;
export const termToId = untypedTermToId as (term: RDF.Term) => string;
