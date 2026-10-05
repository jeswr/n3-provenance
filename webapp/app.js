import { EditorView, basicSetup } from 'codemirror';
import { Decoration } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { turtle } from '@codemirror/legacy-modes/mode/turtle';
import ProvenanceParser from '../src/index.js';

const COMPONENTS = ['subject', 'predicate', 'object', 'graph'];
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

const FORMATS = {
  'Turtle / RDF 1.2': 'text/turtle',
  'TriG': 'application/trig',
  'N-Triples': 'application/n-triples',
  'N-Quads': 'application/n-quads',
  'Notation3': 'text/n3',
};

const EXAMPLES = [
  { name: 'Turtle: predicate-object lists', format: 'text/turtle', doc:
`@prefix ex: <http://example.org/> .

ex:alice ex:knows ex:bob ;
         ex:name "Alice"@en , "Alicia"@es ;
         ex:age 42 .
` },
  { name: 'Turtle: same quad uttered twice', format: 'text/turtle', doc:
`<s> <p> <o> .
<s> <p> <o> .
` },
  { name: 'Turtle: blank nodes and collections', format: 'text/turtle', doc:
`<s> <p> [ <q> "inner" ] , ( <a> <b> ) .
` },
  { name: 'TriG: named graph', format: 'application/trig', doc:
`<g> { <s> <p> <o> }
GRAPH [] { <s> <p> "in a blank graph" }
` },
  { name: 'RDF 1.2: annotation and triple term', format: 'text/turtle', doc:
`<s> <p> <o> ~ <r> {| <source> <wikipedia> |} .
<a> <b> <<( <s> <p> <o> )>> .
` },
  { name: 'N3: formulas, inversion, paths', format: 'text/n3', doc:
`{ <s> <p> <o> . } => { <s> <q> <o> } .
<o> is <p> of <s> .
<s>!<p> <q> <o> .
` },
];

// --- region highlighting, after shex.js's editor-panes: a StateField holding
// a DecorationSet that an effect replaces wholesale.

function makeRegionField() {
  const effect = StateEffect.define();
  const field = StateField.define({
    create: () => Decoration.none,
    update(decorations, tr) {
      for (const e of tr.effects)
        if (e.is(effect))
          return e.value;
      return tr.docChanged ? Decoration.none : decorations;
    },
    provide: f => EditorView.decorations.from(f),
  });
  return { effect, field };
}
const hover = makeRegionField(), problem = makeRegionField();

function toOffsets(doc, range) {
  const at = ({ line, column }) => {
    const info = doc.line(Math.min(Math.max(line, 1), doc.lines));
    return Math.min(info.from + column, info.to);
  };
  return { from: at(range.start), to: at(range.end) };
}

function highlight(view, regions, { scroll = false } = {}) {
  const marks = regions.map(({ range, component }) => {
    const { from, to } = toOffsets(view.state.doc, range);
    return Decoration.mark({ class: `hl-${component}` }).range(from, to);
  }).filter(mark => mark.to > mark.from);
  const effects = [hover.effect.of(Decoration.set(marks, true))];
  if (scroll && marks.length > 0)
    effects.push(EditorView.scrollIntoView(marks[0].from, { y: 'nearest' }));
  view.dispatch({ effects });
}

// --- terms

function show(term) {
  switch (term.termType) {
    case 'NamedNode': return `<${term.value}>`;
    case 'BlankNode': return `_:${term.value}`;
    case 'Variable': return `?${term.value}`;
    case 'DefaultGraph': return 'default graph';
    case 'Literal': {
      const lexical = JSON.stringify(term.value);
      if (term.language)
        return `${lexical}@${term.language}${term.direction ? `--${term.direction}` : ''}`;
      return term.datatype.value === XSD_STRING ? lexical : `${lexical}^^<${term.datatype.value}>`;
    }
    case 'Quad': return `<<( ${show(term.subject)} ${show(term.predicate)} ${show(term.object)} )>>`;
    default: return term.value;
  }
}

// --- the page

const $ = id => document.getElementById(id);
const formatSelect = $('format'), exampleSelect = $('example'), baseInput = $('base');
const results = $('results'), status = $('status');

for (const [label, value] of Object.entries(FORMATS))
  formatSelect.add(new Option(label, value));
EXAMPLES.forEach((example, i) => exampleSelect.add(new Option(example.name, i)));

// ?data=<document> pre-fills the editor; ?format=<media type> picks the syntax
const params = new URLSearchParams(location.search);
if ([...formatSelect.options].some(option => option.value === params.get('format')))
  formatSelect.value = params.get('format');

let pinned = null;          // regions that stay lit when the mouse leaves
let chips = [];             // { element, from, to } for editor -> result lookup
let parseTimer;

const view = new EditorView({
  parent: $('editor'),
  doc: params.has('data') ? params.get('data') : EXAMPLES[0].doc,
  extensions: [
    basicSetup,
    StreamLanguage.define(turtle),
    hover.field,
    problem.field,
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        clearTimeout(parseTimer);
        parseTimer = setTimeout(reparse, 150);
      }
    }),
    EditorView.domEventHandlers({
      mousemove(event, editor) {
        const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
        for (const { element, from, to } of chips)
          element.classList.toggle('reverse', pos !== null && pos >= from && pos < to);
      },
      mouseleave() {
        for (const { element } of chips)
          element.classList.remove('reverse');
      },
    }),
  ],
});

function release() {
  pinned = null;
  document.querySelectorAll('.pinned').forEach(element => element.classList.remove('pinned'));
  highlight(view, []);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className)
    node.className = className;
  if (text !== undefined)
    node.textContent = text;
  return node;
}

// Wire an element to light up `regions` on hover and to pin them on click. A
// term sits inside its utterance row: mouseover on the term wins (it stops
// the event), and over the rest of the row the row's own regions show again.
function link(node, regions, { container = false } = {}) {
  node.addEventListener('mouseover', event => {
    event.stopPropagation();
    highlight(view, regions, { scroll: true });
  });
  if (container)
    node.addEventListener('mouseleave', () => highlight(view, pinned ? pinned.regions : []));
  node.addEventListener('click', event => {
    event.stopPropagation();
    const again = pinned && pinned.node === node;
    release();
    if (!again) {
      pinned = { node, regions };
      node.classList.add('pinned');
      highlight(view, regions);
    }
  });
}

function renderTerm(quad, occurrence, component) {
  const range = occurrence[component];
  const term = quad[component];
  if (component === 'graph' && !range && term.termType === 'DefaultGraph')
    return null;
  const node = element('span', `term ${component}`, show(term));
  if (!range) {
    node.classList.add('spanless');
    node.title = 'generated: no source text';
    return node;
  }
  node.classList.add('spanned');
  const doc = view.state.doc, { from, to } = toOffsets(doc, range);
  node.title = doc.sliceString(from, to);
  chips.push({ element: node, from, to });
  link(node, [{ range, component }]);
  node.addEventListener('mouseleave', () => highlight(view, pinned ? pinned.regions : []));
  return node;
}

function render(provenance, parseMs) {
  results.replaceChildren();
  chips = [];
  let quads = 0, utterances = 0;
  for (const [quad, occurrences] of provenance) {
    quads++;
    utterances += occurrences.length;
    const card = element('div', 'quad');
    const head = element('div', 'quad-head');
    head.append(element('span', '', `quad ${quads}`),
      element('span', '', `${occurrences.length} utterance${occurrences.length === 1 ? '' : 's'}`));
    card.append(head);
    occurrences.forEach((occurrence, n) => {
      const row = element('div', 'utterance');
      row.append(element('span', 'n', `#${n + 1}`));
      for (const component of COMPONENTS) {
        const node = renderTerm(quad, occurrence, component);
        if (node)
          row.append(node);
      }
      const regions = COMPONENTS.filter(c => occurrence[c]).map(c => ({ range: occurrence[c], component: c }));
      link(row, regions, { container: true });
      card.append(row);
    });
    results.append(card);
  }
  status.textContent =
    `${quads} distinct quad${quads === 1 ? '' : 's'}, ${utterances} utterance${utterances === 1 ? '' : 's'} (${parseMs.toFixed(1)} ms)`;
}

function reparse() {
  release();
  const text = view.state.doc.toString();   // what the highlight offsets are computed against
  view.dispatch({ effects: problem.effect.of(Decoration.none) });
  try {
    const started = performance.now();
    const { provenance } = new ProvenanceParser({
      baseIRI: baseInput.value || undefined,
      format: formatSelect.value,
      blankNodePrefix: '',
    }).parse(text);
    render(provenance, performance.now() - started);
  }
  catch (error) {
    results.replaceChildren(element('pre', 'error', error.message));
    status.textContent = 'parse error';
    chips = [];
    const line = error.context && error.context.line;
    if (line >= 1 && line <= view.state.doc.lines) {
      const info = view.state.doc.line(line);
      if (info.to > info.from)
        view.dispatch({ effects: problem.effect.of(Decoration.set([Decoration.mark({ class: 'hl-error' }).range(info.from, info.to)])) });
    }
  }
}

function loadExample() {
  const example = EXAMPLES[exampleSelect.value];
  formatSelect.value = example.format;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: example.doc } });
}

exampleSelect.addEventListener('change', loadExample);
formatSelect.addEventListener('change', reparse);
baseInput.addEventListener('input', () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(reparse, 150);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape')
    release();
});
document.addEventListener('click', release);

reparse();
