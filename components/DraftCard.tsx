"use client";

import { useState } from "react";
import { buildSignature } from "@/lib/signature";
import { applyFixes, countBySeverity, type Issue } from "@/lib/validate";
import type { Draft, Profile } from "@/lib/types";

type Props = {
  draft: Draft;
  profile: Profile;
  issues: Issue[];
  onChange: (patch: Partial<Draft>) => void;
  onSend: () => void;
  onRewrite: () => void;
  onRemove: () => void;
};

const CONFIDENCE_STYLE: Record<Draft["confidence"], { bg: string; fg: string; label: string }> = {
  high: { bg: "var(--ok-soft)", fg: "var(--ok)", label: "Read cleanly" },
  medium: { bg: "var(--accent-soft)", fg: "var(--accent)", label: "Check this one" },
  low: { bg: "var(--danger-soft)", fg: "var(--danger)", label: "Unclear" },
};

const SOURCE_LABEL: Record<Draft["source"], string> = {
  ai: "",
  recipe: "⚡ From recipe",
  local: "⚡ Local",
};

export default function DraftCard({
  draft,
  profile,
  issues,
  onChange,
  onSend,
  onRewrite,
  onRemove,
}: Props) {
  const counts = countBySeverity(issues);
  const [open, setOpen] = useState(false);
  const sent = draft.status === "sent";
  const busy = draft.status === "sending";
  const needsRecipient = draft.recipients.length === 0;
  const confidence = CONFIDENCE_STYLE[draft.confidence];
  const sourceLabel = SOURCE_LABEL[draft.source];

  return (
    <article
      className="card overflow-hidden"
      style={sent ? { borderColor: "var(--ok)", opacity: 0.7 } : undefined}
    >
      <div className="flex items-start gap-2.5 p-3.5">
        {!sent && (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-indigo-600"
            checked={draft.include && !needsRecipient}
            disabled={needsRecipient}
            aria-label="Include in Send all"
            onChange={(e) => onChange({ include: e.target.checked })}
          />
        )}

        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <h3 className="truncate text-[15px] font-bold">{draft.role || "Untitled role"}</h3>
          <p className="mt-0.5 truncate text-[13px]" style={{ color: "var(--muted)" }}>
            {[draft.company, draft.location].filter(Boolean).join(" · ") || "Company not detected"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {sent ? (
              <span className="chip" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
                ✓ Sent {draft.sentAt}
              </span>
            ) : (
              <span className="chip" style={{ background: confidence.bg, color: confidence.fg }}>
                {confidence.label}
              </span>
            )}
            {sourceLabel && !sent && (
              <span className="chip" style={{ background: "var(--bg)", color: "var(--muted)" }}>
                {sourceLabel}
              </span>
            )}
            {needsRecipient && !sent && (
              <span className="chip" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
                No email found
              </span>
            )}
            {!sent && counts.errors > 0 && !needsRecipient && (
              <span className="chip" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
                {counts.errors} to fix
              </span>
            )}
            {!sent && counts.errors === 0 && counts.warnings > 0 && (
              <span className="chip" style={{ background: "var(--bg)", color: "var(--muted)" }}>
                {counts.warnings} note{counts.warnings === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </button>

        <span
          className="shrink-0 pt-1 text-sm"
          style={{ color: "var(--muted)" }}
          aria-hidden="true"
        >
          {open ? "▲" : "▼"}
        </span>
      </div>

      {open && (
        <div
          className="flex flex-col gap-3 border-t px-3.5 pb-3.5 pt-3.5"
          style={{ borderColor: "var(--border)" }}
        >
          {draft.notes && (
            <p
              className="rounded-lg px-3 py-2 text-[12.5px] leading-relaxed"
              style={{ background: "var(--accent-soft)", color: "var(--muted)" }}
            >
              {draft.notes}
            </p>
          )}

          <div>
            <label className="label" htmlFor={`to-${draft.id}`}>
              To {needsRecipient && <span style={{ color: "var(--danger)" }}>— add an address</span>}
            </label>
            <input
              id={`to-${draft.id}`}
              className="field"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              disabled={sent}
              value={draft.recipients.join(", ")}
              placeholder="hiring@company.com"
              onChange={(e) => {
                const recipients = e.target.value
                  .split(/[,;\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                onChange({ recipients, include: recipients.length > 0 ? draft.include : false });
              }}
              style={needsRecipient ? { borderColor: "var(--danger)" } : undefined}
            />
          </div>

          <div>
            <label className="label" htmlFor={`subject-${draft.id}`}>
              Subject
            </label>
            <input
              id={`subject-${draft.id}`}
              className="field"
              disabled={sent}
              value={draft.subject}
              onChange={(e) => onChange({ subject: e.target.value })}
            />
          </div>

          <div>
            <label className="label" htmlFor={`body-${draft.id}`}>
              Email
            </label>
            <textarea
              id={`body-${draft.id}`}
              className="field"
              rows={12}
              disabled={sent}
              value={draft.body}
              onChange={(e) => onChange({ body: e.target.value })}
            />
            <div
              className="mt-1.5 whitespace-pre-wrap rounded-lg px-3 py-2 text-[12.5px] leading-relaxed"
              style={{ background: "var(--bg)", color: "var(--muted)" }}
            >
              {buildSignature(profile)}
            </div>
            <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
              Signature is added automatically from your Details.
            </p>
          </div>

          {!sent && issues.length > 0 && (
            <div>
              <ul className="flex flex-col gap-1">
                {issues.map((issue) => (
                  <li
                    key={issue.id}
                    className="rounded-lg px-2.5 py-1.5 text-[12.5px] leading-snug"
                    style={
                      issue.severity === "error"
                        ? { background: "var(--danger-soft)", color: "var(--danger)" }
                        : { background: "var(--bg)", color: "var(--muted)" }
                    }
                  >
                    {issue.severity === "error" ? "✕ " : "• "}
                    {issue.message}
                  </li>
                ))}
              </ul>
              {counts.fixable > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mt-1.5 w-full"
                  onClick={() => onChange({ body: applyFixes(draft.body, issues) })}
                >
                  Fix {counts.fixable} automatically
                </button>
              )}
            </div>
          )}

          {draft.error && (
            <p
              className="rounded-lg px-3 py-2 text-[12.5px] font-medium leading-relaxed"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              {draft.error}
            </p>
          )}

          {!sent && (
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary flex-1"
                disabled={busy || counts.errors > 0}
                onClick={onSend}
              >
                {busy ? "Working…" : counts.errors > 0 ? "Fix issues first" : "Send this one"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0"
                disabled={busy}
                onClick={onRewrite}
                title="Write a fresh version with AI instead of the recipe"
              >
                Rewrite
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0"
                disabled={busy}
                onClick={onRemove}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
