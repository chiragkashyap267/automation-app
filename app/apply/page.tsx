"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authHeaders } from "@/lib/appPassword";
import { EXTRA_FIELDS, KIND_LABELS, buildAnswers, missingAnswers, type Extras } from "@/lib/fillValues";
import { useProfile } from "@/lib/store";

/**
 * The phone answer to a form the phone cannot fill.
 *
 * Browsers on Android run no extensions, so nothing can reach inside a
 * careers page and type into it — that was tested rather than assumed.
 * What is left is to make the typing unnecessary: every answer ready to
 * copy in the order a form asks for them, the cover letter already
 * written, and both files already on the device so the picker has
 * something to pick.
 *
 * "Copy all" is the one that matters. Every value goes through the
 * clipboard in order, which lands them in the keyboard's own clipboard
 * tray — so the form can be filled from the keyboard without leaving the
 * page at all. Split screen is the fallback when that does not stick.
 */

const EXTRAS_KEY = "jdmailer.extras.v1";

function loadExtras(): Extras {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(EXTRAS_KEY) || "{}") as Extras;
  } catch {
    return {};
  }
}

export default function ApplyPage() {
  const { profile, ready } = useProfile();
  const [extras, setExtras] = useState<Extras>({});
  const [showExtras, setShowExtras] = useState(false);

  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");

  const [letter, setLetter] = useState("");
  const [letterNote, setLetterNote] = useState("");
  const [writing, setWriting] = useState(false);
  const [copied, setCopied] = useState("");

  useEffect(() => setExtras(loadExtras()), []);

  const answers = useMemo(() => buildAnswers(profile, extras), [profile, extras]);
  const missing = useMemo(() => missingAnswers(profile, extras), [profile, extras]);

  function setExtra(kind: string, value: string) {
    const next = { ...extras, [kind]: value };
    setExtras(next);
    try {
      window.localStorage.setItem(EXTRAS_KEY, JSON.stringify(next));
    } catch {
      // A private window cannot store; the values still work this session.
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1400);
    } catch {
      setCopied("could not copy — long-press the value instead");
    }
  }

  /**
   * Everything, one at a time, slowly enough to be kept.
   *
   * A clipboard history only records separate writes, so a single blob
   * would be one entry and useless. The pause is what makes the keyboard
   * tray list them individually.
   */
  async function copyAll() {
    setCopied("filling the clipboard…");
    try {
      for (const answer of answers) {
        await navigator.clipboard.writeText(answer.value);
        await new Promise((r) => setTimeout(r, 160));
      }
      setCopied(`${answers.length} answers are in your keyboard's clipboard`);
    } catch {
      setCopied("could not copy — tap them one at a time");
    }
    setTimeout(() => setCopied(""), 4000);
  }

  async function writeLetter() {
    setWriting(true);
    setLetterNote("");
    try {
      const res = await fetch("/api/cover", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ company, role, jd, profile }),
      });
      const body = (await res.json()) as {
        letter?: string;
        problems?: string[];
        error?: string;
      };
      if (!res.ok || !body.letter) {
        setLetterNote(body.error || `The app returned ${res.status}.`);
      } else {
        setLetter(body.letter);
        setLetterNote(body.problems?.length ? `Check this: ${body.problems.join(" ")}` : "");
      }
    } catch {
      setLetterNote("Could not reach the app.");
    }
    setWriting(false);
  }

  /** Downloads the letter as a PDF, so the file picker has one to offer. */
  async function downloadLetter() {
    setLetterNote("Making the PDF…");
    try {
      const res = await fetch("/api/cover", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ company, role, jd, profile, letter, pdf: true }),
      });
      if (!res.ok) {
        setLetterNote(`The app returned ${res.status}.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `cover-letter${company ? `-${company.replace(/[^\w]+/g, "-")}` : ""}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      setLetterNote("Saved to your downloads.");
    } catch {
      setLetterNote("Could not make the PDF.");
    }
  }

  /**
   * Fetched rather than linked.
   *
   * A plain download link cannot carry the app password header, and
   * putting the password in the URL would write it into history and into
   * every log between here and the server.
   */
  async function downloadResume() {
    setCopied("fetching your resume…");
    try {
      const res = await fetch("/api/resume/file", { headers: authHeaders() });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setCopied(body.error || `The app returned ${res.status}.`);
        return;
      }
      const blob = await res.blob();
      const name =
        res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "resume.pdf";

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setCopied("Saved to your downloads.");
    } catch {
      setCopied("Could not fetch the resume.");
    }
  }

  if (!ready) {
    return <main className="mx-auto max-w-[640px] px-4 py-10 text-sm opacity-60">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-[640px] px-4 pb-24 pt-5">
      <header className="mb-4 flex items-center gap-3">
        <Link href="/" className="btn btn-ghost btn-sm">
          ← Back
        </Link>
        <h1 className="text-[19px] font-bold tracking-tight">Apply on a portal</h1>
      </header>

      <p className="mb-5 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Your answers, ready to paste, in the order a form asks for them. Tap{" "}
        <b>Copy all</b> once and they sit in your keyboard&apos;s clipboard — then fill the whole
        form without leaving it.
      </p>

      {/* ---------------------------------------------------------- the job */}
      <section className="card mb-6 p-4">
        <h2 className="mb-3 text-[14px] font-semibold">This application</h2>
        <div className="grid grid-cols-2 gap-2">
          <input
            className="field"
            placeholder="Company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
          <input
            className="field"
            placeholder="Role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </div>
        <textarea
          className="field mt-2"
          rows={4}
          placeholder="Paste the job description here — the letter is only as specific as this is."
          value={jd}
          onChange={(e) => setJd(e.target.value)}
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-primary btn-sm" onClick={writeLetter} disabled={writing}>
            {writing ? "Writing…" : letter ? "Rewrite the letter" : "Write the cover letter"}
          </button>
          {letter && (
            <>
              <button className="btn btn-sm" onClick={() => copy(letter, "cover letter")}>
                Copy letter
              </button>
              <button className="btn btn-sm" onClick={downloadLetter}>
                Save as PDF
              </button>
            </>
          )}
        </div>

        {letterNote && (
          <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            {letterNote}
          </p>
        )}

        {letter && (
          <textarea
            className="field mt-3"
            rows={9}
            value={letter}
            onChange={(e) => setLetter(e.target.value)}
          />
        )}
      </section>

      {/* ------------------------------------------------------- the answers */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">
            Your answers <span style={{ color: "var(--muted)" }}>({answers.length})</span>
          </h2>
          <button className="btn btn-sm" onClick={copyAll}>
            Copy all
          </button>
        </div>

        {copied && (
          <p className="mb-2 text-[12.5px]" style={{ color: "var(--accent)" }}>
            {copied}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          {answers.map((answer) => (
            <button
              key={answer.kind}
              onClick={() => copy(answer.value, answer.label)}
              className="card flex items-center justify-between gap-3 px-3.5 py-2.5 text-left"
            >
              <span className="text-[12px] shrink-0" style={{ color: "var(--muted)" }}>
                {answer.label}
              </span>
              <span className="truncate text-[13.5px] font-medium">{answer.value}</span>
            </button>
          ))}
        </div>

        {!answers.length && (
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>
            Nothing to show yet — fill in your details first.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------- the file */}
      <section className="card mb-6 p-4">
        <h2 className="mb-2 text-[14px] font-semibold">Your resume</h2>
        <p className="mb-3 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
          Save it to the phone first — a portal&apos;s file picker can only offer what is already
          on the device.
        </p>
        <button className="btn btn-sm" onClick={downloadResume}>
          Save resume to this phone
        </button>
      </section>

      {/* --------------------------------------------------------- the gaps */}
      <section className="card p-4">
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setShowExtras((v) => !v)}
        >
          <h2 className="text-[14px] font-semibold">
            Answers only you can give{" "}
            {missing.length > 0 && (
              <span style={{ color: "var(--muted)" }}>({missing.length} missing)</span>
            )}
          </h2>
          <span style={{ color: "var(--muted)" }}>{showExtras ? "−" : "+"}</span>
        </button>

        <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
          Gender, date of birth and your marks. Every Indian portal asks for these and nothing
          else here keeps them, so they are stored on this device only — they are never sent to
          the app or anywhere else.
        </p>

        {showExtras && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {EXTRA_FIELDS.map((kind) => (
              <label key={kind} className="flex flex-col gap-1">
                <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                  {KIND_LABELS[kind]}
                </span>
                <input
                  className="field"
                  value={extras[kind] ?? ""}
                  onChange={(e) => setExtra(kind, e.target.value)}
                />
              </label>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
