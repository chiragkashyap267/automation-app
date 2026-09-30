"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { fileToBase64 } from "@/lib/image";
import { buildSignature } from "@/lib/signature";
import { checkExperience } from "@/lib/experience";
import { useProfile } from "@/lib/store";
import type { Profile } from "@/lib/types";

const MAX_ATTACHMENT = 4 * 1024 * 1024;

export default function ProfilePage() {
  const { profile, update, ready } = useProfile();
  const [showPassword, setShowPassword] = useState(false);
  const experience = checkExperience(profile);
  const [fileError, setFileError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onResumeFile(file: File | undefined) {
    if (!file) return;
    setFileError("");
    if (file.size > MAX_ATTACHMENT) {
      setFileError("That file is over 4 MB. Attach a smaller PDF.");
      return;
    }
    try {
      update({
        resumeFileData: await fileToBase64(file),
        resumeFileName: file.name,
        resumeFileType: file.type || "application/pdf",
      });
    } catch {
      setFileError("Could not read that file.");
    }
  }

  if (!ready) {
    return <main className="mx-auto max-w-[640px] px-4 py-10 text-sm opacity-60">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-[640px] px-4 pb-24 pt-5">
      <header className="mb-5 flex items-center gap-3">
        <Link href="/" className="btn btn-ghost btn-sm">
          ← Back
        </Link>
        <h1 className="text-[19px] font-bold tracking-tight">Your details</h1>
      </header>

      <p className="mb-5 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Filled in once, then used for every email. Everything here stays in this browser — it is sent
        to the server only while an email is being written or delivered.
      </p>

      <Section
        title="Fixed details"
        hint="These go into every email exactly as written here, and are checked before anything is sent. They are still variables — change them any time and every unsent draft updates."
      >
        <Grid>
          <Field
            label="Full name"
            value={profile.fullName}
            onChange={(v) => update({ fullName: v })}
            placeholder="Your name"
          />
          <Field
            label="Designation"
            value={profile.headline}
            onChange={(v) => update({ headline: v })}
            placeholder="Full-stack developer"
          />
          <Field
            label="Email (for replies)"
            value={profile.email}
            onChange={(v) => update({ email: v })}
            type="email"
            placeholder="you@gmail.com"
          />
          <Field
            label="Phone"
            value={profile.phone}
            onChange={(v) => update({ phone: v })}
            placeholder="+91 98765 43210"
          />
        </Grid>
        <Field
          label="LinkedIn"
          value={profile.linkedin}
          onChange={(v) => update({ linkedin: v })}
          placeholder="linkedin.com/in/…"
        />
        <Field
          label="GitHub"
          value={profile.github}
          onChange={(v) => update({ github: v })}
          placeholder="github.com/…"
        />
        <Field
          label="Portfolio"
          value={profile.portfolio}
          onChange={(v) => update({ portfolio: v })}
          placeholder="yoursite.com"
        />

        <div
          className="rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed"
          style={{ background: "var(--bg)", color: "var(--muted)" }}
        >
          <strong style={{ color: "var(--text)" }}>Signature preview</strong>
          <pre className="mt-1.5 whitespace-pre-wrap font-sans">{buildSignature(profile)}</pre>
          <p className="mt-1.5">
            Appended to every email. Any other link the model invents is blocked before sending.
          </p>
        </div>
      </Section>

      <Section title="Where you are">
        <Grid>
          <Field
            label="Location"
            value={profile.location}
            onChange={(v) => update({ location: v })}
            placeholder="Bengaluru, India"
          />
          <Field
            label="Years of experience"
            value={profile.yearsExperience}
            onChange={(v) => update({ yearsExperience: v })}
            placeholder="3"
          />
        </Grid>
        {experience.mismatch && (
          <p
            className="rounded-xl px-3.5 py-2.5 text-[12.5px] leading-relaxed"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {experience.message}
          </p>
        )}
      </Section>

      <Section
        title="Background"
        hint="This is what every email is written from. The more real detail here, the less generic they sound."
      >
        <Field
          label="Key skills"
          value={profile.skills}
          onChange={(v) => update({ skills: v })}
          placeholder="React, Node.js, PostgreSQL, AWS"
        />
        <div>
          <label className="label" htmlFor="resumeText">
            Resume text
          </label>
          <textarea
            id="resumeText"
            className="field"
            rows={10}
            value={profile.resumeText}
            onChange={(e) => update({ resumeText: e.target.value })}
            placeholder="Paste your whole resume here — experience, projects, education, numbers."
          />
        </div>
        <div>
          <label className="label" htmlFor="extraNotes">
            Anything else to weave in
          </label>
          <textarea
            id="extraNotes"
            className="field"
            rows={3}
            value={profile.extraNotes}
            onChange={(e) => update({ extraNotes: e.target.value })}
            placeholder="Open to relocation, serving 30-day notice, need visa sponsorship…"
          />
        </div>
        <Grid>
          <div>
            <label className="label" htmlFor="tone">
              Tone
            </label>
            <select
              id="tone"
              className="field"
              value={profile.tone}
              onChange={(e) => update({ tone: e.target.value as Profile["tone"] })}
            >
              <option value="warm">Warm</option>
              <option value="formal">Formal</option>
              <option value="direct">Direct</option>
            </select>
          </div>
          <Field
            label="Sign-off"
            value={profile.signOff}
            onChange={(v) => update({ signOff: v })}
            placeholder="Best regards"
          />
        </Grid>
      </Section>

      <Section
        title="Resume attachment"
        hint="Optional. Attached to an email when the draft has Attach resume switched on."
      >
        {profile.resumeFileName ? (
          <div
            className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
            style={{ background: "var(--bg)" }}
          >
            <span className="truncate text-sm font-medium">📎 {profile.resumeFileName}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm shrink-0"
              onClick={() => {
                update({ resumeFileName: "", resumeFileData: "", resumeFileType: "" });
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost w-full"
            onClick={() => fileRef.current?.click()}
          >
            Choose a PDF
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.doc,.docx"
          className="hidden"
          onChange={(e) => void onResumeFile(e.target.files?.[0])}
        />
        {fileError && (
          <p className="text-[13px] font-medium" style={{ color: "var(--danger)" }}>
            {fileError}
          </p>
        )}
      </Section>

      <Section title="Sending (Gmail)">
        <Field
          label="Gmail address"
          value={profile.gmailUser}
          onChange={(v) => update({ gmailUser: v })}
          type="email"
          placeholder="you@gmail.com"
        />
        <div>
          <label className="label" htmlFor="appPassword">
            App Password
          </label>
          <div className="flex gap-2">
            <input
              id="appPassword"
              className="field"
              type={showPassword ? "text" : "password"}
              autoComplete="off"
              value={profile.gmailAppPassword}
              onChange={(e) => update({ gmailAppPassword: e.target.value })}
              placeholder="abcd efgh ijkl mnop"
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm shrink-0"
              onClick={() => setShowPassword((s) => !s)}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            Not your Gmail password. Turn on 2-Step Verification, then create one at{" "}
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer"
              className="font-semibold underline"
              style={{ color: "var(--accent)" }}
            >
              myaccount.google.com/apppasswords
            </a>
            . It is 16 characters and can only send mail.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-indigo-600"
            checked={profile.ccSelf}
            onChange={(e) => update({ ccSelf: e.target.checked })}
          />
          CC myself on every email
        </label>
      </Section>

      <div
        className="mt-6 rounded-xl px-3.5 py-3 text-[12.5px] leading-relaxed"
        style={{ background: "var(--accent-soft)", color: "var(--muted)" }}
      >
        Saved automatically as you type.
      </div>
    </main>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card mb-4 p-4">
      <h2 className="text-[15px] font-bold">{title}</h2>
      {hint && (
        <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
          {hint}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-3.5">{children}</div>
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">{children}</div>;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
