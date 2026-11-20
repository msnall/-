// Forbidden-claim patterns (brief.claimsForbidden): invented numbers, awards, competitors, battery/privacy/security.
export const FORBIDDEN = [
  [/\b(\d[\d,.]*\s?(million|billion|k)\b|\bmillions?\b)/i, "invented number / download count"],
  [/\b(award|winner|rated|rating|stars?|#1|number one|best)\b/i, "rating / award / superlative"],
  [/\b(battery|privacy|private|secure|security|safe)\b/i, "battery / privacy / security claim"],
  [/\b(gboard|swiftkey|samsung keyboard|apple keyboard|better than)\b/i, "competitor comparison"],
];
