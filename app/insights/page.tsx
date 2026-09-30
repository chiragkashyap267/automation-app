"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  applyReplyResults,
  clearHistory,
  computeInsights,
  loadHistory,
  type Insights,
  type SentEmail,
} from "@/lib/history";
import { describeFamily } from "@/lib/recipes";
import { KIND_LABEL, type ReplyKind } from "@/lib/replyKind";
import { authHeaders } from "@/lib/appPassword";
import { canSend, useProfile } from "@/lib/store";

export default function InsightsPage() {
  const { profile, ready } = useProfile();
  const [rows, setRows] = useState<SentEmail[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setRows(loadHistory());
    setHydrated(true);
  }, []);

  const checkReplies = useCallback(async () => {
    setChecking(true);
    setError("");
    setStatus("");
    try {
      const pending = loadHistory().filter((r) => r.reply !== "replied" && r.reply !== "bounced");
      if (!pending.length) {
        setStatus("Nothing is waiting on a reply.");
        return;
      }

      const response = await fetch("/api/replies", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          profile,
          items: pending.map((r) => ({
            id: r.id,
            messageId: r.messageId,
            to: r.to,
            sentAt: r.sentAt,
          })),
        }),
      });

      const payload = (await response.json()) as {
        results?: {
          id: string;
          reply: SentEmail["reply"];
          at: number;
          from: string;
          subject: string;
          kind?: string;
        }[];
        scanned?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not check replies.");

      const updated = applyReplyResults(payload.results ?? []);
      setRows([...updated]);

      const found = (payload.results ?? []).filter((r) => r.reply === "replied").length;
      const interviews = (payload.results ?? []).filter((r) => r.kind === "interview").length;
      setStatus(
        `Scanned ${payload.scanned ?? 0} inbox message${payload.scanned === 1 ? "" : "s"} — ` +
          (found
            ? `${found} new repl${found === 1 ? "y" : "ies"}${interviews ? `, ${interviews} look like interview requests 🎉` : ""}.`
            : "no new replies."),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check replies.");
    } finally {
      setChecking(false);
    }
  }, [profile]);

  if (!ready || !hydrated) {
    return <main className="mx-auto max-w-[640px] px-4 py-10 text-sm opacity-60">Loading…</main>;
  }

  const data = computeInsights(rows);
  const sendReady = canSend(profile);

  return (
    <main className="mx-auto max-w-[640px] px-4 pb-24 pt-5">
      <header className="mb-4 flex items-center gap-3">
        <Link href="/" className="btn btn-ghost btn-sm">
          ← Back
        </Link>
        <h1 className="text-[19px] font-bold tracking-tight">Insights</h1>
      </header>

      {!rows.length && (
        <p className="py-10 text-center text-sm" style={{ color: "var(--muted)" }}>
          Nothing sent yet. Once you send your first emails this page tracks what came back.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Stat
              label="Interviews"
              value={String(data.interviews)}
              tone={data.interviews > 0 ? "ok" : undefined}
              hint={data.rejections > 0 ? `${data.rejections} rejected` : undefined}
            />
            <Stat label="Sent" value={String(data.sent)} />
            <Stat
              label="Reply rate"
              value={data.replyRate === null ? "—" : `${data.replyRate}%`}
              hint={
                data.replyRate === null
                  ? "needs 2 days"
                  : `${data.replied} of ${data.matureCount} mature`
              }
              tone={data.replyRate !== null && data.replyRate >= 10 ? "ok" : undefined}
            />
            <Stat label="Awaiting" value={String(data.awaiting)} />
            <Stat
              label="Bounced"
              value={String(data.bounced)}
              tone={data.bounced > 0 ? "bad" : undefined}
            />
          </div>

          {data.medianHours > 0 && (
            <p className="mb-3 text-center text-[12.5px]" style={{ color: "var(--muted)" }}>
              Replies typically arrive within {data.medianHours}h
              {data.auto > 0 && ` · ${data.auto} auto-acknowledgement${data.auto === 1 ? "" : "s"}`}
            </p>
          )}

          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={checking || !sendReady}
            onClick={() => void checkReplies()}
          >
            {checking ? "Checking your inbox…" : "Check for replies"}
          </button>

          {!sendReady && (
            <p className="mt-2 text-center text-[12.5px]" style={{ color: "var(--danger)" }}>
              Add your Gmail App Password in Details — the same one reads replies.
            </p>
          )}
          {status && (
            <p className="mt-2 text-center text-[12.5px]" style={{ color: "var(--muted)" }}>
              {status}
            </p>
          )}
          {error && (
            <p
              className="mt-2 rounded-lg px-3 py-2 text-[12.5px] font-medium"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              {error}
            </p>
          )}

          {data.recentReplies.length > 0 && (
            <Panel title="Recent replies">
              {data.recentReplies.map((row) => (
                <div key={row.id + row.replyAt} className="py-1.5">
                  <p className="truncate text-[13px] font-semibold">
                    {row.company || row.replyFrom} — {row.role}
                  </p>
                  <p className="truncate text-[12px]" style={{ color: "var(--muted)" }}>
                    {row.replyKind ? `${KIND_LABEL[row.replyKind as ReplyKind] ?? ""} · ` : ""}
                    {row.replySubject || "(no subject)"} ·{" "}
                    {new Date(row.replyAt).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </Panel>
          )}

          <Panel
            title="Which recipes get answered"
            hint="Reply rate shows once a group has mail older than two days."
          >
            <Breakdown rows={data.byRecipe} label={(k) => (k === "—" ? "No recipe" : describeFamily(k))} />
          </Panel>

          <Panel title="Written by">
            <Breakdown
              rows={data.bySource}
              label={(k) =>
                k === "ai" ? "The model" : k === "recipe" ? "A saved recipe" : "Local rules"
              }
            />
          </Panel>

          <Panel title="Did editing help?">
            <Breakdown rows={data.byEdited} label={(k) => k} />
          </Panel>

          <button
            type="button"
            className="btn btn-ghost mt-6 w-full"
            onClick={() => {
              if (!window.confirm("Delete the entire sent history? Insights start from zero.")) return;
              clearHistory();
              setRows([]);
            }}
          >
            Clear sent history
          </button>
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "bad";
}) {
  const color = tone === "ok" ? "var(--ok)" : tone === "bad" ? "var(--danger)" : "var(--text)";
  return (
    <div className="card px-3 py-2.5">
      <div className="text-[22px] font-bold leading-tight" style={{ color }}>
        {value}
      </div>
      <div className="text-[12px] font-semibold" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      {hint && (
        <div className="mt-0.5 text-[11px]" style={{ color: "var(--muted)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card mt-3 p-3.5">
      <h2 className="text-[14.5px] font-bold">{title}</h2>
      {hint && (
        <p className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
          {hint}
        </p>
      )}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Breakdown({
  rows,
  label,
}: {
  rows: { key: string; sent: number; replied: number; rate: number | null }[];
  label: (key: string) => string;
}) {
  if (!rows.length) {
    return (
      <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
        Nothing yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.key}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-[13px]">{label(row.key)}</span>
            <span className="shrink-0 text-[12px]" style={{ color: "var(--muted)" }}>
              {row.replied}/{row.sent}
              {row.rate !== null && ` · ${row.rate}%`}
            </span>
          </div>
          <div
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: "var(--bg)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${row.rate ?? 0}%`,
                background: (row.rate ?? 0) >= 10 ? "var(--ok)" : "var(--accent)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
