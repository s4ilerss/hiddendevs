"use strict";

/**
 * this script implements a simple search index for notes.
 * the scoring is intentionally simple:
 * - +2 points for each query token found in text
 * - +1 point for each query token found in tags
 * easy scoring makes the output easy to explain in a recording
 */
class NoteSearchIndex {
  constructor() {
    // Map keeps add/update/remove by id quick and simple.
    this.notes = new Map();
  }

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

    // Normalize once so search is case-insensitive later.
    const normalizedTags = tags.map((tag) => String(tag).toLowerCase().trim()).filter(Boolean);
    this.notes.set(id, { id, text, tags: normalizedTags });
  }

  removeNote(id) {
    return this.notes.delete(id);
  }

  search(query, limit = 5) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const ranked = [];
    // Score each note and keep only the ones that actually match.
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

    // Higher score = better match.
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, Math.max(1, limit));
  }

  computeScore(note, queryTokens) {
    const textTokens = tokenize(note.text);
    const textTokenSet = new Set(textTokens);
    const tagSet = new Set(note.tags);
    let score = 0;

    // Straightforward scoring rule:
    // text hit = 2 points, tag hit = 1 point.
    for (const token of queryTokens) {
      if (textTokenSet.has(token)) {
        score += 2;
      }
      if (tagSet.has(token)) {
        score += 1;
      }
    }

    return score;
  }
}

function tokenize(value) {
  // Basic tokenizer is enough for this demo.
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildSnippet(text, queryTokens) {
  const lower = text.toLowerCase();
  // Grab a short snippet around the first matching word.
  for (const token of queryTokens) {
    const index = lower.indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 20);
      const end = Math.min(text.length, index + 70);
      return text.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return text.slice(0, 90).replace(/\s+/g, " ").trim();
}

function demoSearch() {
  const index = new NoteSearchIndex();

  index.addOrUpdateNote(
    "n1",
    "Build a JavaScript task runner that handles retries and logs errors.",
    ["javascript", "backend", "jobs"]
  );
  index.addOrUpdateNote(
    "n2",
    "Prepare portfolio video and explain source code clearly in the recording.",
    ["portfolio", "video", "interview"]
  );
  index.addOrUpdateNote(
    "n3",
    "Write a search feature that ranks matching notes by simple score.",
    ["search", "javascript", "feature"]
  );

  // Query words overlap with different notes/tags so ranking is visible.
  const results = index.search("javascript search video", 3);
  console.log("Search results:");
  console.table(results);
}

if (require.main === module) {
  demoSearch();
}

module.exports = { NoteSearchIndex };
