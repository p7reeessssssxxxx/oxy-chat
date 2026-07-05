// oxy-chat-relay/gradients.js
// The gradient-tag registry, shared authority for what each role may use.
// The CLIENT has its own copy of the actual RGB colours + effect renderers;
// the server only needs the ids, which role unlocks them, and the effect name
// (so it can stamp the broadcast and reject/downgrade locked picks).
//
// Role hierarchy (higher rank = everything below it too):
//   owner (3) > staff (2) > vip (1) > member (0)

const ROLE_RANK = { member: 0, vip: 1, staff: 2, owner: 3 };

// id -> { minRank, effect }
// effect is what the client animates: none | glow | rainbow | sparkle | pulse
const GRADIENTS = {
  // ---- basic: everyone (minRank 0) ----
  ocean:  { minRank: 0, effect: "none" },
  toxic:  { minRank: 0, effect: "none" },
  fire:   { minRank: 0, effect: "none" },
  sunset: { minRank: 0, effect: "none" },
  grape:  { minRank: 0, effect: "none" },
  mono:   { minRank: 0, effect: "none" },

  // ---- vip unlocks (minRank 1) ----
  aqua:   { minRank: 1, effect: "glow" },
  prism:  { minRank: 1, effect: "sparkle" },

  // ---- staff unlocks (minRank 2) ----
  gold:   { minRank: 2, effect: "glow" },

  // ---- owner unlocks (minRank 3) ----
  rainbow: { minRank: 3, effect: "rainbow" },
};

const DEFAULT_GRADIENT = "ocean";

function rankOf(role) {
  return ROLE_RANK[role] != null ? ROLE_RANK[role] : 0;
}

// What gradient ids may this role use?
function allowedGradients(role) {
  const r = rankOf(role);
  return Object.keys(GRADIENTS).filter((id) => GRADIENTS[id].minRank <= r);
}

// Resolve a requested gradient for a role. If they can't use it, fall back to
// the default. Returns { id, effect }.
function resolveGradient(requestedId, role) {
  const g = GRADIENTS[requestedId];
  if (g && rankOf(role) >= g.minRank) {
    return { id: requestedId, effect: g.effect };
  }
  return { id: DEFAULT_GRADIENT, effect: GRADIENTS[DEFAULT_GRADIENT].effect };
}

module.exports = { GRADIENTS, ROLE_RANK, DEFAULT_GRADIENT, rankOf, allowedGradients, resolveGradient };
