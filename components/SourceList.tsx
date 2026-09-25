"use client";

import { useEffect, useRef } from "react";
import type { SourceItem } from "@/lib/types";

/** Past this many, the list scrolls inside itself so the run button stays put. */
const SCROLL_AFTER = 4;

type Props = {
  items: SourceItem[];
  onRemove: (id: string) => void;
  onMergeUp: (id: string) => void;
  onSplit: (id: string) => void;
  disabled?: boolean;
};

export default function SourceList({ items, onRemove, onMergeUp, onSplit, disabled }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const count = items.length;

  // Keep the newest paste in view as the list grows.
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [count]);

  if (!items.length) return null;

  // Consecutive items sharing a groupId are pages of one posting.
  const groupNumbers = new Map<string, number>();
  for (const item of items) {
    if (!groupNumbers.has(item.groupId)) groupNumbers.set(item.groupId, groupNumbers.size + 1);
  }

  const scrolls = count > SCROLL_AFTER;
  const jobCount = new Set(items.map((i) => i.groupId)).size;

  return (
    <section className="mt-3">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <p className="text-[12.5px] font-semibold" style={{ color: "var(--muted)" }}>
          {count} item{count === 1 ? "" : "s"} · {jobCount} job{jobCount === 1 ? "" : "s"}
        </p>
        {scrolls && (
          <p className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            scroll for more
          </p>
        )}
      </div>

      <div
        ref={listRef}
        className={`flex flex-col gap-2${scrolls ? " overflow-y-auto pr-0.5" : ""}`}
        style={
          scrolls
            ? { maxHeight: "44vh", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }
            : undefined
        }
      >
        {items.map((item, index) => {
        const previous = items[index - 1];
        const mergedWithPrevious = previous?.groupId === item.groupId;
        const groupSize = items.filter((i) => i.groupId === item.groupId).length;

        return (
          <div key={item.id} className="card flex items-center gap-3 p-2.5">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg"
              style={{ background: "var(--bg)" }}
            >
              {item.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.preview} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-lg">📄</span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className="chip"
                  style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                >
                  Job {groupNumbers.get(item.groupId)}
                </span>
                {groupSize > 1 && (
                  <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                    {groupSize} parts
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-[13px]" style={{ color: "var(--muted)" }}>
                {item.kind === "image" ? "Screenshot" : item.text.slice(0, 70)}
              </p>
            </div>

            <div className="flex shrink-0 gap-1.5">
              {index > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={disabled}
                  title={
                    mergedWithPrevious
                      ? "Split into its own job"
                      : "Same job as the one above"
                  }
                  onClick={() => (mergedWithPrevious ? onSplit(item.id) : onMergeUp(item.id))}
                >
                  {mergedWithPrevious ? "Split" : "Merge ↑"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={disabled}
                aria-label="Remove"
                onClick={() => onRemove(item.id)}
              >
                ✕
              </button>
            </div>
          </div>
        );
        })}
      </div>
    </section>
  );
}
