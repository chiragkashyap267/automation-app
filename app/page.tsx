"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import DraftCard from "@/components/DraftCard";
import PasswordGate from "@/components/PasswordGate";
import PasteZone from "@/components/PasteZone";
import SourceList from "@/components/SourceList";
import { prepareImage } from "@/lib/image";
import { learnFromSend, newId, processGroup, rewriteDraft, type RunMode } from "@/lib/pipeline";
import { recordSent } from "@/lib/history";
import { editRatio, loadRecipes } from "@/lib/recipes";
import { composeEmail } from "@/lib/signature";
import { priorApplication } from "@/lib/history";
import { validateDraft } from "@/lib/validate";
import { authHeaders } from "@/lib/appPassword";
import {
  canSend,
  loadDrafts,
  missingSendLabel,
  profileIsUsable,
  saveDrafts,
  useProfile,
} from "@/lib/store";
import type { Draft, SourceItem } from "@/lib/types";

const CONCURRENCY = 3;
const RUN_MODE_KEY = "jdmailer.runmode.v1";

const RUN_MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Cache and recipes first, AI for the rest. Most reliable." },
  {
    value: "local-first",
    label: "Local first",
    hint: "Reads screenshots with on-device OCR and falls back to AI only when that fails.",
  },
  {
    value: "local-only",
    label: "Local only",
    hint: "Never calls an API. Instant and free, but needs clear screenshots and a matching recipe.",
  },
];

type ProviderInfo = {
  visionReader: string | null;
  textReader: string | null;
  writer: string | null;
  gemini: { total: number; available: number } | null;
  groq: { total: number; available: number } | null;
  cerebras: { total: number; available: number } | null;
  protected: boolean;
};

async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export default function HomePage() {
  const { profile, ready } = useProfile();
  const [items, setItems] = useState<SourceItem[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [loadedConfig, setLoadedConfig] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [savings, setSavings] = useState("");
  const [runMode, setRunMode] = useState<RunMode>("auto");
  const [stage, setStage] = useState("");
  const [recipeCount, setRecipeCount] = useState(0);
  const [shareNote, setShareNote] = useState("");

  const refreshConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/config");
      setInfo((await response.json()) as ProviderInfo);
    } catch {
      setInfo({ visionReader: null, textReader: null, writer: null, gemini: null, groq: null, cerebras: null, protected: false });
    } finally {
      setLoadedConfig(true);
    }
  }, []);

  useEffect(() => {
    setDrafts(loadDrafts());
    setRecipeCount(loadRecipes().length);
    try {
      const saved = window.localStorage.getItem(RUN_MODE_KEY);
      if (saved === "auto" || saved === "local-first" || saved === "local-only") setRunMode(saved);
    } catch {
      /* ignore */
    }
    void refreshConfig();
  }, [refreshConfig]);

  useEffect(() => {
    saveDrafts(drafts);
  }, [drafts]);

  // Arriving from another app's share sheet: Android puts the shared post in
  // the query string. Pick it up once, then clean the URL so a refresh does
  // not add it twice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const title = params.get("share_title") ?? "";
    const text = params.get("share_text") ?? "";
    const url = params.get("share_url") ?? "";
    if (!title && !text && !url) return;

    window.history.replaceState({}, "", window.location.pathname);

    const shared = [title, text, url].filter(Boolean).join("\n").trim();
    const wordCount = shared.split(/\s+/).filter(Boolean).length;
    const looksLikeBareLink = /^https?:\/\/\S+$/.test(shared);

    if (looksLikeBareLink || wordCount < 12) {
      // LinkedIn shares a job *listing* as a link, and the page behind it
      // needs a login, so there is nothing here to read.
      setShareNote(
        "That share only contained a link, not the job text. Open the post, select the text and share that — or take a screenshot.",
      );
      return;
    }

    // setItems directly rather than addText, so this effect does not depend on
    // a callback declared further down.
    setItems((prev) => [
      ...prev,
      {
        id: newId(),
        kind: "text",
        data: "",
        mediaType: "",
        text: shared,
        preview: "",
        groupId: newId(),
      },
    ]);
    setShareNote("Added from share. Check it looks complete, then write the email.");
  }, []);

  const pickRunMode = useCallback((value: RunMode) => {
    setRunMode(value);
    try {
      window.localStorage.setItem(RUN_MODE_KEY, value);
    } catch {
      /* ignore */
    }
  }, []);

  const addImages = useCallback((files: File[]) => {
    setError("");
    void (async () => {
      for (const file of files) {
        try {
          const prepared = await prepareImage(file);
          setItems((prev) => [
            ...prev,
            {
              id: newId(),
              kind: "image",
              data: prepared.data,
              mediaType: prepared.mediaType,
              text: "",
              preview: prepared.preview,
              groupId: newId(),
            },
          ]);
        } catch {
          setError("One of those images could not be read.");
        }
      }
    })();
  }, []);

  const addText = useCallback((text: string) => {
    setError("");
    setItems((prev) => [
      ...prev,
      { id: newId(), kind: "text", data: "", mediaType: "", text, preview: "", groupId: newId() },
    ]);
  }, []);

  const mergeUp = useCallback((id: string) => {
    setItems((prev) => {
      const index = prev.findIndex((i) => i.id === id);
      if (index < 1) return prev;
      const groupId = prev[index - 1].groupId;
      return prev.map((item, i) => (i === index ? { ...item, groupId } : item));
    });
  }, []);

  const split = useCallback((id: string) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, groupId: newId() } : item)));
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, SourceItem[]>();
    for (const item of items) {
      const existing = map.get(item.groupId);
      if (existing) existing.push(item);
      else map.set(item.groupId, [item]);
    }
    return [...map.entries()];
  }, [items]);

  async function processAll() {
    if (!items.length || working) return;
    setError("");
    setSavings("");
    setWorking(true);
    setProgress({ done: 0, total: groups.length });

    let completed = 0;
    const tasks = groups.map(([groupId, groupItems]) => async () => {
      const outcome = await processGroup(groupId, groupItems, profile, runMode, setStage);
      completed += 1;
      setProgress({ done: completed, total: groups.length });
      return outcome;
    });

    const results = await pooled(tasks, CONCURRENCY);

    const produced = results.flatMap((r) => r.drafts);
    const failures = results.filter((r) => r.error).map((r) => r.error);
    const failedGroups = new Set(results.filter((r) => !r.drafts.length).map((r) => r.groupId));

    // Keep the sources that produced nothing so they can be retried.
    setItems((prev) => prev.filter((item) => failedGroups.has(item.groupId)));
    setDrafts((prev) => [...produced, ...prev]);

    const free = produced.filter((d) => d.source !== "ai").length;
    const calls = results.reduce((sum, r) => sum + r.readCalls + r.writeCalls, 0);
    const ocrUsed = results.some((r) => r.usedOcr);
    if (produced.length) {
      const bits = [`${produced.length} drafted`];
      if (ocrUsed) bits.push("read on device");
      if (free > 0) bits.push(`${free} from cache or recipe`);
      bits.push(`${calls} API call${calls === 1 ? "" : "s"}`);
      setSavings(bits.join(" · "));
    }

    if (failures.length) setError(failures[0]);
    setRecipeCount(loadRecipes().length);
    setWorking(false);
    setStage("");
    setProgress({ done: 0, total: 0 });
    void refreshConfig();
  }

  const updateDraft = useCallback((id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  const sendDraft = useCallback(
    async (draft: Draft) => {
      updateDraft(draft.id, { status: "sending", error: "" });
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

        // The sent version is the verified one — it teaches the recipe.
        learnFromSend(draft);
        recordSent(draft, payload.messageId ?? "", editRatio(draft.originalBody, draft.body) > 0.02);
        setRecipeCount(loadRecipes().length);

        updateDraft(draft.id, {
          status: "sent",
          error: "",
          sentAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      } catch (err) {
        updateDraft(draft.id, {
          status: "error",
          error: err instanceof Error ? err.message : "Could not send.",
        });
      }
    },
    [profile, updateDraft],
  );

  const rewrite = useCallback(
    async (draft: Draft) => {
      updateDraft(draft.id, { status: "sending", error: "" });
      try {
        const next = await rewriteDraft(draft, profile);
        updateDraft(draft.id, { ...next, status: "idle" });
        setRecipeCount(loadRecipes().length);
      } catch (err) {
        updateDraft(draft.id, {
          status: "error",
          error: err instanceof Error ? err.message : "Could not rewrite.",
        });
      }
    },
    [profile, updateDraft],
  );

  const pending = drafts.filter((d) => d.status !== "sent");
  const sendable = pending.filter((d) => d.recipients.length > 0 && d.include);
  const setupDone = ready && profileIsUsable(profile);
  const sendReady = canSend(profile);
  const noKeys = Boolean(loadedConfig && info && !info.textReader && !info.writer);

  // A run is possible without a reader as long as a local mode can produce the
  // facts and either a writer or a saved recipe can turn them into an email.
  const canRun =
    Boolean(info?.textReader) ||
    (runMode !== "auto" && (Boolean(info?.writer) || recipeCount > 0));

  const hasImages = items.some((i) => i.kind === "image");
  const screenshotsNeedLocal =
    hasImages && loadedConfig && Boolean(info) && !info?.visionReader && runMode === "auto";

  return (
    <main className="mx-auto max-w-[640px] px-4 pb-32 pt-5">
      <PasswordGate needed={Boolean(info?.protected)} onReady={() => void refreshConfig()} />

      {loadedConfig && info && !info.protected && (
        <Banner tone="danger">
          This deployment has no <code>APP_PASSWORD</code>, so anyone with the URL can spend your
          API credit. Set it in Vercel and redeploy.
        </Banner>
      )}
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold tracking-tight">JD Mailer</h1>
          <p className="truncate text-[12.5px]" style={{ color: "var(--muted)" }}>
            {!loadedConfig
              ? "…"
              : !info?.textReader && !info?.writer
                ? "No AI key configured"
                : `Reads with ${info?.textReader ?? "on-device OCR"}, writes with ${info?.writer ?? "recipes"}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Link href="/insights" className="btn btn-ghost btn-sm" aria-label="Insights">
            📈
          </Link>
          <Link href="/services" className="btn btn-ghost btn-sm" aria-label="Freelance services">
            💼
          </Link>
          <Link href="/profile" className="btn btn-ghost btn-sm">
            ⚙ Details
          </Link>
        </div>
      </header>

      {loadedConfig && info && (info.gemini || info.groq || info.cerebras) && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {info.gemini && (
            <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              Gemini {info.gemini.available}/{info.gemini.total} keys
            </span>
          )}
          {info.groq && (
            <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              Groq {info.groq.available}/{info.groq.total} keys
            </span>
          )}
          {info.cerebras && (
            <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              Cerebras {info.cerebras.available}/{info.cerebras.total} keys
            </span>
          )}
          {recipeCount > 0 && (
            <Link
              href="/recipes"
              className="chip"
              style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
            >
              {recipeCount} recipe{recipeCount === 1 ? "" : "s"} →
            </Link>
          )}
        </div>
      )}

      {noKeys && (
        <Banner tone="danger">
          No AI key is set. Add <code>GROQ_API_KEY_1</code> or <code>GEMINI_API_KEY_1</code> (both
          free) to your environment and restart.
        </Banner>
      )}

      {loadedConfig && info && !info.visionReader && info.textReader && (
        <Banner tone="accent">
          {info.textReader} has no vision, so it cannot read screenshots. Pasted job text works
          normally; for screenshots switch to <strong>Local first</strong> and they are read on your
          device with OCR.
        </Banner>
      )}

      {ready && !setupDone && (
        <Banner tone="accent">
          Add your name and resume in{" "}
          <Link href="/profile" className="font-bold underline">
            Details
          </Link>{" "}
          first — the emails are written from them.
        </Banner>
      )}

      {ready && setupDone && !sendReady && (
        <Banner tone="accent">
          Emails can be written now. Add {missingSendLabel(profile)} in{" "}
          <Link href="/profile" className="font-bold underline">
            Details
          </Link>{" "}
          to send them.
        </Banner>
      )}

      <div className="mb-3">
        <div
          className="flex gap-1 rounded-xl p-1"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          role="group"
          aria-label="How to process"
        >
          {RUN_MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              className="flex-1 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors"
              style={
                runMode === option.value
                  ? { background: "var(--accent)", color: "#fff" }
                  : { color: "var(--muted)" }
              }
              aria-pressed={runMode === option.value}
              onClick={() => pickRunMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 px-1 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          {RUN_MODES.find((o) => o.value === runMode)?.hint}
        </p>
      </div>

      <PasteZone onAddImages={addImages} onAddText={addText} disabled={working} />

      <SourceList
        items={items}
        onRemove={removeItem}
        onMergeUp={mergeUp}
        onSplit={split}
        disabled={working}
      />

      {items.length > 0 && (
        <>
          {screenshotsNeedLocal && (
            <p
              className="mt-2 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              There is a screenshot here and no key that can see images. Switch to{" "}
              <strong>Local first</strong> to read it on your device.
            </p>
          )}

          <button
            type="button"
            className="btn btn-primary mt-3 w-full"
            disabled={working || !setupDone || !canRun}
            onClick={() => void processAll()}
          >
            {working
              ? stage || `Reading ${progress.done}/${progress.total}…`
              : `Write ${groups.length} email${groups.length === 1 ? "" : "s"}`}
          </button>
        </>
      )}

      {savings && (
        <p className="mt-2.5 text-center text-[12.5px]" style={{ color: "var(--muted)" }}>
          {savings}
        </p>
      )}

      {shareNote && <Banner tone="accent">{shareNote}</Banner>}

      {error && <Banner tone="danger">{error}</Banner>}

      {drafts.length > 0 && (
        <>
          <div className="mb-2.5 mt-7 flex items-center justify-between">
            <h2 className="text-[15px] font-bold">
              Drafts
              <span className="ml-2 font-normal" style={{ color: "var(--muted)" }}>
                {pending.length} to send
              </span>
            </h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setDrafts((prev) => prev.filter((d) => d.status !== "sent"))}
            >
              Clear sent
            </button>
          </div>

          <div className="flex flex-col gap-2.5">
            {drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                profile={profile}
                issues={validateDraft(draft, profile, priorApplication(draft.company, draft.recipients))}
                onChange={(patch) => updateDraft(draft.id, patch)}
                onSend={() => void sendDraft(draft)}
                onRewrite={() => void rewrite(draft)}
                onRemove={() => setDrafts((prev) => prev.filter((d) => d.id !== draft.id))}
              />
            ))}
          </div>
        </>
      )}

      {sendable.length > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 border-t px-4 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <div className="mx-auto max-w-[640px]">
            <Link href="/review" className="btn btn-primary w-full">
              Preview all {sendable.length} &rarr;
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}

function Banner({ tone, children }: { tone: "accent" | "danger"; children: React.ReactNode }) {
  const style =
    tone === "danger"
      ? { background: "var(--danger-soft)", color: "var(--danger)" }
      : { background: "var(--accent-soft)", color: "var(--muted)" };

  return (
    <div className="mb-3 rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed" style={style}>
      {children}
    </div>
  );
}
