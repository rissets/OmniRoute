"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ApiKey = { id: string; name?: string };
type Reserve = {
  apiKeyId: string;
  period: string;
  monthlyTokenLimit: number;
  baseUserTokens: number;
  sharedAllocatedTokens: number;
  resetDebits: number;
  committedTokens: number;
  shareableTokens: number;
  overcommitted: boolean;
};

const numberFormat = new Intl.NumberFormat("en-US");
const asNumber = (value: string) => {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

export default function OrganizationReservePage() {
  const period = new Date().toISOString().slice(0, 7);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [apiKeyId, setApiKeyId] = useState("");
  const [reserve, setReserve] = useState<Reserve | null>(null);
  const [sourceMonthlyLimit, setSourceMonthlyLimit] = useState("0");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const organizationKeys = useMemo(
    () => keys.filter((key) => /organization reserve|org.*reserve/i.test(key.name || "")),
    [keys]
  );

  useEffect(() => {
    fetch("/api/keys")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const rows = Array.isArray(payload) ? payload : payload?.keys;
        const next = Array.isArray(rows) ? rows : [];
        setKeys(next);
        setApiKeyId(next.find((key) => /organization reserve|org.*reserve/i.test(key.name || ""))?.id || "");
      })
      .catch(() => setMessage("Unable to load management keys."));
  }, []);

  const loadReserve = useCallback(async () => {
    if (!apiKeyId) return;
    const response = await fetch(`/api/usage/organization-reserve?apiKeyId=${encodeURIComponent(apiKeyId)}&period=${period}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Unable to load reserve");
    setReserve(payload);
    setSourceMonthlyLimit(String(payload.monthlyTokenLimit || 0));
  }, [apiKeyId, period]);

  useEffect(() => {
    loadReserve().catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load reserve"));
  }, [loadReserve]);

  async function savePlatformBudget() {
    if (!apiKeyId || asNumber(sourceMonthlyLimit) <= 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/usage/organization-reserve", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKeyId, period, monthlyTokenLimit: asNumber(sourceMonthlyLimit) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || "Unable to save platform budget");
      setReserve(payload.reserve);
      setSourceMonthlyLimit(String(payload.reserve.monthlyTokenLimit || 0));
      setMessage("Platform budget saved. The operator dashboard can now distribute this reserve to users.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save platform budget");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-text-muted">Costs · Governance</p>
        <h1 className="mt-2 text-3xl font-semibold text-text-main">Platform Budget</h1>
        <p className="mt-2 max-w-3xl text-sm text-text-muted">
          Set the single monthly token budget for the BP Batam platform. Per-user limits, sharing, and short-window resets are managed from the operator dashboard.
        </p>
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm text-text-muted">
          <strong className="text-text-main">Platform budget:</strong> set the total monthly token budget here (for example 1,000,000,000). The operator dashboard then assigns the default allowance, shared tokens, and short-window reset grants to individual users. This page never creates a per-user allowance.
        </div>
      </header>
      <section className="rounded-xl border border-border bg-bg-subtle/30 p-5">
        <label className="text-xs font-semibold uppercase tracking-wide text-text-muted">Organization management key</label>
        <select value={apiKeyId} onChange={(event) => setApiKeyId(event.target.value)} className="mt-2 w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-text-main">
          <option value="">Select the organization reserve key</option>
          {organizationKeys.map((key) => <option key={key.id} value={key.id}>{key.name || key.id}</option>)}
        </select>
        {!organizationKeys.length && <p className="mt-2 text-xs text-amber-400">No organization reserve key was found. Create or provision the BP Batam organization reserve before configuring commitments.</p>}
      </section>
      {reserve && (
        <>
          <section className="grid gap-4 md:grid-cols-4">
            {[
              ["Source monthly reserve", reserve.monthlyTokenLimit, "text-text-main"],
              ["Base user grants", reserve.baseUserTokens, "text-text-muted"],
              ["Reset grants", reserve.resetDebits, "text-amber-400"],
              ["Shareable balance", reserve.shareableTokens, reserve.overcommitted ? "text-red-400" : "text-emerald-400"],
            ].map(([label, value, tone]) => <div key={label as string} className="rounded-xl border border-border bg-bg-subtle/30 p-4"><div className="text-xs text-text-muted">{label}</div><div className={`mt-2 text-2xl font-semibold ${tone}`}>{numberFormat.format(value as number)}</div></div>)}
          </section>
          <section className="rounded-xl border border-primary/30 bg-primary/5 p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-text-main">Platform monthly budget</h2>
                <p className="mt-1 max-w-2xl text-sm text-text-muted">This is the total reserve granted to BP Batam. It is separate from each user&apos;s 5-hour, weekly, and monthly limits.</p>
              </div>
              <div className="flex min-w-[320px] gap-2">
                <input value={sourceMonthlyLimit} onChange={(event) => setSourceMonthlyLimit(event.target.value)} className="w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-text-main" inputMode="numeric" aria-label="Platform monthly token budget" />
                <button type="button" disabled={busy || asNumber(sourceMonthlyLimit) <= 0} onClick={savePlatformBudget} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save budget</button>
              </div>
            </div>
          </section>
          <section className="rounded-xl border border-border bg-bg-subtle/30 p-5 space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text-main">Operator allocation readback · {reserve.period}</h2>
                <p className="mt-1 text-sm text-text-muted">These values are written by the operator dashboard after a share or reset. They are read-only here so the platform total cannot be accidentally overwritten.</p>
              </div>
              <button type="button" onClick={() => loadReserve().catch((error) => setMessage(error instanceof Error ? error.message : "Unable to refresh reserve"))} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-main">Refresh</button>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              {[["Base user grants", reserve.baseUserTokens], ["Shared allocations", reserve.sharedAllocatedTokens], ["Reset grants", reserve.resetDebits], ["Committed", reserve.committedTokens]].map(([label, value]) => <div key={label as string} className="rounded-lg border border-border p-3"><div className="text-xs text-text-muted">{label}</div><div className="mt-1 text-lg font-semibold text-text-main">{numberFormat.format(value as number)}</div></div>)}
            </div>
          </section>
          <p className={`text-sm ${message?.toLowerCase().includes("unable") || message?.toLowerCase().includes("exceed") ? "text-red-400" : "text-emerald-400"}`}>{message}</p>
        </>
      )}
    </main>
  );
}
