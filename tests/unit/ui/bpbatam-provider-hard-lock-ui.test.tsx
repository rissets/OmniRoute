// @vitest-environment jsdom
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
let mockParams: Record<string, string> = { id: "openai" };
let mockSearchParams = new URLSearchParams();

vi.mock("next-intl", () => ({
  useTranslations: () =>
    Object.assign((k: string) => k, {
      has: () => false,
      rich: (k: string) => k,
    }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn(), replace: vi.fn() }),
  useParams: () => mockParams,
  useSearchParams: () => mockSearchParams,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ProviderSummaryCard, {
  type ProviderSummaryStats,
} from "@/app/(dashboard)/dashboard/providers/components/ProviderSummaryCard";
import AddCompatibleProviderModal from "@/app/(dashboard)/dashboard/providers/components/AddCompatibleProviderModal";
import ProviderOnboardingWizard from "@/app/(dashboard)/dashboard/providers/components/onboarding/ProviderOnboardingWizard";
import ProvidersPage from "@/app/(dashboard)/dashboard/providers/page";

const stats: ProviderSummaryStats = {
  all: { configured: 1, total: 2 },
  free: { configured: 0, total: 0 },
  noauth: { configured: 0, total: 0 },
  oauth: { configured: 0, total: 0 },
  apikey: { configured: 0, total: 0 },
  compatible: { configured: 1, total: 2 },
  webcookie: { configured: 0, total: 0 },
  search: { configured: 0, total: 0 },
  audio: { configured: 0, total: 0 },
  local: { configured: 0, total: 0 },
  upstreamproxy: { configured: 0, total: 0 },
  cloudagent: { configured: 0, total: 0 },
  ide: { configured: 0, total: 0 },
  webfetch: { configured: 0, total: 0 },
};

const t = Object.assign((k: string) => k, { has: () => false });

beforeEach(() => {
  vi.clearAllMocks();
  mockParams = { id: "openai" };
  mockSearchParams = new URLSearchParams();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BP Route Provider Hard-Lock UI", () => {
  it("ProviderSummaryCard hides built-in category chips, media chips, and file import when hardLockEnabled=true", () => {
    const onBatchTest = vi.fn();
    render(
      <ProviderSummaryCard
        hardLockEnabled
        activeCategory={null}
        activeServiceKind={null}
        onServiceKindChange={() => {}}
        disabledConfigured={false}
        displayMode="all"
        modelSearchQuery=""
        onBatchTest={onBatchTest}
        onCategoryChange={() => {}}
        onDisplayModeChange={() => {}}
        onNewProvider={() => {}}
        onImportFromFile={() => {}}
        searchQuery=""
        setModelSearchQuery={() => {}}
        setSearchQuery={() => {}}
        showFreeOnly={false}
        summaryStats={stats}
        t={t}
        tc={t}
        testingMode={null}
      />
    );

    expect(screen.queryByText("oauthLabel")).toBeNull();
    expect(screen.queryByText("apiKeyLabel")).toBeNull();
    expect(screen.queryByText("freeTier")).toBeNull();
    expect(screen.queryByText("serviceKindImage")).toBeNull();
    expect(screen.queryByText("importFromFile")).toBeNull();

    const testAllBtn = screen.getByRole("button", { name: "testAll" });
    act(() => testAllBtn.click());
    expect(onBatchTest).toHaveBeenCalledWith("compatible");
  });

  it("AddCompatibleProviderModal blocks CC mode submission when hardLockEnabled=true", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <AddCompatibleProviderModal
        isOpen
        hardLockEnabled
        mode="cc"
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toMatch(/BP Route/i);
    const addBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "add"
    );
    expect(addBtn?.disabled).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ProviderOnboardingWizard goes directly to OpenAI/Anthropic custom compatible step when hard-locked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === "/api/provider-nodes") {
          return Response.json({
            nodes: [],
            bpRouteProviderHardLock: true,
            ccCompatibleProviderEnabled: true,
          });
        }
        return Response.json({});
      })
    );

    render(<ProviderOnboardingWizard />);

    await waitFor(() => {
      expect(
        document.body.textContent?.includes("Create custom compatible provider") ||
          document.body.textContent?.includes("onboardingCreateCustomCompatibleProvider")
      ).toBe(true);
    });

    expect(document.body.textContent).not.toContain("API-key provider");
    expect(document.body.textContent).not.toContain("OAuth provider");
    const options = Array.from(document.body.querySelectorAll("option")).map((o) =>
      o.getAttribute("value")
    );
    expect(options).toEqual(["openai", "anthropic"]);
  });

  it("ProvidersPage renders ONLY compatible Digi Route endpoints and hides all built-in provider sections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === "/api/providers") {
          return Response.json({
            connections: [
              {
                id: "conn-1",
                provider: "openai-compatible-chat-digi",
                authType: "apikey",
                name: "Digi Route Primary",
                isActive: true,
                testStatus: "active",
              },
            ],
            total: 1,
          });
        }
        if (u === "/api/provider-nodes") {
          return Response.json({
            nodes: [
              {
                id: "openai-compatible-chat-digi",
                name: "Digi Route OpenAI",
                prefix: "digi-oai",
                type: "openai-compatible",
                apiType: "chat",
                baseUrl: "https://digi-route.example.com/v1",
              },
              {
                id: "anthropic-compatible-digi",
                name: "Digi Route Anthropic",
                prefix: "digi-ant",
                type: "anthropic-compatible",
                baseUrl: "https://digi-route.example.com/v1",
              },
            ],
            bpRouteProviderHardLock: true,
            ccCompatibleProviderEnabled: true,
          });
        }
        if (u === "/api/settings") {
          return Response.json({ bpRouteProviderHardLock: true, blockedProviders: [] });
        }
        if (u === "/api/providers/expiration") {
          return Response.json({ list: [], summary: { expired: 0, expiringSoon: 0 } });
        }
        if (u === "/api/providers/openrouter-stats") {
          return Response.json({ data: [] });
        }
        if (u.includes("/api/providers/")) {
          return Response.json({});
        }
        return Response.json({});
      })
    );

    render(<ProvidersPage />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Digi Route OpenAI");
      expect(document.body.textContent).toContain("Digi Route Anthropic");
    });

    expect(document.body.textContent).not.toContain("oauthProviders");
    expect(document.body.textContent).not.toContain("apiKeyProviders");
    expect(document.body.textContent).not.toContain("freeTierProviders");
    expect(document.body.textContent).not.toContain("addCcCompatible");
    expect(document.body.textContent).toContain("addOpenAICompatible");
    expect(document.body.textContent).toContain("addAnthropicCompatible");
  });

  it("ProviderDetailPageClient blocks direct navigation to built-in providers under hard-lock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === "/api/provider-nodes") {
          return Response.json({ nodes: [], bpRouteProviderHardLock: true });
        }
        if (u === "/api/settings/proxy") {
          return Response.json({});
        }
        return Response.json({ connections: [] });
      })
    );

    const { default: ProviderDetailPageClient } =
      await import("@/app/(dashboard)/dashboard/providers/[id]/ProviderDetailPageClient");

    mockParams = { id: "openai" };
    render(<ProviderDetailPageClient />);

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/BP Route/i);
    });
    expect(document.body.textContent).toContain("backToProviders");
    expect(document.body.textContent).not.toContain("availableModels");
  });
});
