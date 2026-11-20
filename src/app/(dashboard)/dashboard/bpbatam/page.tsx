"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert } from "@omniroute/ui-kit/alert";
import { buttonVariants } from "@omniroute/ui-kit/button";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Stat, StatRow } from "@omniroute/ui-kit/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@omniroute/ui-kit/table";
import { Badge, Button, Card, CardSkeleton, EmptyState, Icon } from "@/shared/components";

type PoolAccount = {
  id: string;
  kind: string;
  balance: string;
  reserved: string;
  balance_micro?: number;
  reserved_micro?: number;
  balance_credits?: string;
  reserved_credits?: string;
  estimated_tokens?: number;
};

type DigiSyncState = {
  synced: boolean;
  digi_account_id: string | null;
  last_balance_micro: number;
  last_reserved_micro: number;
  last_available_micro: number;
  last_balance_credits: string;
  last_reserved_credits: string;
  last_available_credits: string;
  base_credit_rupiah: number;
  usd_idr_rate: number;
  ref_tokens_per_credit: number;
  economic_revision: number;
  last_synced_at: string | null;
  last_sync_source: string | null;
  last_sync_error: string | null;
};

type PoolPayload = {
  account_id: string;
  unit?: string;
  ceiling: string;
  issued: string;
  remaining: string;
  reserved: string;
  consumed: string;
  issued_micro: number;
  remaining_micro: number;
  reserved_micro: number;
  consumed_micro: number;
  available_micro: number;
  issued_credits: string;
  remaining_credits: string;
  reserved_credits: string;
  consumed_credits: string;
  available_credits: string;
  ref_tokens_per_credit: number;
  estimated_tokens: number;
  low_balance?: boolean;
  manual_minting_disabled?: boolean;
  topup_url?: string;
  digi_sync?: DigiSyncState;
  accounts: PoolAccount[];
};

const formatInteger = (value: number, locale: string) => Math.round(value).toLocaleString(locale);

const formatCredits = (
  creditsStr: string | undefined,
  microFallback: number,
  locale: string
): string => {
  const num = creditsStr !== undefined ? Number(creditsStr) : microFallback / 1_000_000;
  if (!Number.isFinite(num)) {
    return (0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return num.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
};

const formatSyncTime = (
  iso: string | null | undefined,
  locale: string,
  neverSyncedLabel: string
): string => {
  if (!iso) return neverSyncedLabel;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

export default function BpBatamPoolPage() {
  const t = useTranslations("bpbatam");
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const locale = useLocale();
  const [pool, setPool] = useState<PoolPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [syncNotice, setSyncNotice] = useState("");

  const accountKindLabel = (kind: string): string => {
    if (kind === "platform") return t("accountKind.platform");
    if (kind === "department") return t("accountKind.department");
    if (kind === "user") return t("accountKind.user");
    return kind;
  };

  const loadPool = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/bpbatam-pool", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(tRef.current("errors.ownerRequired"));
      }
      const data = (await response.json()) as PoolPayload;
      setPool(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : tRef.current("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/bpbatam-pool", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(tRef.current("errors.ownerRequired"));
        }
        return (await response.json()) as PoolPayload;
      })
      .then((data) => {
        if (!active) return;
        setPool(data);
        setError("");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : tRef.current("errors.loadFailed"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handlePullSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError("");
    setSyncNotice("");
    try {
      const response = await fetch("/api/bpbatam-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull-sync" }),
      });
      const data = (await response.json().catch(() => ({}))) as PoolPayload & {
        pool?: PoolPayload;
        delta_micro?: number;
        code?: string;
      };
      if (!response.ok) {
        throw new Error(
          data.code ? t("errors.syncFailedWithCode", { code: data.code }) : t("errors.syncFailed")
        );
      }
      if (data.pool) {
        setPool({
          ...data.pool,
          topup_url: data.topup_url ?? pool?.topup_url,
          manual_minting_disabled: data.manual_minting_disabled ?? true,
        });
      } else {
        await loadPool();
      }
      const addedMicro = Number(data.delta_micro ?? 0);
      setSyncNotice(
        addedMicro > 0
          ? t("notices.syncAdded", { credits: formatCredits(undefined, addedMicro, locale) })
          : t("notices.syncUpToDate")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.syncExecutionFailed"));
    } finally {
      setSyncing(false);
    }
  };

  const topupUrl = pool?.topup_url ?? "http://127.0.0.1:3090/?tenant_id=bpbatam";
  const syncState = pool?.digi_sync;
  const issuedCreditsNum = Number(pool?.issued_credits ?? (pool?.issued_micro ?? 0) / 1_000_000);
  const remainingCreditsNum = Number(
    pool?.remaining_credits ?? (pool?.remaining_micro ?? 0) / 1_000_000
  );
  const consumedCreditsNum = Number(
    pool?.consumed_credits ?? (pool?.consumed_micro ?? 0) / 1_000_000
  );
  const refTokensPerCredit =
    pool?.ref_tokens_per_credit ?? syncState?.ref_tokens_per_credit ?? 152200;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        compact
        eyebrow={t("header.eyebrow")}
        title={t("header.title")}
        description={t("header.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              icon="sync"
              loading={syncing}
              disabled={loading || syncing}
              onClick={() => void handlePullSync()}
            >
              {syncing ? t("actions.syncing") : t("actions.syncNow")}
            </Button>
            <a
              href={topupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Icon name="open_in_new" size={16} />
              {t("actions.topUp")}
            </a>
          </div>
        }
      />

      {error && (
        <Alert
          variant="critical"
          icon={<Icon name="error" size={18} />}
          title={t("alerts.errorTitle")}
          description={error}
          actions={
            <Button size="sm" variant="outline" icon="refresh" onClick={() => void loadPool()}>
              {t("actions.reload")}
            </Button>
          }
        />
      )}

      {syncNotice && (
        <Alert
          variant="success"
          icon={<Icon name="check_circle" size={18} />}
          title={t("alerts.syncUpdatedTitle")}
          description={syncNotice}
          onDismiss={() => setSyncNotice("")}
        />
      )}

      {pool?.low_balance && (
        <Alert
          variant="warning"
          icon={<Icon name="warning" size={18} />}
          title={t("alerts.lowBalanceTitle")}
          description={t("alerts.lowBalanceDescription", {
            credits: formatCredits(pool.remaining_credits, pool.remaining_micro, locale),
            tokens: formatInteger(pool.estimated_tokens, locale),
          })}
          actions={
            <a
              href={topupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "default", size: "sm" })}
            >
              <Icon name="open_in_new" size={16} />
              {t("actions.topUp")}
            </a>
          }
        />
      )}

      {loading && !pool ? (
        <div className="grid gap-4 md:grid-cols-2">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : null}

      {pool && (
        <>
          <Card padding="md">
            <StatRow columns={4}>
              <Stat
                label={t("stats.issuedLabel")}
                value={issuedCreditsNum}
                locale={locale}
                numberFormatOptions={{ minimumFractionDigits: 2, maximumFractionDigits: 4 }}
                suffix={t("stats.creditSuffix")}
                hint={t("stats.issuedHint", { micro: formatInteger(pool.issued_micro, locale) })}
              />
              <Stat
                label={t("stats.remainingLabel")}
                value={remainingCreditsNum}
                locale={locale}
                numberFormatOptions={{ minimumFractionDigits: 2, maximumFractionDigits: 4 }}
                suffix={t("stats.creditSuffix")}
                tone={pool.low_balance ? "critical" : "positive"}
                hint={t("stats.remainingHint", {
                  tokens: formatInteger(pool.estimated_tokens, locale),
                })}
              />
              <Stat
                label={t("stats.consumedLabel")}
                value={consumedCreditsNum}
                locale={locale}
                numberFormatOptions={{ minimumFractionDigits: 2, maximumFractionDigits: 4 }}
                suffix={t("stats.creditSuffix")}
                hint={t("stats.consumedHint", {
                  reserved: formatCredits(pool.reserved_credits, pool.reserved_micro, locale),
                })}
              />
              <Stat
                label={t("stats.estimatedTokensLabel")}
                value={pool.estimated_tokens}
                locale={locale}
                numberFormatOptions={{ maximumFractionDigits: 0 }}
                suffix={t("stats.tokenSuffix")}
                hint={t("stats.estimatedTokensHint", {
                  refTokens: formatInteger(refTokensPerCredit, locale),
                })}
              />
            </StatRow>
          </Card>

          <Card
            title={t("syncCard.title")}
            subtitle={t("syncCard.subtitle")}
            action={
              <Badge
                variant={
                  syncState?.last_sync_error ? "error" : syncState?.synced ? "success" : "warning"
                }
              >
                {syncState?.last_sync_error
                  ? t("syncCard.badgeError")
                  : syncState?.synced
                    ? t("syncCard.badgeSynced")
                    : t("syncCard.badgePending")}
              </Badge>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-subtle p-4">
                <span className="text-xs font-medium text-text-muted">
                  {t("syncCard.digiAccountLabel")}
                </span>
                <span className="font-mono text-sm font-medium text-text-main">
                  {syncState?.digi_account_id || pool.account_id}
                </span>
                <span className="text-xs text-text-muted">
                  {t("syncCard.lastSource", {
                    source: syncState?.last_sync_source ?? t("syncCard.noSource"),
                  })}
                </span>
              </div>

              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-subtle p-4">
                <span className="text-xs font-medium text-text-muted">
                  {t("syncCard.lastBalanceLabel")}
                </span>
                <span className="text-sm font-semibold tabular-nums text-text-main">
                  {t("syncCard.availableCredits", {
                    credits: formatCredits(
                      syncState?.last_available_credits,
                      syncState?.last_available_micro ?? 0,
                      locale
                    ),
                  })}
                </span>
                <span className="text-xs tabular-nums text-text-muted">
                  {t("syncCard.balanceBreakdown", {
                    total: formatCredits(
                      syncState?.last_balance_credits,
                      syncState?.last_balance_micro ?? 0,
                      locale
                    ),
                    reserved: formatCredits(
                      syncState?.last_reserved_credits,
                      syncState?.last_reserved_micro ?? 0,
                      locale
                    ),
                  })}
                </span>
              </div>

              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-subtle p-4">
                <span className="text-xs font-medium text-text-muted">
                  {t("syncCard.lastSyncLabel")}
                </span>
                <span className="text-sm font-medium tabular-nums text-text-main">
                  {formatSyncTime(syncState?.last_synced_at, locale, t("neverSynced"))}
                </span>
                <span className="text-xs text-text-muted">
                  {syncState?.last_sync_error
                    ? t("syncCard.syncErrorNote", { error: syncState.last_sync_error })
                    : t("syncCard.noSyncErrors")}
                </span>
              </div>

              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-subtle p-4">
                <span className="text-xs font-medium text-text-muted">
                  {t("syncCard.economicsLabel")}
                </span>
                <span className="text-sm font-medium tabular-nums text-text-main">
                  {t("syncCard.creditValueIdr", {
                    rupiah: formatInteger(syncState?.base_credit_rupiah ?? 5000, locale),
                  })}
                </span>
                <span className="text-xs tabular-nums text-text-muted">
                  {t("syncCard.fxAndRevision", {
                    rate: formatInteger(syncState?.usd_idr_rate ?? 18255, locale),
                    revision: syncState?.economic_revision ?? 1,
                  })}
                </span>
              </div>

              <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-subtle p-4 sm:col-span-2">
                <span className="text-xs font-medium text-text-muted">
                  {t("syncCard.policyLabel")}
                </span>
                <div className="flex items-center gap-2 text-sm font-medium text-text-main">
                  <Icon name="lock" size={16} className="text-text-muted" />
                  <span>{t("syncCard.policyTitle")}</span>
                </div>
                <span className="text-xs text-text-muted">{t("syncCard.policyDescription")}</span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <span className="text-xs text-text-muted">
                {t("syncCard.footerNote", { tenant: pool.account_id })}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  icon="sync"
                  loading={syncing}
                  disabled={syncing}
                  onClick={() => void handlePullSync()}
                >
                  {syncing ? t("actions.syncing") : t("actions.syncNow")}
                </Button>
                <a
                  href={topupUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ variant: "default", size: "sm" })}
                >
                  <Icon name="open_in_new" size={16} />
                  {t("actions.topUp")}
                </a>
              </div>
            </div>
          </Card>

          <Card title={t("accountsCard.title")} subtitle={t("accountsCard.subtitle")}>
            {pool.accounts.length === 0 ? (
              <EmptyState
                icon="account_balance_wallet"
                title={t("accountsCard.emptyTitle")}
                description={t("accountsCard.emptyDescription")}
              />
            ) : (
              <Table persistentScrollbars={false}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("accountsCard.columns.account")}</TableHead>
                    <TableHead>{t("accountsCard.columns.kind")}</TableHead>
                    <TableHead className="text-right">
                      {t("accountsCard.columns.balance")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("accountsCard.columns.reserved")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("accountsCard.columns.estimatedTokens")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pool.accounts.map((acc) => {
                    const balMicro = acc.balance_micro ?? Number(acc.balance ?? 0);
                    const resMicro = acc.reserved_micro ?? Number(acc.reserved ?? 0);
                    const estTokens =
                      acc.estimated_tokens ??
                      Math.round(
                        (Math.max(0, balMicro - resMicro) / 1_000_000) * refTokensPerCredit
                      );
                    return (
                      <TableRow key={acc.id}>
                        <TableCell className="font-mono text-xs">{acc.id}</TableCell>
                        <TableCell>
                          <Badge variant={acc.kind === "platform" ? "primary" : "default"}>
                            {accountKindLabel(acc.kind)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCredits(acc.balance_credits, balMicro, locale)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCredits(acc.reserved_credits, resMicro, locale)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-text-muted">
                          {formatInteger(estTokens, locale)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
