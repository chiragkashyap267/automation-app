"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { buildSignature, composeEmail } from "@/lib/signature";
import { checkSendGuard, recordSent } from "@/lib/history";
import { learnFromSend } from "@/lib/pipeline";
import { editRatio } from "@/lib/recipes";
import { authHeaders } from "@/lib/appPassword";
import { canSend, loadDrafts, missingSendLabel, saveDrafts, useProfile } from "@/lib/store";
import { applyFixes, countBySeverity, validateDraft, type Issue } from "@/lib/validate";
import type { Draft } from "@/lib/types";

const GAP_MS = 900;

export default function ReviewPage() {
  const { profile, ready } = useProfile();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [sending, setSending] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [finished, setFinished] = useState(false);
  const [guardMessage, setGuardMessage] = useState("");

  useEffect(() => {
    setDrafts(loadDrafts());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveDrafts(drafts);
  }, [drafts, hydrated]);

  const issuesByDraft = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const draft of drafts) {
      if (draft.status !== "sent") map.set(draft.id, validateDraft(draft, profile));
    }
    return map;
  }, [drafts, profile]);

  const queue = useMemo(
    () => drafts.filter((d) => d.status !== "sent" && d.include && d.recipients.length > 0),
    [drafts],
  );

  // Anything with a blocking issue must not go out with the batch.
  const blocked = queue.filter(
    (d) => countBySeverity(issuesByDraft.get(d.id) ?? []).errors > 0,
  );
  const sendableNow = queue.filter((d) => !blocked.includes(d));
  const sentCount = drafts.filter((d) => d.status === "sent").length;
  const failed = drafts.filter((d) => d.status === "error");

  async function sendAll() {
    if (!sendableNow.length || sending) return;

    const guard = checkSendGuard(sendableNow.length);
    if (guard.block) {
      setGuardMessage(guard.message);
      return;
    }
    if (guard.warn && !window.confirm(`${guard.message}

Send anyway?`)) return;
    setGuardMessage("");
    setSending(true);
    setFinished(false);
    setCursor(0);

    // Snapshot the queue: edits mid-flight should not change what is being sent.
    const batch = [...sendableNow];

    for (let i = 0; i < batch.length; i++) {
      const draft = batch[i];
      setCursor(i + 1);
      setDrafts((prev) =>
        prev.map((d) => (d.id === draft.id ? { ...d, status: "sending", error: "" } : d)),
      );

      try {
        const response = await fetch("/api/send", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            profile,
            to: draft.recipients,
            subject: draft.subject,
            body: composeEmail(draft.body, profile),
            attachResume: Boolean(profile.resumeFileData),
            meta: {
              id: draft.id,
              company: draft.company,
              role: draft.role,
              contactName: draft.contactName,
            },
          }),
        });
        const payload = (await response.json()) as { error?: string; messageId?: string };
        if (!response.ok) throw new Error(payload.error || "Could not send.");

        learnFromSend(draft);
        recordSent(draft, payload.messageId ?? "", editRatio(draft.originalBody, draft.body) > 0.02);
        const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setDrafts((prev) =>
          prev.map((d) =>
            d.id === draft.id ? { ...d, status: "sent", error: "", sentAt: at } : d,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not send.";
        setDrafts((prev) =>
          prev.map((d) => (d.id === draft.id ? { ...d, status: "error", error: message } : d)),
        );
      }

      // Gmail throttles bursts; a short gap keeps a long batch healthy.
      if (i < batch.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
    }

    setSending(false);
    setFinished(true);
  }

  if (!ready || !hydrated) {
    return <main className="mx-auto max-w-[640px] px-4 py-10 text-sm opacity-60">Loading…</main>;
  }

  const sendReady = canSend(profile);

  return (
    <main className="mx-auto max-w-[640px] px-4 pb-36 pt-5">
      <header className="mb-4 flex items-center gap-3">
        <Link href="/" className="btn btn-ghost btn-sm">
          ← Back
        </Link>
        <h1 className="text-[19px] font-bold tracking-tight">Review &amp; send</h1>
      </header>

      <section className="card mb-4 p-3.5 text-[13px] leading-relaxed">
        <Row label="From" value={profile.gmailUser || "— not set —"} />
        <Row label="Reply-to" value={profile.email || profile.gmailUser || "—"} />
        <Row
          label="Attachment"
          value={profile.resumeFileName ? `📎 ${profile.resumeFileName}` : "None"}
        />
        <Row label="Queued" value={`${queue.length} email${queue.length === 1 ? "" : "s"}`} />
        {profile.ccSelf && <Row label="CC" value={profile.gmailUser} />}
      </section>

      {!sendReady && (
        <div
          className="mb-4 rounded-xl px-3.5 py-2.5 text-[13px]"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          Add {missingSendLabel(profile)} in{" "}
          <Link href="/profile" className="font-bold underline">
            Details
          </Link>{" "}
          before sending.
        </div>
      )}

      {finished && (
        <div
          className="mb-4 rounded-xl px-3.5 py-3 text-[13px] font-semibold"
          style={
            failed.length
              ? { background: "var(--danger-soft)", color: "var(--danger)" }
              : { background: "var(--ok-soft)", color: "var(--ok)" }
          }
        >
          {failed.length
            ? `${sentCount} sent, ${failed.length} failed — the failures are marked below.`
            : `All ${sentCount} sent.`}
        </div>
      )}

      {!drafts.length && (
        <p className="py-10 text-center text-sm" style={{ color: "var(--muted)" }}>
          No drafts yet.{" "}
          <Link href="/" className="font-semibold underline">
            Add some job descriptions
          </Link>
          .
        </p>
      )}

      <div className="flex flex-col gap-3">
        {drafts.map((draft) => (
          <Preview
            key={draft.id}
            draft={draft}
            signature={buildSignature(profile)}
            text={composeEmail(draft.body, profile)}
            attachment={profile.resumeFileName}
            disabled={sending}
            onToggle={(include) =>
              setDrafts((prev) => prev.map((d) => (d.id === draft.id ? { ...d, include } : d)))
            }
            issues={issuesByDraft.get(draft.id) ?? []}
            onSave={(patch) =>
              setDrafts((prev) => prev.map((d) => (d.id === draft.id ? { ...d, ...patch } : d)))
            }
          />
        ))}
      </div>

      {queue.length > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 border-t px-4 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <div className="mx-auto max-w-[640px]">
            {guardMessage && (
              <p
                className="mb-2 rounded-lg px-3 py-2 text-center text-[12.5px] font-semibold leading-relaxed"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {guardMessage}
              </p>
            )}
            {blocked.length > 0 && (
              <p
                className="mb-2 rounded-lg px-3 py-2 text-center text-[12.5px] font-semibold"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {blocked.length} held back — fix the red issues above first.
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary w-full"
              disabled={sending || !sendReady || !sendableNow.length}
              onClick={() => void sendAll()}
            >
              {sending ? `Sending ${cursor}/${sendableNow.length}…` : `Send all ${sendableNow.length} now`}
            </button>
            <p className="mt-1.5 text-center text-[11.5px]" style={{ color: "var(--muted)" }}>
              {profile.resumeFileName
                ? `Each one goes out with ${profile.resumeFileName} attached.`
                : "No resume attached — add one in Details."}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-0.5">
      <span className="w-[86px] shrink-0 font-semibold" style={{ color: "var(--muted)" }}>
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate">{value}</span>
    </div>
  );
}

function Preview({
  draft,
  signature,
  text,
  attachment,
  disabled,
  issues,
  onToggle,
  onSave,
}: {
  draft: Draft;
  signature: string;
  text: string;
  attachment: string;
  disabled: boolean;
  issues: Issue[];
  onToggle: (include: boolean) => void;
  onSave: (patch: Pick<Draft, "recipients" | "subject" | "body">) => void;
}) {
  const counts = countBySeverity(issues);
  const sent = draft.status === "sent";
  const sending = draft.status === "sending";
  const errored = draft.status === "error";

  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(draft.recipients.join(", "));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);

  function beginEdit() {
    setTo(draft.recipients.join(", "));
    setSubject(draft.subject);
    setBody(draft.body);
    setEditing(true);
  }

  function save() {
    onSave({
      recipients: to
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      subject: subject.trim(),
      body: body.trimEnd(),
    });
    setEditing(false);
  }

  const border = sent
    ? "var(--ok)"
    : errored
      ? "var(--danger)"
      : sending
        ? "var(--accent)"
        : "var(--border)";

  return (
    <article className="card overflow-hidden" style={{ borderColor: border, opacity: sent ? 0.7 : 1 }}>
      <div
        className="flex items-center gap-2.5 border-b px-3.5 py-2.5"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      >
        {!sent && (
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0 accent-indigo-600"
            checked={draft.include}
            disabled={disabled || draft.recipients.length === 0}
            aria-label={`Include ${draft.role}`}
            onChange={(e) => onToggle(e.target.checked)}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold">
          {draft.company || "Unknown company"} · {draft.role || "role"}
        </span>
        {!sent && counts.errors > 0 && (
          <span
            className="chip shrink-0"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {counts.errors} to fix
          </span>
        )}
        {!sent && counts.errors === 0 && counts.warnings > 0 && (
          <span
            className="chip shrink-0"
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
          >
            {counts.warnings} note{counts.warnings === 1 ? "" : "s"}
          </span>
        )}
        {!sent && !issues.length && (
          <span className="chip shrink-0" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
            ✓ checked
          </span>
        )}
        {sent && (
          <span className="chip shrink-0" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
            ✓ {draft.sentAt}
          </span>
        )}
        {sending && (
          <span className="chip shrink-0" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
            sending…
          </span>
        )}
        {errored && (
          <span className="chip shrink-0" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
            failed
          </span>
        )}
      </div>

      <div className="px-3.5 py-3 text-[13px]">
        {editing ? (
          <div className="flex flex-col gap-3">
            <div>
              <label className="label" htmlFor={`rto-${draft.id}`}>
                To
              </label>
              <input
                id={`rto-${draft.id}`}
                className="field"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                value={to}
                placeholder="hiring@company.com"
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor={`rsub-${draft.id}`}>
                Subject
              </label>
              <input
                id={`rsub-${draft.id}`}
                className="field"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor={`rbody-${draft.id}`}>
                Email
              </label>
              <textarea
                id={`rbody-${draft.id}`}
                className="field"
                rows={14}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <div
                className="mt-1.5 whitespace-pre-wrap rounded-lg px-3 py-2 text-[12.5px] leading-relaxed"
                style={{ background: "var(--bg)", color: "var(--muted)" }}
              >
                {signature}
              </div>
              <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
                Signature is added automatically — no need to type it.
              </p>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary flex-1" onClick={save}>
                Save
              </button>
              <button
                type="button"
                className="btn btn-ghost shrink-0"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <Row label="To" value={draft.recipients.join(", ") || "— no address —"} />
            <Row label="Subject" value={draft.subject} />
            {attachment && <Row label="Attached" value={`📎 ${attachment}`} />}

            <pre
              className="mt-2.5 overflow-x-auto whitespace-pre-wrap rounded-lg px-3 py-2.5 font-sans text-[13px] leading-relaxed"
              style={{ background: "var(--bg)" }}
            >
              {text}
            </pre>

            {!sent && issues.length > 0 && (
              <ul className="mt-2.5 flex flex-col gap-1">
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
            )}

            {!sent && (
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm flex-1"
                  disabled={disabled || sending}
                  onClick={beginEdit}
                >
                  ✎ Edit this email
                </button>
                {counts.fixable > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm shrink-0"
                    disabled={disabled || sending}
                    onClick={() =>
                      onSave({
                        recipients: draft.recipients,
                        subject: draft.subject,
                        body: applyFixes(draft.body, issues),
                      })
                    }
                  >
                    Fix {counts.fixable}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {draft.error && (
          <p className="mt-2 text-[12.5px] font-medium" style={{ color: "var(--danger)" }}>
            {draft.error}
          </p>
        )}
      </div>
    </article>
  );
}
