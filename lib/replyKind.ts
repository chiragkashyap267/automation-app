/**
 * Sorts an incoming reply so the interesting ones can be surfaced and the
 * noise ignored.
 *
 * Deliberately rules, not a model: this runs over every message in an inbox
 * scan, the signals are formulaic, and a wrong answer here should never cost
 * an API call. Order matters — a rejection often also says "thank you for
 * applying", so the more specific patterns are tested first.
 */

export type ReplyKind = "interview" | "rejection" | "auto" | "recruiter" | "other";

const INTERVIEW =
  /\b(schedule|book|arrange|set up)\b.{0,30}\b(call|interview|chat|meeting|discussion)\b|\binterview\b.{0,30}\b(invit|schedul|round|slot)|\bshortlist(ed)?\b|\bmoving (you )?forward\b|\bnext round\b|\bavailability\b.{0,30}\b(call|interview)|\bwould you be available\b|\bcalendly\.com|\bmeet\.google\.com|\bzoom\.us\/j\//i;

const REJECTION =
  /\b(unfortunately|regret to inform|we (have )?decided (not )?to|not (be )?(moving|proceeding|progressing)|will not be (moving|proceeding)|unsuccessful|other candidates|more closely (aligned|matched)|not a (good )?(fit|match) (at this time|for this role)|keep your (CV|resume) on file|no longer (open|available))\b/i;

const AUTO =
  /\b(out of office|automatic reply|auto-?reply|autoresponder|on (annual )?leave|away from (my )?(desk|office)|do not reply|this is an automated|we have received your application|your application has been received|thank you for applying|application received|thanks for your interest)\b/i;

const RECRUITER =
  /\b(could you (share|send|confirm)|please (share|send|confirm|attach)|what (is|are) your (notice|expected|current)|expected (CTC|salary|compensation)|notice period|are you (open|available|interested)|send (me )?your (updated )?(CV|resume)|few questions)\b/i;

export type ClassifiedReply = {
  kind: ReplyKind;
  /** Worth interrupting the user for. */
  notable: boolean;
};

export function classifyReply(subject: string, snippet = ""): ClassifiedReply {
  const text = `${subject} ${snippet}`;

  // A rejection frequently opens with "thank you for applying", so it is
  // tested before the auto-acknowledgement patterns.
  if (REJECTION.test(text)) return { kind: "rejection", notable: true };
  if (INTERVIEW.test(text)) return { kind: "interview", notable: true };
  if (AUTO.test(text)) return { kind: "auto", notable: false };
  if (RECRUITER.test(text)) return { kind: "recruiter", notable: true };

  return { kind: "other", notable: true };
}

export const KIND_LABEL: Record<ReplyKind, string> = {
  interview: "🎉 Interview",
  rejection: "✕ Rejected",
  auto: "↩ Auto-acknowledgement",
  recruiter: "💬 Recruiter question",
  other: "✉️ Reply",
};
