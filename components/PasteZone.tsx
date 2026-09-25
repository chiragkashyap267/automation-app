"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  onAddImages: (files: File[]) => void;
  onAddText: (text: string) => void;
  disabled?: boolean;
};

export default function PasteZone({ onAddImages, onAddText, disabled }: Props) {
  const [text, setText] = useState("");
  const [flash, setFlash] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Pasting a screenshot anywhere on the page adds it — the fastest path on
  // desktop, where the clipboard usually already holds the shot you just took.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      if (!files.length) return;
      event.preventDefault();
      onAddImages(files);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 700);
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onAddImages]);

  function commitText() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAddText(trimmed);
    setText("");
  }

  return (
    <section
      className="card p-3.5 transition-colors"
      style={flash ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
    >
      <textarea
        className="field"
        rows={4}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a job description here — or paste a screenshot anywhere on this page."
      />

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          🖼 Screenshots
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || !text.trim()}
          onClick={commitText}
        >
          Add text
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onAddImages(files);
          e.target.value = "";
        }}
      />
    </section>
  );
}
