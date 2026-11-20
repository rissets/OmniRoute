// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import idMessages from "@/i18n/messages/id.json";

function lookupNested(obj: Record<string, unknown>, key: string): string | undefined {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

vi.mock("next-intl", () => ({
  useLocale: () => "id-ID",
  useTranslations: (ns?: string) => {
    const root = (ns ? (idMessages as Record<string, unknown>)[ns] : idMessages) as
      Record<string, unknown> | undefined;
    const translate = (k: string, values?: Record<string, unknown>) => {
      let msg = (root ? lookupNested(root, k) : undefined) ?? k;
      if (values) {
        for (const [vk, vv] of Object.entries(values)) {
          msg = msg.replaceAll(`{${vk}}`, String(vv));
        }
      }
      return msg;
    };
    return Object.assign(translate, {
      has: (k: string) => Boolean(root && lookupNested(root, k)),
      rich: translate,
    });
  },
}));

import BpBatamPoolPage from "@/app/(dashboard)/dashboard/bpbatam/page";

function makePoolPayload(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "bpbatam",
    unit: "micro_credits",
    ceiling: "200000000",
    issued: "200000000",
    remaining: "150000000",
    reserved: "1000000",
    consumed: "50000000",
    issued_micro: 200_000_000,
    remaining_micro: 150_000_000,
    reserved_micro: 1_000_000,
    consumed_micro: 50_000_000,
    available_micro: 149_000_000,
    issued_credits: "200.000000",
    remaining_credits: "150.000000",
    reserved_credits: "1.000000",
    consumed_credits: "50.000000",
    available_credits: "149.000000",
    ref_tokens_per_credit: 152200,
    estimated_tokens: 22_677_800,
    low_balance: false,
    manual_minting_disabled: true,
    topup_url: "https://billing.bpbatam.test/topup?tenant_id=bpbatam",
    digi_sync: {
      synced: true,
      digi_account_id: "bproute-bpbatam",
      last_balance_micro: 150_000_000,
      last_reserved_micro: 1_000_000,
      last_available_micro: 149_000_000,
      last_balance_credits: "150.000000",
      last_reserved_credits: "1.000000",
      last_available_credits: "149.000000",
      base_credit_rupiah: 5000,
      usd_idr_rate: 18255,
      ref_tokens_per_credit: 152200,
      economic_revision: 2,
      last_synced_at: "2026-11-19T12:00:00.000Z",
      last_sync_source: "push",
      last_sync_error: null,
    },
    accounts: [
      {
        id: "bpbatam",
        kind: "platform",
        balance: "150000000",
        reserved: "1000000",
        balance_micro: 150_000_000,
        reserved_micro: 1_000_000,
        balance_credits: "150.000000",
        reserved_credits: "1.000000",
        estimated_tokens: 22_677_800,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BP Batam Pool Page (/dashboard/bpbatam)", () => {
  it("renders Digi Route credit sync status, token equivalents, Top-Up link, and removes all manual minting forms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(makePoolPayload()))
    );

    render(<BpBatamPoolPage />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Pool Kredit BP Batam");
      expect(document.body.textContent).toContain("Status Sinkronisasi Kredit Digi Route");
    });

    // Manual minting forms & inputs must not exist
    expect(document.body.querySelectorAll('input[type="number"]').length).toBe(0);
    expect(document.body.textContent).not.toContain("Simpan total pool");
    expect(document.body.textContent).not.toContain("Tambah token");

    // Credit & Digi Route sync indicators
    expect(document.body.textContent).toContain("Total Kredit Diterima");
    expect(document.body.textContent).toContain("Saldo Kredit Tersisa");
    expect(document.body.textContent).toContain("Estimasi Ekuivalen Token");
    expect(document.body.textContent).toContain("bproute-bpbatam");
    expect(document.body.textContent).toContain("Tersinkronisasi");

    const topupLinks = screen.getAllByRole("link", { name: /Top-Up Pool Kredit/i });
    expect(topupLinks.length).toBeGreaterThan(0);
    expect(topupLinks[0].getAttribute("href")).toBe(
      "https://billing.bpbatam.test/topup?tenant_id=bpbatam"
    );
  });

  it("displays low-balance alert banner when pool remaining <= 10% and triggers pull-sync on button click", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ action: "pull-sync" });
        return Response.json({
          synced: true,
          delta_micro: 100_000_000,
          manual_minting_disabled: true,
          topup_url: "https://billing.bpbatam.test/topup?tenant_id=bpbatam",
          pool: makePoolPayload({
            issued_micro: 300_000_000,
            issued_credits: "300.000000",
            remaining_micro: 115_000_000,
            remaining_credits: "115.000000",
            low_balance: false,
          }),
        });
      }
      return Response.json(
        makePoolPayload({
          remaining_micro: 15_000_000,
          remaining_credits: "15.000000",
          low_balance: true,
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BpBatamPoolPage />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Saldo pool kredit menipis");
    });

    const syncButtons = screen.getAllByRole("button", {
      name: /Sinkronkan Saldo dari Digi Route Sekarang/i,
    });
    await act(async () => {
      syncButtons[0].click();
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("100,00 Kredit baru ditambahkan dari Digi Route");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses useTranslations('bpbatam') and removes hardcoded Indonesian copy from page.tsx", () => {
    const pageSrc = fs.readFileSync(
      path.join(process.cwd(), "src/app/(dashboard)/dashboard/bpbatam/page.tsx"),
      "utf8"
    );
    expect(pageSrc).toContain('useTranslations("bpbatam")');
    expect(pageSrc).not.toContain("Pool Kredit BP Batam");
    expect(pageSrc).not.toContain("Sinkronkan Saldo dari Digi Route Sekarang");
    expect(pageSrc).not.toContain("Belum pernah tersinkronisasi");
  });
});
