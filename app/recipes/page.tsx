"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  clearRecipeData,
  deleteRecipe,
  describeFamily,
  isSettled,
  loadRecipes,
  type Recipe,
} from "@/lib/recipes";

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setRecipes(loadRecipes());
    setHydrated(true);
  }, []);

  if (!hydrated) {
    return <main className="mx-auto max-w-[640px] px-4 py-10 text-sm opacity-60">Loading…</main>;
  }

  const sorted = [...recipes].sort((a, b) => b.sends - a.sends || b.lastUsedAt - a.lastUsedAt);
  const totalSends = recipes.reduce((n, r) => n + r.sends, 0);
  const totalUses = recipes.reduce((n, r) => n + r.uses, 0);
  const settled = recipes.filter(isSettled).length;

  return (
    <main className="mx-auto max-w-[640px] px-4 pb-24 pt-5">
      <header className="mb-4 flex items-center gap-3">
        <Link href="/" className="btn btn-ghost btn-sm">
          ← Back
        </Link>
        <h1 className="text-[19px] font-bold tracking-tight">Recipes</h1>
      </header>

      <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Every email you send teaches the recipe for that kind of role. Send one unchanged and the
        streak grows; edit it before sending and your wording replaces the template. After three
        clean sends in a row a recipe counts as settled.
      </p>

      {recipes.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-2">
          <Stat label="Recipes" value={String(recipes.length)} />
          <Stat label="Drafts served" value={String(totalUses)} />
          <Stat label="Settled" value={`${settled}/${recipes.length}`} />
        </div>
      )}

      {!recipes.length && (
        <p className="py-10 text-center text-sm" style={{ color: "var(--muted)" }}>
          No recipes yet. They appear once you send your first email.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {sorted.map((recipe) => {
          const expanded = open === recipe.key;
          const cleanRate = recipe.sends ? Math.round((recipe.sentClean / recipe.sends) * 100) : 0;
          const good = isSettled(recipe);

          return (
            <article key={recipe.key} className="card overflow-hidden">
              <button
                type="button"
                className="flex w-full items-start gap-3 p-3.5 text-left"
                onClick={() => setOpen(expanded ? null : recipe.key)}
              >
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[14.5px] font-bold">{describeFamily(recipe.key)}</h2>
                  <p className="mt-0.5 truncate text-[12.5px]" style={{ color: "var(--muted)" }}>
                    First written for {recipe.sourceRole || "a role"}
                    {recipe.sourceCompany ? ` at ${recipe.sourceCompany}` : ""}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="chip" style={{ background: "var(--bg)", color: "var(--muted)" }}>
                      used {recipe.uses}×
                    </span>
                    <span className="chip" style={{ background: "var(--bg)", color: "var(--muted)" }}>
                      sent {recipe.sends}×
                    </span>
                    {recipe.sends > 0 && (
                      <span
                        className="chip"
                        style={
                          cleanRate >= 70
                            ? { background: "var(--ok-soft)", color: "var(--ok)" }
                            : { background: "var(--accent-soft)", color: "var(--accent)" }
                        }
                      >
                        {cleanRate}% sent unedited
                      </span>
                    )}
                    {good && (
                      <span
                        className="chip"
                        style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
                      >
                        ✓ settled
                      </span>
                    )}
                  </div>

                  {recipe.sends > 0 && !good && (
                    <div className="mt-2">
                      <div
                        className="h-1.5 w-full overflow-hidden rounded-full"
                        style={{ background: "var(--bg)" }}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, (recipe.cleanStreak / 3) * 100)}%`,
                            background: "var(--accent)",
                          }}
                        />
                      </div>
                      <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
                        {recipe.cleanStreak}/3 clean sends towards settled
                        {recipe.lastEditRatio > 0.02 &&
                          ` · you rewrote ${Math.round(recipe.lastEditRatio * 100)}% last time`}
                      </p>
                    </div>
                  )}
                </div>
                <span className="shrink-0 pt-1 text-sm" style={{ color: "var(--muted)" }}>
                  {expanded ? "▲" : "▼"}
                </span>
              </button>

              {expanded && (
                <div
                  className="border-t px-3.5 pb-3.5 pt-3"
                  style={{ borderColor: "var(--border)" }}
                >
                  <p className="label">Subject template</p>
                  <pre
                    className="mb-3 overflow-x-auto whitespace-pre-wrap rounded-lg px-3 py-2 font-sans text-[12.5px]"
                    style={{ background: "var(--bg)" }}
                  >
                    {recipe.subjectTemplate}
                  </pre>
                  <p className="label">Body template</p>
                  <pre
                    className="overflow-x-auto whitespace-pre-wrap rounded-lg px-3 py-2.5 font-sans text-[12.5px] leading-relaxed"
                    style={{ background: "var(--bg)" }}
                  >
                    {recipe.bodyTemplate}
                  </pre>
                  <p className="mt-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
                    {"{{company}}, {{role}}, {{contact}}, {{location}} and {{reqId}} are filled in per posting."}
                  </p>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm mt-3 w-full"
                    onClick={() => {
                      deleteRecipe(recipe.key);
                      setRecipes(loadRecipes());
                      setOpen(null);
                    }}
                  >
                    Forget this recipe
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {recipes.length > 0 && (
        <button
          type="button"
          className="btn btn-ghost mt-6 w-full"
          onClick={() => {
            if (!window.confirm("Forget every recipe and the cached readings? This cannot be undone.")) {
              return;
            }
            clearRecipeData();
            setRecipes([]);
          }}
        >
          Reset all recipes
        </button>
      )}

      <p className="mt-3 text-center text-[11.5px]" style={{ color: "var(--muted)" }}>
        {totalSends} email{totalSends === 1 ? "" : "s"} have taught these recipes.
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card px-2 py-2.5 text-center">
      <div className="text-[18px] font-bold leading-tight">{value}</div>
      <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
        {label}
      </div>
    </div>
  );
}
