"use strict";

/**
 * Incremental Search Index — intermediate example
 *
 * Implements a lightweight, in-process full-text search index for a live
 * collection of tagged notes. "Incremental" means notes can be added,
 * updated, or removed at any time — the index always reflects the current
 * state without needing a full rebuild.
 *
 * Scoring model (transparent by design so it is easy to explain on screen):
 *   +2 points per query token matched in the note body  (text hit)
 *   +1 point  per query token matched in the note's tags (tag hit)
 *
 * Text matches score higher than tag matches because the body usually
 * contains richer, more specific content than a short label does.
 *
 * Search pipeline for every query:
 *   1. Tokenize the query into lowercase, punctuation-stripped words.
 *   2. Score every note in the index against those tokens.
 *   3. Discard notes with a score of 0 (no token overlap with the query).
 *   4. Sort survivors by descending score so the best match is first.
 *   5. Return up to `limit` results, each including a contextual snippet.
 */
class NoteSearchIndex {
  constructor() {
    // A Map gives us O(1) lookups, inserts, and deletes by note id, which
    // is cleaner than managing an array and scanning for the right index.
    this.notes = new Map();
  }

  /**
   * Insert a new note or fully overwrite an existing one with the same id.
   * Calling this with an existing id is a safe in-place update — it's how
   * the index stays current when a note's content or tags change over time.
   *
   * @param {string}   id       - Unique identifier for the note (e.g. "note-42").
   * @param {string}   text     - Full body text of the note.
   * @param {string[]} [tags=[]] - Short category labels (e.g. ["js", "async"]).
   */
  addOrUpdateNote(id, text, tags = []) {
    if (!id || typeof id !== "string") {
      throw new Error("id must be a non-empty string");
    }
    if (typeof text !== "string") {
      throw new Error("text must be a string");
    }
    if (!Array.isArray(tags)) {
      throw new Error("tags must be an array");
    }

    // Normalise tags once at insert time so every search comparison is just a
    // simple lowercase string equality check — no repeated conversion later.
    const normalizedTags = tags
      .map((tag) => String(tag).toLowerCase().trim())
      .filter(Boolean);

    this.notes.set(id, { id, text, tags: normalizedTags });
  }

  /**
   * Remove a note from the index permanently. The next search will no longer
   * consider this note regardless of how well it might have scored.
   *
   * @param {string} id
   * @returns {boolean} true if the note existed and was removed, false otherwise.
   */
  removeNote(id) {
    return this.notes.delete(id);
  }

  /**
   * Search the index and return ranked results for the given free-form query.
   *
   * @param {string} query     - Search text; tokenized internally before matching.
   * @param {number} [limit=5] - Maximum number of results to include.
   * @returns {Array<{id: string, score: number, tags: string[], snippet: string}>}
   *   Sorted by score descending. Each entry includes a short text snippet
   *   centred on the first matching token to help users verify relevance.
   */
  search(query, limit = 5) {
    const queryTokens = tokenize(query);
    // Bail early if the query produces no usable tokens (e.g. only punctuation)
    // rather than scoring every note against an empty token list.
    if (queryTokens.length === 0) {
      return [];
    }

    const ranked = [];
    // Walk every note, compute its score, and keep those with at least one hit.
    for (const note of this.notes.values()) {
      const score = this.computeScore(note, queryTokens);
      if (score > 0) {
        ranked.push({
          id: note.id,
          score,
          tags: note.tags,
          snippet: buildSnippet(note.text, queryTokens)
        });
      }
    }

    // Sort descending so the most relevant note leads the result list.
    ranked.sort((a, b) => b.score - a.score);
    // Clamp slice to at least 1 to guard against callers passing limit=0.
    return ranked.slice(0, Math.max(1, limit));
  }

  /**
   * Calculate a numeric relevance score for a single note given the
   * tokenized query. Higher numbers indicate a stronger match.
   *
   * Scoring rationale:
   *   Body text hit (+2): the note actively discusses this concept in prose.
   *   Tag hit (+1): the note is labelled with the keyword, but may only
   *     reference it briefly — hence the lower weight.
   *
   * Sets are used for O(1) membership tests instead of iterating arrays on
   * every token, keeping the inner loop fast for large corpora.
   *
   * @param {{ text: string, tags: string[] }} note
   * @param {string[]} queryTokens
   * @returns {number}
   */
  computeScore(note, queryTokens) {
    // Build lookup sets once per note so each token test is O(1).
    const textTokenSet = new Set(tokenize(note.text));
    const tagSet       = new Set(note.tags);
    let score = 0;

    for (const token of queryTokens) {
      if (textTokenSet.has(token)) {
        score += 2; // Strong signal — concept appears in the note body.
      }
      if (tagSet.has(token)) {
        score += 1; // Weaker signal — note is simply labelled with this term.
      }
    }

    return score;
  }
}

/**
 * Break a string into lowercase, alphanumeric tokens by collapsing any
 * non-word character to a space and splitting on whitespace runs. Filters
 * out empty strings so callers never have to guard against blank tokens.
 *
 * Examples:
 *   tokenize("Hello, World!")  → ["hello", "world"]
 *   tokenize("async/await")    → ["async", "await"]
 *
 * @param {string} value
 * @returns {string[]}
 */
function tokenize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // Collapse punctuation and special chars.
    .split(/\s+/)                  // Split on one or more whitespace chars.
    .filter(Boolean);              // Remove empty strings from leading/trailing spaces.
}

/**
 * Extract a short passage from the note body centred around the position of
 * the first matching query token. This gives users a preview showing *why*
 * the note matched rather than just the opening of the note.
 *
 * Up to 20 characters before the match are included for context, and up to
 * 70 characters after so the matched word appears near the start of the clip.
 *
 * Falls back to the first 90 characters when no token position can be found
 * (which should not occur in normal flow, but guards against purely tag-based
 * matches where the token isn't present in the body text at all).
 *
 * @param {string}   text
 * @param {string[]} queryTokens
 * @returns {string}
 */
function buildSnippet(text, queryTokens) {
  const lower = text.toLowerCase();
  for (const token of queryTokens) {
    const index = lower.indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 20);
      const end   = Math.min(text.length, index + 70);
      return text.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  // Fallback: show the opening of the note if no body position was found.
  return text.slice(0, 90).replace(/\s+/g, " ").trim();
}

/**
 * Multi-step demo exercising the full lifecycle of the index:
 *   - Populating a varied corpus of six notes across different topics.
 *   - Running several queries to show how scoring separates results.
 *   - Updating an existing note in place and verifying search reflects it.
 *   - Removing a note and confirming it disappears from subsequent results.
 *   - A tag-only query that matches notes via labels, not body text.
 */
function demoSearch() {
  const index = new NoteSearchIndex();

  // ── Populate the index with a varied set of notes ──────────────────────
  index.addOrUpdateNote(
    "n1",
    "Build a JavaScript task runner that handles retries, logs errors, and supports parallel execution.",
    ["javascript", "backend", "jobs", "async"]
  );
  index.addOrUpdateNote(
    "n2",
    "Prepare portfolio video and explain source code clearly in the recording. Practice speaking aloud.",
    ["portfolio", "video", "interview", "presentation"]
  );
  index.addOrUpdateNote(
    "n3",
    "Write a search feature that ranks matching notes by a simple relevance score using token frequency.",
    ["search", "javascript", "feature", "ranking"]
  );
  index.addOrUpdateNote(
    "n4",
    "Review async patterns in JavaScript: promises, async/await, and error propagation with try/catch.",
    ["javascript", "async", "promises", "backend"]
  );
  index.addOrUpdateNote(
    "n5",
    "Set up a CI/CD pipeline to auto-run tests and deploy on every push to the main branch.",
    ["devops", "ci", "deployment", "backend"]
  );
  index.addOrUpdateNote(
    "n6",
    "Experiment with CSS grid layouts and responsive breakpoints for the portfolio landing page.",
    ["css", "frontend", "portfolio", "design"]
  );

  // ── Query 1: multi-word query that scores different notes differently ───
  console.log("─── Query: 'javascript async' (top 3) ───");
  console.table(index.search("javascript async", 3));

  // ── Query 2: single keyword that appears in both text and tags ──────────
  console.log("\n─── Query: 'portfolio' (top 3) ───");
  console.table(index.search("portfolio", 3));

  // ── Query 3: topic spanning multiple notes at varying depths ───────────
  console.log("\n─── Query: 'backend jobs' (top 4) ───");
  console.table(index.search("backend jobs", 4));

  // ── Update n2: revised wording and a new tag; re-run to see the change ─
  console.log("\n─── Updating note n2 (adding 'javascript' tag + new body) ───");
  index.addOrUpdateNote(
    "n2",
    "Prepare portfolio video and explain JavaScript source code clearly. Show live coding segments.",
    ["portfolio", "video", "interview", "javascript"]
  );
  console.log("n2 updated. Re-running 'javascript async' query:");
  console.table(index.search("javascript async", 3));

  // ── Remove n5 and confirm it no longer appears in results ───────────────
  console.log("\n─── Removing note n5 (CI/CD pipeline) ───");
  const removed = index.removeNote("n5");
  console.log(`removeNote("n5") returned: ${removed}`);
  console.log("'backend' results after removal (n5 should be absent):");
  console.table(index.search("backend", 5));

  // ── Edge case: query that would only match via tags on remaining notes ──
  console.log("\n─── Query: 'devops' (n5 gone — should return nothing) ───");
  const devopsResults = index.search("devops", 3);
  console.log(devopsResults.length === 0 ? "No results (expected)." : devopsResults);
}

if (require.main === module) {
  demoSearch();
}

module.exports = { NoteSearchIndex };
