// oxy-chat-relay/gradients.js
// Tag COLOR and EFFECT are now independent. The relay is color-agnostic (the client
// holds the actual RGB); here we only gate each id by role rank.
//
// Role hierarchy: owner (3) > staff (2) > vip (1) > member (0)

const ROLE_RANK = { member: 0, vip: 1, staff: 2, owner: 3 };

// colorId -> minRank
const COLORS = {
  ocean: 0, milkyblue: 0, aquamint: 0, sky: 0, lime: 0, coral: 0, bubblegum: 0,
  golden: 0, lavender: 0, jade: 0, rosegold: 0, mono: 0,
  amethyst: 1, ember: 1, magenta: 1, aurora: 1, glacier: 1,
  solar: 2, sapphire: 2, platinum: 2,
  crimson: 3, prismatic: 3, galaxy: 3,
};

// effectId -> minRank
const EFFECTS = {
  none: 0, glow: 0, wave: 0, breathe: 0,
  sparkle: 1, milky: 1,
  shimmer: 2,
  rainbow: 3,
};

const DEFAULT_COLOR = "ocean";
const DEFAULT_EFFECT = "none";

function rankOf(role) { return ROLE_RANK[role] != null ? ROLE_RANK[role] : 0; }
function allowedFrom(map, role) { const r = rankOf(role); return Object.keys(map).filter((id) => map[id] <= r); }
function allowedColors(role) { return allowedFrom(COLORS, role); }
function allowedEffects(role) { return allowedFrom(EFFECTS, role); }
function resolveColor(id, role) { return (COLORS[id] != null && rankOf(role) >= COLORS[id]) ? id : DEFAULT_COLOR; }
function resolveEffect(id, role) { return (EFFECTS[id] != null && rankOf(role) >= EFFECTS[id]) ? id : DEFAULT_EFFECT; }

module.exports = {
  ROLE_RANK, COLORS, EFFECTS, DEFAULT_COLOR, DEFAULT_EFFECT,
  rankOf, allowedColors, allowedEffects, resolveColor, resolveEffect,
};
