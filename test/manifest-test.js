// Runs the declarative cases in manifest.yaml; the schema is documented there.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import rdfDataModel from '@rdfjs/data-model';
import { BASE_IRI, parse, slice, frozenInterningFactory } from './helpers.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const COMPONENTS = ['subject', 'predicate', 'object', 'graph'];
const FACTORIES = { 'frozen-interning': frozenInterningFactory, 'rdf-data-model': () => rdfDataModel };
const ENTRY_KEYS = ['label', 'doc', 'options', 'throws', 'quadCount', 'expect'];
const ROW_KEYS = ['match', 'index', 'all', 'count', 'occurrences', 'texts', ...COMPONENTS];

const manifest = parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8'));

// ${name} is replaced from `vars`; a string that is exactly one placeholder
// is replaced by the bound value itself, so lists and objects can be bound.
function substitute(value, vars) {
  if (typeof value === 'string') {
    const whole = /^\$\{(\w+)\}$/.exec(value);
    if (whole && whole[1] in vars)
      return vars[whole[1]];
    return value.replace(/\$\{(\w+)\}/g, (text, name) => (name in vars ? String(vars[name]) : text));
  }
  if (Array.isArray(value))
    return value.map(item => substitute(item, vars));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]));
  return value;
}

function instantiate({ each, ...template }) {
  const globals = manifest.vars || {}, entry = substitute(template, globals);
  return each ? substitute(each, globals).map(bindings => substitute(entry, bindings)) : [entry];
}

function rejectUnknown(object, allowed, what) {
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(`Unknown ${what} key(s) in manifest: ${unknown.join(', ')}`);
}

// A string pattern names an IRI (relative to the base IRI, or `rdf:`-prefixed);
// an object pattern compares the given fields of the term.
function matchTerm(term, pattern) {
  if (typeof pattern !== 'string')
    return Object.entries(pattern).every(([field, expected]) => term[field] === expected);
  const iri = pattern.startsWith('rdf:') ? RDF + pattern.slice(4) : new URL(pattern, BASE_IRI).href;
  return term.termType === 'NamedNode' && term.value === iri;
}
function matchQuad(quad, match = {}) {
  rejectUnknown(match, COMPONENTS, 'match');
  return COMPONENTS.every(component => !(component in match) || matchTerm(quad[component], match[component]));
}

// null: no range; string: source text of the range; object: any of text/start/end.
function checkRange(doc, range, expected) {
  if (expected === null)
    return expect(range).toBeNull();
  expect(range).not.toBeNull();
  const { text, start, end } = typeof expected === 'string' ? { text: expected } : expected;
  if (text !== undefined)
    expect(slice(doc, range)).toBe(text);
  if (start)
    expect(range.start).toEqual({ line: start[0], column: start[1] });
  if (end)
    expect(range.end).toEqual({ line: end[0], column: end[1] });
}

function checkOccurrence(doc, occurrence, { texts = [], ...components }) {
  rejectUnknown(components, COMPONENTS, 'component');
  const expected = { ...Object.fromEntries(texts.map((text, i) => [COMPONENTS[i], text])), ...components };
  if (Object.keys(expected).length > 0)
    expect(occurrence).toBeDefined();
  for (const [component, range] of Object.entries(expected))
    checkRange(doc, occurrence[component], range);
}

function checkRow(doc, quads, provenance, row, position) {
  rejectUnknown(row, ROW_KEYS, 'expect');
  const { match, index, all, count, occurrences = [], texts, ...components } = row;
  let selected;
  if (all) {
    selected = quads.filter(quad => matchQuad(quad, match));
    for (const list of Object.values(components))
      expect(selected).toHaveLength(list.length);
  }
  else {
    const quad = match ? quads.find(candidate => matchQuad(candidate, match)) : quads.at(index ?? position);
    expect(quad).toBeDefined();
    selected = [quad];
  }
  selected.forEach((quad, i) => {
    const found = provenance.get(quad);
    if (count !== undefined)
      expect(found).toHaveLength(count);
    checkOccurrence(doc, found[0], all
      ? Object.fromEntries(Object.entries(components).map(([component, list]) => [component, list[i]]))
      : { texts, ...components });
    occurrences.forEach((expected, n) => checkOccurrence(doc, found[n], expected));
  });
}

function run(entry) {
  rejectUnknown(entry, ENTRY_KEYS, 'entry');
  const { doc, options = {}, throws, quadCount, expect: rows = [] } = entry;
  const resolved = { ...options, ...(options.factory && { factory: FACTORIES[options.factory]() }) };
  if (throws !== undefined)
    return expect(() => parse(doc, resolved)).toThrow(throws);
  const { quads, provenance } = parse(doc, resolved);
  if (quadCount !== undefined)
    expect(quads).toHaveLength(quadCount);
  [].concat(rows).forEach((row, position) => checkRow(doc, quads, provenance, row, position));
}

describe('ProvenanceParser', () => {
  for (const { group, entries } of manifest.groups) {
    describe(group, () => {
      for (const entry of entries.flatMap(instantiate))
        it(entry.label, () => run(entry));
    });
  }
});
