"use client";

import { useEffect, useState } from "react";
import { loadPassword, savePassword } from "@/lib/appPassword";

/**
 * Asked once per browser. The password is checked on the server against an
 * environment variable, so it is never in the shipped bundle — which is the
 * only way a static front end can hold a secret at all.
 */
export default function PasswordGate({
  needed,
  onReady,
}: {
  needed: boolean;
  onReady: () => void;
}) {
  const [value, setValue] = useState("");
  const [have, setHave] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setHave(Boolean(loadPassword()));
  }, []);

  if (!needed || have === null || have) return null;

  async function submit() {
    const password = value.trim();
    if (!password) return;
    setChecking(true);
    setError("");

    try {
      // Cheapest call that exercises the guard.
      const res = await fetch("/api/write", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-password": password },
        body: JSON.stringify({}),
      });
      if (res.status === 401) {
        setError("That password was not accepted.");
        return;
      }
      // Anything else means the guard let us through.
      savePassword(password);
      setHave(true);
      onReady();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "var(--bg)" }}
    >
      <div className="card w-full max-w-[360px] p-5">
        <h1 className="text-[17px] font-bold">JD Mailer</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
          This app spends API credit, so it is password protected. Enter it once and this browser
          will remember.
        </p>

        <input
          className="field mt-4"
          type="password"
          autoFocus
          value={value}
          placeholder="App password"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />

        {error && (
          <p className="mt-2 text-[12.5px] font-medium" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <button
          type="button"
          className="btn btn-primary mt-3 w-full"
          disabled={checking || !value.trim()}
          onClick={() => void submit()}
        >
          {checking ? "Checking…" : "Unlock"}
        </button>
      </div>
    </div>
  );
}
