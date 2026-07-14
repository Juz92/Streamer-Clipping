/**
 * hook-variants.ts — Archetype-aware title variant generator.
 *
 * Generates 2 title options per clip based on archetype.
 * Tracks which patterns perform best for feedback loop integration.
 */

export type HookPattern =
  | "he-said"
  | "he-lost-it"
  | "nasty"
  | "wait-what"
  | "context-payoff"
  | "question"
  | "statement-setup"
  | "generic";

export interface HookVariants {
  pattern: HookPattern;
  titleA: string; // conversational setup style
  titleB: string; // punchline-first or quote-first
  titleC: string; // drama / escalation hook
}

const ARCHETYPE_PATTERNS: Record<string, HookPattern> = {
  roast: "he-said",
  crashout: "he-lost-it",
  skill: "nasty",
  "one-liner": "wait-what",
  "story-payoff": "context-payoff",
};

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

/** Generate 2 title variants from hook/quote/archetype. */
export function generateHookVariants(
  hook: string,
  quote: string | undefined,
  archetype: string,
): HookVariants {
  const base = hook.replace(/[.!?]$/, "").trim();
  const q = quote ? quote.replace(/[.!?]$/, "").trim() : "";
  const pattern = ARCHETYPE_PATTERNS[archetype] ?? "generic";

  let titleA = base;
  let titleB = base;

  switch (pattern) {
    case "he-said":
      titleA = `he really said "${truncate(base, 35)}" 💀`;
      titleB = q
        ? `"${truncate(q, 30)}" — roasted 💀`
        : `the roast that ended him 💀`;
      break;
    case "he-lost-it":
      titleA = `he LOST it over ${truncate(base, 30)} 💀`;
      titleB = q
        ? `"${truncate(q, 25)}" (full meltdown) 💀`
        : `peak tilt right here 💀`;
      break;
    case "nasty":
      titleA = `this was DISGUSTING 💀`;
      titleB = `nobody expected ${truncate(base, 30)} 💀`;
      break;
    case "wait-what":
      titleA = `wait, he said WHAT? 💀`;
      titleB = `"${truncate(base, 38)}" 💀`;
      break;
    case "context-payoff":
      titleA = `context makes this worse 💀`;
      titleB = `the buildup was worth it 💀`;
      break;
    default:
      if (/\?/.test(base)) {
        titleA = truncate(base, 65) + " 💀";
        titleB = q ? `"${truncate(q, 35)}" 💀` : titleA;
      } else if (/^(he |she |they |this |when |how |what |why )/i.test(base)) {
        titleA = truncate(base, 65) + " 💀";
        titleB = q ? `when he said "${truncate(q, 30)}" 💀` : titleA;
      } else {
        titleA = truncate(base, 65) + " 💀";
        titleB = q ? `"${truncate(q, 38)}" 💀` : titleA;
      }
  }

  // Hard cap at 68 chars for YouTube
  titleA = titleA.slice(0, 68);
  titleB = titleB.slice(0, 68);

  let titleC = q ? `he snapped "${truncate(q, 30)}" 😤` : `watch the chaos unfold 🔥`;
  titleC = titleC.slice(0, 68);

  return { pattern, titleA, titleB, titleC };
}

/** Infer pattern from an existing title (for analytics feedback). */
export function inferHookPattern(title: string): HookPattern {
  const lower = title.toLowerCase();
  if (/he really said|he said|she said|they said/.test(lower))
    return "he-said";
  if (/lost it|meltdown|tilt|rage/.test(lower)) return "he-lost-it";
  if (/disgusting|nasty|insane|unbelievable/.test(lower)) return "nasty";
  if (/wait.*what|wait, he|hold up/.test(lower)) return "wait-what";
  if (/context|buildup|payoff/.test(lower)) return "context-payoff";
  if (/\?/.test(title)) return "question";
  if (/^(he |she |they |this |when |how )/i.test(lower))
    return "statement-setup";
  return "generic";
}
