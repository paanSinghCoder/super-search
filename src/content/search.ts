import { HL_OVERLAY_ID, PANEL_ID, SKIP_INPUT_TYPES } from "../shared/constants";
import type { Match, SearchIndex, SearchOpts, TextSegment } from "../shared/types";
import type { ContentScriptApp } from "./app";
import { isVisible } from "./dom";

function collectShadowRoots(root: Element, roots: Set<Node>): void {
  if (root.shadowRoot) {
    roots.add(root.shadowRoot);
    for (const child of root.shadowRoot.children) collectShadowRoots(child, roots);
  }
  for (const child of root.children) collectShadowRoots(child, roots);
}

function collectSearchRoots(scopeRange: Range | null): Node[] {
  const roots = new Set<Node>();
  const base = scopeRange
    ? scopeRange.commonAncestorContainer.nodeType === 1
      ? (scopeRange.commonAncestorContainer as Element)
      : scopeRange.commonAncestorContainer.parentElement
    : document.body;
  if (base) {
    roots.add(base);
    if (base.nodeType === 1) collectShadowRoots(base, roots);
  }
  return [...roots];
}

function rangeIntersects(a: Range, b: Range): boolean {
  return (
    a.compareBoundaryPoints(Range.END_TO_START, b) < 0 &&
    a.compareBoundaryPoints(Range.START_TO_END, b) > 0
  );
}

function collectTextNodes(app: ContentScriptApp, scopeRange: Range | null): Text[] {
  const nodes: Text[] = [];
  for (const root of collectSearchRoots(scopeRange)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const parent = n.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(`#${PANEL_ID}, #${HL_OVERLAY_ID}`)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(app, parent)) return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (scopeRange) {
        const r = document.createRange();
        try {
          r.selectNode(n);
        } catch {
          continue;
        }
        if (!rangeIntersects(r, scopeRange)) continue;
      }
      nodes.push(n as Text);
    }
  }
  return nodes;
}

function buildSearchIndex(app: ContentScriptApp, scopeRange: Range | null): SearchIndex {
  const nodes = collectTextNodes(app, scopeRange);
  const segments: TextSegment[] = [];
  let full = "";
  for (const node of nodes) {
    let start = 0;
    let end = node.nodeValue?.length ?? 0;
    if (scopeRange) {
      if (node === scopeRange.startContainer) start = scopeRange.startOffset;
      if (node === scopeRange.endContainer) end = scopeRange.endOffset;
    }
    const text = node.nodeValue?.slice(start, end) ?? "";
    if (!text) continue;
    segments.push({
      node,
      nodeStart: start,
      startInFull: full.length,
      endInFull: full.length + text.length,
    });
    full += text;
  }
  return { full, segments };
}

export function buildRegex(query: string, opts: SearchOpts): RegExp | null {
  if (!query) return null;
  let pattern = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) pattern = `(?:^|\\b)(?:${pattern})(?:\\b|$)`;
  const flags = opts.matchCase ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function findRangesWithRegex(app: ContentScriptApp, regex: RegExp): Range[] {
  const scope = app.state.findInSelection && app.state.selectionRange ? app.state.selectionRange : null;
  const { full, segments } = buildSearchIndex(app, scope);
  if (!full) return [];

  const ranges: Range[] = [];
  let m: RegExpExecArray | null;
  let segPtr = 0;
  while ((m = regex.exec(full)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    while (segPtr < segments.length && segments[segPtr].endInFull <= start) segPtr++;
    const startSeg = segments[segPtr];
    let endSegIdx = segPtr;
    while (endSegIdx < segments.length && segments[endSegIdx].endInFull < end) endSegIdx++;
    const endSeg = segments[endSegIdx];
    if (!startSeg || !endSeg) break;
    try {
      const r = document.createRange();
      r.setStart(startSeg.node, startSeg.nodeStart + (start - startSeg.startInFull));
      r.setEnd(endSeg.node, endSeg.nodeStart + (end - endSeg.startInFull));
      ranges.push(r);
    } catch {
      // Skip invalid ranges.
    }
  }
  return ranges;
}

function collectFields(scopeRange: Range | null): (HTMLInputElement | HTMLTextAreaElement)[] {
  const fields: (HTMLInputElement | HTMLTextAreaElement)[] = [];
  const seen = new Set<HTMLInputElement | HTMLTextAreaElement>();
  for (const root of collectSearchRoots(scopeRange)) {
    if (!(root instanceof Element) || !root.querySelectorAll) continue;
    for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
      if (!seen.has(el)) {
        seen.add(el);
        fields.push(el);
      }
    }
  }
  return fields;
}

function findFieldMatchesWithRegex(app: ContentScriptApp, regex: RegExp): Match[] {
  if (app.state.findInSelection) return [];
  const out: Match[] = [];
  for (const el of collectFields(null)) {
    if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(el.type)) continue;
    if (el.closest(`#${PANEL_ID}, #${HL_OVERLAY_ID}`)) continue;
    if (!isVisible(app, el)) continue;
    const value = el.value;
    if (!value) continue;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(value)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      let anchorRange: Range | null = null;
      try {
        anchorRange = document.createRange();
        anchorRange.selectNode(el);
      } catch {
        // Skip if range cannot be created.
      }
      out.push({
        type: "field",
        element: el,
        start: m.index,
        end: m.index + m[0].length,
        anchorRange,
      });
    }
  }
  return out;
}

function compareMatchPosition(a: Match, b: Match): number {
  const ra = a.type === "range" ? a.range : a.anchorRange;
  const rb = b.type === "range" ? b.range : b.anchorRange;
  if (!ra || !rb) return 0;
  try {
    return ra.compareBoundaryPoints(Range.START_TO_START, rb);
  } catch {
    return 0;
  }
}

export function runLocalSearch(app: ContentScriptApp, opts: { preserveLocalIndex?: boolean } = {}): void {
  app.visibilityCache = new WeakMap();
  const prevLocal = opts.preserveLocalIndex ? app.state.currentLocalIndex : -1;
  const { state } = app;

  const regex = buildRegex(state.query, state);
  if (!regex) {
    if (state.query) app.ui?.findWrap.classList.add("invalid");
    state.matches = [];
    state.currentLocalIndex = -1;
    app.applyHighlights();
    return;
  }
  app.ui?.findWrap.classList.remove("invalid");

  const ranges = findRangesWithRegex(app, regex);
  const fields = findFieldMatchesWithRegex(app, regex);

  const out: Match[] = ranges.map((r) => ({ type: "range", range: r }));
  out.push(...fields);
  out.sort(compareMatchPosition);

  state.matches = out;
  if (opts.preserveLocalIndex && prevLocal >= 0 && out.length) {
    state.currentLocalIndex = Math.min(prevLocal, out.length - 1);
  } else {
    state.currentLocalIndex = out.length ? 0 : -1;
  }
  app.applyHighlights();
}
