export const SIMPLE_ROLES = ["hook", "pain", "benefit", "proof", "offer", "cta", "filler"] as const;
export type SimpleRole = typeof SIMPLE_ROLES[number];
export const SIMPLE_ROLE_LABEL: Record<SimpleRole, string> = { hook: "开场", pain: "痛点", benefit: "卖点", proof: "体验", offer: "优惠", cta: "行动号召", filler: "过渡" };
export const simpleRole = (value: string): SimpleRole => value === "intro" ? "hook" : value === "product" || value === "dose" ? "benefit" : SIMPLE_ROLES.includes(value as SimpleRole) ? value as SimpleRole : "filler";
export const roleMatches = (allowed: readonly string[], actual: string) => allowed.some((value) => simpleRole(value) === simpleRole(actual));
