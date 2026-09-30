"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/appPassword";
import { EMPTY_SERVICES, servicesReady, type ServicesProfile } from "@/lib/services";

const KEY = "jdmailer.services.v1";

/**
 * The freelance side: what you sell, and the real work that proves it.
 *
 * Kept apart from Details because almost nothing carries over. A pitch sells
 * a service to a business; an application sells a person to an employer.
 */
export default function ServicesPage() {
  const [profile, setProfile] = useState<ServicesProfile>(EMPTY_SERVICES);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setProfile({ ...EMPTY_SERVICES, ...(JSON.parse(raw) as Partial<ServicesProfile>) });
    } catch {
      /* private mode — the form still works for this session */
    }
    setReady(true);
  }, []);

  const update = useCallback((patch: Partial<ServicesProfile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const push = useCallback(async () => {
    setSaved("Saving…");
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ profile }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; reason?: string };
      if (!res.ok) throw new Error(body.error || "Could not save.");
      setSaved(body.ok ? "Saved — the bot can pitch from this now." : `Not saved (${body.reason}).`);
    } catch (err) {
      setSaved(err instanceof Error ? err.message : "Could not save.");
    }
  }, [profile]);

  if (!ready) {
    return <main className="mx-auto max-w-[640px] px-4 py-10 text-sm opacity-60">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-[640px] px-4 pb-28 pt-5">
      <header className="mb-4 flex items-center gap-3">
        <Link href="/" className="btn btn-ghost btn-sm">
          ← Back
        </Link>
        <h1 className="text-[19px] font-bold tracking-tight">Services</h1>
      </header>

      <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Used by <span className="font-semibold">/pitch</span> in the bot to sell your freelance
        work. Separate from Details, which is for job applications.
      </p>

      <Section title="Who you are" hint="Shown at the top of every pitch.">
        <Grid>
          <Field label="Your name" value={profile.fullName} onChange={(v) => update({ fullName: v })} placeholder="Chirag Kashyap" />
          <Field label="Business name" value={profile.businessName} onChange={(v) => update({ businessName: v })} placeholder="optional" />
        </Grid>
        <Field
          label="One line about what you do"
          value={profile.tagline}
          onChange={(v) => update({ tagline: v })}
          placeholder="Packaging, branding and websites for new consumer brands"
        />
        <Grid>
          <Field label="City" value={profile.city} onChange={(v) => update({ city: v })} placeholder="Noida, NCR" />
          <Field label="Starting price" value={profile.startingPrice} onChange={(v) => update({ startingPrice: v })} placeholder="optional — e.g. label design from ₹8,000" />
        </Grid>
      </Section>

      <Section
        title="What you offer"
        hint="Comma separated. The pitch leads with whichever one the lead actually needs."
      >
        <Area
          label="Services"
          value={profile.services}
          onChange={(v) => update({ services: v })}
          rows={3}
          placeholder="packaging design, label design, logo and branding, websites, motion graphics, short-form video, social media posts"
        />
      </Section>

      <Section
        title="Proof"
        hint="The only thing a pitch is allowed to claim. Name real clients and real work — anything not written here will be refused before it can be sent."
      >
        <Area
          label="Past work"
          value={profile.proof}
          onChange={(v) => update({ proof: v })}
          rows={6}
          placeholder={
            "Designed label and outer carton for a Noida spice brand, printed with a local converter.\n" +
            "Built a Shopify store for a D2C skincare launch.\n" +
            "Monthly social templates and reels for two NCR cafés."
          }
        />
        <Grid>
          <Field label="Portfolio link" value={profile.portfolio} onChange={(v) => update({ portfolio: v })} placeholder="chiragkashyapwebdev.vercel.app" />
          <Field label="Showreel link" value={profile.showreel} onChange={(v) => update({ showreel: v })} placeholder="optional" />
        </Grid>
      </Section>

      <Section title="How they reach you">
        <Grid>
          <Field label="Email" value={profile.email} onChange={(v) => update({ email: v })} type="email" />
          <Field label="Phone" value={profile.phone} onChange={(v) => update({ phone: v })} />
        </Grid>
        <Grid>
          <Field label="WhatsApp" value={profile.whatsapp} onChange={(v) => update({ whatsapp: v })} placeholder="optional" />
          <Field label="Sign-off" value={profile.signOff} onChange={(v) => update({ signOff: v })} placeholder="Best regards" />
        </Grid>
      </Section>

      {!servicesReady(profile) && (
        <p
          className="mb-3 rounded-xl px-3.5 py-2.5 text-[12.5px] leading-relaxed"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          Needs your name, your services, and either past work or a portfolio link before the bot
          will write a pitch.
        </p>
      )}

      <button type="button" className="btn btn-primary w-full" onClick={() => void push()}>
        Save for the bot
      </button>
      {saved && (
        <p className="mt-2 text-center text-[12.5px]" style={{ color: "var(--muted)" }}>
          {saved}
        </p>
      )}
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

function Area({
  label,
  value,
  onChange,
  rows,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  placeholder?: string;
}) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="field"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
