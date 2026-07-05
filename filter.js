// oxy-chat-relay/filter.js
// Server-authoritative content moderation for the global chat.
//
// Two jobs:
//   1. Block hard-banned content (racial slurs, CSAM terms) — message is REJECTED.
//   2. Block links / discord invites — message is REJECTED with a reason.
//   3. Soft profanity is masked (****) rather than rejected, so people can still talk.
//
// Everything is leet-normalized first so "n1 g g 3 r" collapses to "nigger" before
// the blocklist runs. The client runs a lighter copy of this for instant feedback,
// but THIS file is the source of truth — never trust the client.

// ---------------------------------------------------------------- leet map
// Each entry maps a canonical letter to the set of characters people substitute for it.
const LEET = {
  a: "a4@\\^",
  b: "b8",
  c: "c(<{[",
  d: "d",
  e: "e3&",
  f: "f",
  g: "g69",
  h: "h#",
  i: "i1!| y",     // 'y' catches niggy-style, kept loose
  j: "j",
  k: "k",
  l: "l1|",
  m: "m",
  n: "n",
  o: "o0()",
  p: "p",
  q: "q9",
  r: "r",
  s: "s5$z",
  t: "t7+",
  u: "uv",
  v: "v",
  w: "w",
  x: "x",
  y: "y",
  z: "z2",
};

// Build a regex that matches `word` even when letters are repeated, leet-substituted,
// or separated by spaces / punctuation. e.g. buildLoose("cp") -> /c+[\W_0-9]*p+/i-ish
function buildLoose(word) {
  const parts = [];
  for (const ch of word.toLowerCase()) {
    const set = LEET[ch];
    if (set) {
      // escape regex-special chars inside the class
      const cls = set.replace(/[\\\]\^\-]/g, "\\$&").replace(/\s+/g, "");
      parts.push(`[${cls}]+`);
    } else {
      parts.push(word === word ? ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "+" : ch);
    }
  }
  // allow separators (spaces, punctuation, zero-width) between letters
  return parts.join("[\\s\\W_]*");
}

function makeMatcher(words, { boundary = true } = {}) {
  const alts = words.map(buildLoose).join("|");
  const body = boundary ? `(?<![a-z0-9])(?:${alts})` : `(?:${alts})`;
  return new RegExp(body, "i");
}

// ---------------------------------------------------------------- word lists
// HARD BAN — message is rejected outright. Kept intentionally short and specific.
const SLURS = [
  "nigger", "nigga", "niger", "negro",
  "faggot", "fag",
  "retard", "retarded",
  "chink", "gook", "spic", "kike", "coon", "tranny", "beaner", "wetback",
  "paki", "dyke",
];

// CSAM / child-sexual content — hardest ban, also flagged for logging.
// Matched as combinations so single innocent words ("child", "kid") don't trip it.
const CSAM_PATTERNS = [
  makeMatcher(["childporn", "childp0rn", "kiddieporn", "kidporn"], { boundary: false }),
  makeMatcher(["cp"], { boundary: true }), // standalone "cp" only (boundary-guarded)
  // "child" / "minor" / "kid" / "loli" near a sexual term
  /(?<![a-z0-9])(?:child|minor|kids?|toddler|preteen|underage|loli|shota)\b[\s\W_]{0,6}(?:p[o0]rn|nudes?|sex|nsfw|cp|rape)/i,
  /(?:p[o0]rn|nudes?|sex|nsfw)\b[\s\W_]{0,6}(?:child|minor|kids?|toddler|preteen|underage|loli|shota)/i,
  makeMatcher(["pedophile", "pedo", "paedo"], { boundary: true }),
];

// SOFT — masked with **** but the message still sends.
const PROFANITY = [
  "fuck", "shit", "bitch", "cunt", "asshole", "bastard", "dick", "pussy",
  "whore", "slut", "cock", "wanker",
];

const SLUR_RE = makeMatcher(SLURS, { boundary: true });
const PROFANITY_RE = new RegExp(makeMatcher(PROFANITY, { boundary: true }).source, "ig");

// ---------------------------------------------------------------- link detection
const LINK_RES = [
  /\bhttps?:\/\/\S+/i,                                   // http(s)://...
  /\bwww\.\S+/i,                                         // www...
  /\bdiscord(?:\.gg|app\.com|\.com)\/\S+/i,              // discord invites
  /\b(?:dsc|dis)\.gg\/\S+/i,                             // discord shorteners
  /\b[a-z0-9][a-z0-9-]{1,}\.(?:com|net|org|gg|io|xyz|me|tv|co|ru|link|shop|store|site|club|fun|app|dev|gg)\b(?:\/\S*)?/i,
  /\bt\.me\/\S+/i,                                       // telegram
  /\b(?:steamcommunity|robux|freerobux)\S*\.\S+/i,       // common scam bait
];

function hasLink(text) {
  return LINK_RES.some((re) => re.test(text));
}

// ---------------------------------------------------------------- public API
// moderate(text) -> { ok, text, reason }
//   ok=false  -> reject, `reason` is a short user-facing string
//   ok=true   -> `text` is the (possibly masked) message to broadcast
function moderate(rawText) {
  const text = String(rawText == null ? "" : rawText).trim();

  if (text.length === 0) return { ok: false, reason: "empty message" };
  if (text.length > 200) return { ok: false, reason: "message too long (max 200)" };

  // 1. CSAM — hardest ban
  for (const re of CSAM_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, reason: "message blocked", flag: "csam" };
    }
  }

  // 2. Slurs — rejected
  if (SLUR_RE.test(text)) {
    return { ok: false, reason: "that word isn't allowed here" };
  }

  // 3. Links — rejected
  if (hasLink(text)) {
    return { ok: false, reason: "links aren't allowed in chat" };
  }

  // 4. Soft profanity — masked
  const cleaned = text.replace(PROFANITY_RE, (m) => "*".repeat(m.length));

  return { ok: true, text: cleaned };
}

// moderateName(name) -> { ok, name, reason }
// Names are stricter: no links, no slurs, no profanity, no CSAM. Length 1..18.
function moderateName(rawName) {
  const name = String(rawName == null ? "" : rawName).trim().replace(/\s+/g, " ");

  if (name.length === 0) return { ok: false, reason: "name is empty" };
  if (name.length > 18) return { ok: false, reason: "name too long (max 18)" };
  // printable-only: letters, numbers, spaces, and a few safe symbols
  if (!/^[\w \-.!?~*<>|]+$/.test(name)) {
    return { ok: false, reason: "name has invalid characters" };
  }
  for (const re of CSAM_PATTERNS) {
    if (re.test(name)) return { ok: false, reason: "name blocked" };
  }
  if (SLUR_RE.test(name)) return { ok: false, reason: "name contains a banned word" };
  if (new RegExp(PROFANITY_RE.source, "i").test(name)) {
    return { ok: false, reason: "name contains profanity" };
  }
  if (hasLink(name)) return { ok: false, reason: "name can't contain a link" };

  return { ok: true, name };
}

module.exports = { moderate, moderateName, hasLink };
