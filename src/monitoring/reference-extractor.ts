/**
 * Reference Extractor - transcript artifact-reference scanning.
 *
 * A single pure function, {@link extractReferences}, that scans the body of
 * every {@link TranscriptSection} and surfaces the concrete artifacts a run
 * claims to have touched: commit SHAs, file paths, URLs, and PR/issue numbers.
 * Each hit is returned as a typed {@link TranscriptReference} tagged with the
 * section slug it was found in, so downstream Tier 1 verifiers can spot-check
 * that a referenced artifact actually exists (the file is on disk, the URL
 * resolves, the commit is real).
 *
 * Why a separate module? Reference scanning is a distinct concern from section
 * parsing - it is a bundle of independent, individually-fiddly regexes (URL
 * boundary trimming, the `#1234` PR/issue form, the 7-40 hex commit-SHA window
 * with its all-zeros guard, backtick-quoted paths, and bare paths recognised
 * only by a known extension) plus the `looksLikePath` heuristic that keeps
 * SHAs and URLs from being mis-tagged as files. Isolating it here keeps
 * `transcript-reader.ts` focused on the section/outcome/duration structure and
 * gives this self-contained pattern bank its own home and its own direct test
 * suite. The parser re-exports {@link extractReferences}, so the public import
 * path off `transcript-reader.js` is unchanged.
 *
 * No AI, no network, no clock dependence. Same input => same output, always.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { TranscriptReference, TranscriptSection } from './types.js';

/**
 * Surface commit SHAs, file paths, URLs, PR/issue links from anywhere in the
 * transcript. Used by downstream Tier 1 verifiers to spot-check that
 * referenced artifacts actually exist.
 */
export function extractReferences(sections: readonly TranscriptSection[]): TranscriptReference[] {
  const out: TranscriptReference[] = [];
  const seen = new Set<string>();

  const add = (kind: TranscriptReference['kind'], value: string, section: string): void => {
    const key = `${kind}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value, section });
  };

  for (const s of sections) {
    const slug = s.slug;
    const body = s.body;
    if (!body) continue;

    // URLs (with optional surrounding markdown link).
    for (const m of body.matchAll(/https?:\/\/[^\s<>'`)\]]+/g)) {
      const v = (m[0] ?? '').replace(/[.,;:!?)]+$/, '');
      if (v) add('url', v, slug);
    }

    // PR/issue references like #1234 - common in repo-related transcripts.
    for (const m of body.matchAll(/(?:^|[^\w])#(\d{2,7})\b/g)) {
      add('issue', `#${m[1]}`, slug);
    }

    // Commit SHAs - 7-40 hex chars, surrounded by word boundaries / backticks.
    for (const m of body.matchAll(/(?:^|[^A-Fa-f0-9`])`?([0-9a-f]{7,40})`?(?=\b)/g)) {
      const sha = (m[1] ?? '').toLowerCase();
      // Filter out obvious false positives (e.g. all zeros).
      if (/^0+$/.test(sha)) continue;
      add('commit', sha, slug);
    }

    // Backtick-quoted file paths and bare paths with extensions.
    for (const m of body.matchAll(/`([^`\n]{1,160})`/g)) {
      const v = (m[1] ?? '').trim();
      if (looksLikePath(v)) add('file', v, slug);
    }
    for (const m of body.matchAll(/(?:^|\s)([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|md|json|yml|yaml|py|cs|csproj|mjs|sql|sh|toml|html|css))(?=\s|[.,;:)]|$)/g)) {
      const v = (m[1] ?? '').trim();
      if (looksLikePath(v)) add('file', v, slug);
    }
  }
  return out;
}

/**
 * Heuristic guard for the file-reference patterns: accepts a token only when
 * it structurally resembles a path (contains a separator or ends in a short
 * extension) and is not something another pattern already owns (a URL or a
 * bare commit SHA). Keeps `extractReferences` from mis-tagging those as files.
 */
export function looksLikePath(s: string): boolean {
  if (!s || s.length > 200) return false;
  if (s.includes(' ')) return false;
  if (/^https?:/i.test(s)) return false;
  if (/^[0-9a-f]{7,40}$/i.test(s)) return false; // sha
  if (s.includes('/') || s.includes('\\') || /\.[a-z0-9]{1,8}$/i.test(s)) return true;
  return false;
}
