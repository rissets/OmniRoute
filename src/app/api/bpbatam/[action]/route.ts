import {
  ownedSelfKey,
  renameSelfKey,
  selfAccount,
  selfKeys,
  selfPrincipal,
  followingKeys,
  followParentKey,
} from "@/lib/db/bpbatamSelfService";
import { mediaSettings } from "@/lib/bpbatam/media";
import {
  changeUserLimits,
  userLimits,
  poolStatus,
  setPoolCap,
  configurePool,
} from "@/lib/db/bpbatamQuotas";
import { operationalEvents } from "@/lib/db/bpbatamEvents";
import { z } from "zod";
import { bridgeIdentity, bridgeRoles } from "@/lib/bpbatam/auth";
import { publishedOffers } from "@/lib/bpbatam/offers";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import {
  createApiKey,
  getApiKeyById,
  updateApiKeyPermissions,
  deleteApiKey,
} from "@/lib/db/apiKeys";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import {
  account,
  accounts,
  within,
  placeAccount,
  allocate,
  principal,
  principals,
  topupRequests,
  requestTopup,
  decideTopup,
  bindPrincipal,
  setOffers,
  setPrincipalActive,
  rotatePrincipal,
  receipts,
  journalBalance,
  reconcile,
  TokenPolicyError,
  applyPolicy,
  subjectKeys,
  subjectKeyCommand,
  bindSubjectKey,
  revokeSubjectKey,
  retirePrimaryKey,
  allocationReceipt,
  admission,
  principalForKey,
} from "@/lib/db/bpbatam";

const schema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("pool-config"),
    command_id: z.string().uuid(),
    mode: z.enum(["set-total", "add"]),
    tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expected_issued: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal("self-key-reveal"),
    subject: z.string().uuid(),
    key_id: z.string().uuid(),
  }),
  z.object({
    op: z.literal("self-key-rename"),
    subject: z.string().uuid(),
    key_id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
  }),
  z.object({
    op: z.literal("self-key-create"),
    subject: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    command_id: z.string().uuid(),
  }),
  z.object({
    op: z.literal("self-key-delete"),
    subject: z.string().uuid(),
    key_id: z.string().uuid(),
  }),
  z.object({
    op: z.literal("pool-cap"),
    ceiling: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({
    op: z.literal("user-limits"),
    subject: z.string().uuid(),
    command_id: z.string().max(200),
    expected_revision: z.number().int().nonnegative(),
    limits: z
      .array(
        z.object({
          window: z.enum(["5h", "7d", "30d"]),
          tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
      )
      .length(3)
      .optional(),
    reset: z
      .array(z.enum(["5h", "7d", "30d"]))
      .min(1)
      .max(3)
      .optional(),
  }),
  z.object({
    op: z.literal("topup-request"),
    id: z.string().max(128),
    target: z.string(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().min(10).max(1000),
  }),
  z.object({ op: z.literal("topup-decision"), id: z.string().max(128), approve: z.boolean() }),
  z.object({
    op: z.literal("media-settings"),
    kind: z.enum(["tts", "stt", "generate", "edit"]),
    action: z.enum(["update", "reset"]),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    op: z.literal("user-key"),
    subject: z.string().uuid(),
    name: z.string().min(1).max(100),
    command_id: z.string().min(1).max(200),
    offers: z.array(z.string()).max(200),
  }),
  z.object({ op: z.literal("revoke-key"), subject: z.string().uuid(), key_id: z.string().uuid() }),
  z.object({
    op: z.literal("policy"),
    subject: z.string().uuid(),
    offers: z.array(z.string()).max(200),
    department_id: z.string(),
    revision: z.number().int().positive(),
    parent: z.string(),
  }),
  z.object({
    op: z.literal("account"),
    id: z.string().min(1).max(128),
    parent: z.string().nullable(),
    kind: z.enum(["platform", "department", "user"]),
  }),
  z.object({
    op: z.literal("grant"),
    id: z.string().min(1).max(128),
    target: z.string(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({
    op: z.literal("transfer"),
    id: z.string().min(1).max(128),
    source: z.string(),
    target: z.string(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({
    op: z.literal("principal"),
    subject: z.string().uuid(),
    issuer: z.string().url(),
    account: z.string(),
  }),
  z.object({
    op: z.literal("assign"),
    subject: z.string().uuid(),
    offers: z.array(z.string()).max(200),
  }),
  z.object({ op: z.literal("active"), subject: z.string().uuid(), active: z.boolean() }),
  z.object({ op: z.literal("rotate"), subject: z.string().uuid() }),
  z.object({
    op: z.literal("reconcile"),
    id: z.string().min(1).max(128),
    receipt: z.string(),
    actual: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().min(10).max(500),
    evidence_reference: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/),
  }),
]);
async function handle(request: Request) {
  const identity = await bridgeIdentity(request);
  if (!identity) return errorResponse(401, "BRIDGE_AUTH_REQUIRED");
  const roles = bridgeRoles(identity);
  const url = new URL(request.url);
  const action = url.pathname.split("/").pop();
  const root = process.env.BPBATAM_CP_ACCOUNT ?? "bpbatam";
  const has = (role: string) => roles.includes("bp:" + role);
  const scope = (id: string) => {
    if (!has("root") && !within(id, root)) throw new TokenPolicyError("ACCOUNT_SCOPE_DENIED", 403);
  };
  try {
    if (request.method === "GET") {
      if (["self-account", "self-keys"].includes(action ?? "") && has("resolve")) {
        const subject = url.searchParams.get("subject") ?? "";
        const person = selfPrincipal(subject);
        scope(person.account_id);
        return Response.json(
          action === "self-account" ? selfAccount(subject) : { keys: selfKeys(subject) },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      if (action === "directory-facts" && has("read")) {
        const after = url.searchParams.get("after") ?? "";
        const people = principals()
          .filter((p) => (has("root") || within(p.account_id, root)) && p.subject > after)
          .sort((a, b) => a.subject.localeCompare(b.subject));
        const page = people.slice(0, 200);
        return Response.json(
          {
            observed_at: new Date().toISOString(),
            next_cursor: people.length > 200 ? page.at(-1)!.subject : null,
            users: page.map((p) => {
              const wallet = account(p.account_id);
              const keys = subjectKeys(p.subject) as {
                key_id: string;
                revoked_at: string | null;
              }[];
              return {
                subject: p.subject,
                account_id: p.account_id,
                active: !!p.active,
                desired_revision: p.desired_revision,
                offers: JSON.parse(p.offers_json),
                balance: wallet ? String(wallet.balance) : null,
                reserved: wallet ? String(wallet.reserved) : null,
                available: wallet ? String(wallet.balance - wallet.reserved) : null,
                limits: userLimits(p.account_id),
                active_keys: keys.filter((k) => !k.revoked_at).length,
                key_ids: keys.map((k) => k.key_id),
              };
            }),
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      if (action === "pool" && has("read")) return Response.json(poolStatus(root));
      if (action === "user-limits" && has("read")) {
        const person = principal(url.searchParams.get("subject") ?? "");
        if (!person) return errorResponse(404, "PRINCIPAL_NOT_FOUND");
        scope(person.account_id);
        return Response.json(userLimits(person.account_id));
      }
      if (action === "media-admission" && has("read")) {
        const receipt = url.searchParams.get("receipt") ?? "";
        if (!receipt || receipt.length > 200) return errorResponse(422, "RECEIPT_REQUIRED");
        const row = admission(receipt);
        if (!row?.account_id) return errorResponse(404, "RESERVATION_NOT_FOUND");
        scope(row.account_id);
        const owner = principalForKey(row.key_id);
        const key = await getApiKeyById(row.key_id);
        return Response.json({
          state: row.state,
          account_id: row.account_id,
          endpoint: row.endpoint,
          model: row.model,
          subject: owner?.subject,
          department_id: row.department_id,
          current_binding:
            !!owner?.active &&
            !!key?.isActive &&
            owner.account_id === row.account_id &&
            (!key.expiresAt || Date.parse(key.expiresAt) > Date.now()) &&
            owner.policy_revision === row.policy_revision,
        });
      }
      if (action === "allocation-receipt" && has("read")) {
        const command = url.searchParams.get("command") ?? "";
        if (!command || command.length > 128) return errorResponse(422, "COMMAND_ID_REQUIRED");
        return Response.json({
          command_id: command,
          postings: allocationReceipt(command).filter(
            (row) => has("root") || within(row.account_id, root)
          ),
        });
      }
      if (action === "topups" && has("read"))
        return Response.json({
          requests: topupRequests().filter((r) => has("root") || within(r.account_id, root)),
        });
      if (action === "media-settings" && has("read")) return Response.json(await mediaSettings());
      if (action === "events" && has("read")) {
        const parsed = z
          .object({
            after: z.coerce.number().int().nonnegative().default(0),
            limit: z.coerce.number().int().min(1).max(500).default(200),
          })
          .safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) return errorResponse(400, "INVALID_EVENT_CURSOR");
        return Response.json(operationalEvents(parsed.data.after, parsed.data.limit, root));
      }
      if (action === "policies" && has("read"))
        return Response.json({
          principals: principals(url.searchParams.get("subject") ?? undefined)
            .filter((p) => has("root") || within(p.account_id, root))
            .map((p) => ({
              subject: p.subject,
              account_id: p.account_id,
              department_id: p.department_id,
              offers: JSON.parse(p.offers_json),
              active: p.active,
              policy_revision: p.policy_revision,
              desired_revision: p.desired_revision,
            })),
        });
      if (action === "keys" && has("read")) {
        const subject = url.searchParams.get("subject") ?? "";
        const p = principal(subject);
        if (!p) return errorResponse(404, "PRINCIPAL_NOT_FOUND");
        scope(p.account_id);
        return Response.json({ keys: subjectKeys(subject), primary_key_id: p.key_id });
      }
      if (action === "capabilities" && has("read"))
        return Response.json({
          version: 1,
          permanent_wallet: true,
          policy_context: true,
          operational_events: true,
          finance: false,
        });
      if (action === "offers" && has("read"))
        return Response.json({ offers: await publishedOffers() });
      if (action === "accounts" && has("read"))
        return Response.json({
          accounts: accounts().filter((a) => has("root") || within(a.id, root)),
          journal_balanced: journalBalance() === 0,
        });
      if (action === "receipts" && has("read")) {
        const id = url.searchParams.get("account");
        if (!id) return errorResponse(400, "ACCOUNT_REQUIRED");
        scope(id);
        return Response.json({ receipts: receipts(id) });
      }
      if (action === "resolve" && has("resolve")) {
        const subject = url.searchParams.get("subject") ?? "";
        const p = principal(subject);
        if (!p || !p.active) return errorResponse(403, "PRINCIPAL_UNAVAILABLE");
        if (!within(p.account_id, root)) return errorResponse(403, "ACCOUNT_SCOPE_DENIED");
        const key = await getApiKeyById(p.key_id);
        if (!key?.key || key.isActive === false) return errorResponse(403, "KEY_UNAVAILABLE");
        return Response.json(
          {
            subject: p.subject,
            issuer: p.issuer,
            key: key.key,
            key_id: p.key_id,
            offers: JSON.parse(p.offers_json),
            account: account(p.account_id),
          },
          { headers: { "cache-control": "no-store" } }
        );
      }
      return errorResponse(403, "BRIDGE_SCOPE_DENIED");
    }
    if (action !== "commands") return errorResponse(404, "BRIDGE_ROUTE_NOT_FOUND");
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return errorResponse(400, "INVALID_BRIDGE_COMMAND");
    const body = parsed.data;
    const actor = identity.sub!;
    if (body.op === "pool-config") {
      if (!has("root")) return errorResponse(403, "ROOT_ISSUER_REQUIRED");
      return Response.json(
        configurePool(body.command_id, body.mode, body.tokens, body.expected_issued, actor)
      );
    }
    if (body.op === "pool-cap") {
      if (!has("root")) return errorResponse(403, "ROOT_ISSUER_REQUIRED");
      setPoolCap(root, body.ceiling);
      return Response.json(poolStatus(root));
    }
    if (body.op === "self-key-reveal" || body.op === "self-key-rename") {
      if (!has("resolve")) return errorResponse(403, "BRIDGE_SCOPE_DENIED");
      const person = selfPrincipal(body.subject);
      scope(person.account_id);
      ownedSelfKey(person.subject, body.key_id);
      if (body.op === "self-key-rename")
        return Response.json(renameSelfKey(person.subject, body.key_id, body.name));
      const key = await getApiKeyById(body.key_id);
      if (!key?.key || key.isActive === false) return errorResponse(404, "SUBJECT_KEY_NOT_FOUND");
      return Response.json(
        { key_id: body.key_id, key: key.key },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (body.op === "self-key-create" || body.op === "self-key-delete") {
      if (!has("resolve")) return errorResponse(403, "BRIDGE_SCOPE_DENIED");
      const person = selfPrincipal(body.subject);
      scope(person.account_id);
      if (body.op === "self-key-delete") {
        revokeSubjectKey(person.subject, body.key_id);
        await updateApiKeyPermissions(body.key_id, { isActive: false });
        return Response.json({ deleted: true });
      }
      let prior = subjectKeyCommand("self:" + body.command_id);
      if (
        prior &&
        (prior.subject !== person.subject || prior.purpose !== "api" || prior.revoked_at)
      )
        return errorResponse(409, "KEY_COMMAND_CONFLICT");
      const offers = JSON.parse(person.offers_json) as { id: string; kind: string }[];
      if (!prior) {
        const pending = await createApiKey(body.name, await getConsistentMachineId(), [], {
          modelAccessMode: "restricted",
          allowedModels: [],
          allowedCombos: [],
          expiresAt: null,
        });
        try {
          bindSubjectKey(person.subject, pending.id, "self:" + body.command_id, body.name);
          followParentKey(pending.id);
        } catch {
          await deleteApiKey(pending.id);
          return errorResponse(409, "KEY_COMMAND_CONFLICT");
        }
        prior = subjectKeyCommand("self:" + body.command_id)!;
      }
      await updateApiKeyPermissions(prior.key_id, {
        modelAccessMode: "restricted",
        allowedModels: offers.filter((o) => o.kind === "model").map((o) => o.id),
        allowedCombos: offers.filter((o) => o.kind === "combo").map((o) => o.id),
        allowedEndpoints: ["chat", "audio", "images", "models", "embeddings"],
        allowAutoCombos: false,
      });
      const key = await getApiKeyById(prior.key_id);
      return Response.json(
        { key_id: prior.key_id, key: key?.key },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (body.op === "user-limits") {
      if (!has("write")) return errorResponse(403, "BRIDGE_SCOPE_DENIED");
      if (
        !!body.limits === !!body.reset ||
        (body.limits && new Set(body.limits.map((l) => l.window)).size !== 3) ||
        (body.reset && new Set(body.reset).size !== body.reset.length)
      )
        return errorResponse(422, "INVALID_USER_WINDOWS");
      const p = principal(body.subject);
      if (!p) return errorResponse(404, "PRINCIPAL_NOT_FOUND");
      scope(p.account_id);
      return Response.json(
        changeUserLimits(body.command_id, p.account_id, body.expected_revision, {
          limits: body.limits,
          reset: body.reset,
        })
      );
    }
    if (body.op === "reconcile") {
      if (!has("root") && !has("reconcile"))
        return errorResponse(403, "RECONCILIATION_SCOPE_REQUIRED");
      const pending = admission(body.receipt);
      if (!pending?.account_id) return errorResponse(404, "RESERVATION_NOT_FOUND");
      scope(pending.account_id);
      return Response.json({
        result: reconcile(
          body.id,
          body.receipt,
          body.actual,
          actor,
          body.reason,
          body.evidence_reference
        ),
      });
    }
    if (body.op === "grant") {
      if (!has("root")) return errorResponse(403, "ROOT_ISSUER_REQUIRED");
      return Response.json({ result: allocate(body.id, null, body.target, body.amount, actor) });
    }
    if (body.op === "topup-decision") {
      if (!has("root")) return errorResponse(403, "ROOT_ISSUER_REQUIRED");
      decideTopup(body.id, body.approve, actor);
      return Response.json({ decided: true });
    }
    if (!has("write")) return errorResponse(403, "BRIDGE_SCOPE_DENIED");
    if (body.op === "topup-request") {
      scope(body.target);
      requestTopup(body.id, body.target, body.amount, actor, body.reason);
      return Response.json({ id: body.id, status: "requested" });
    }
    if (body.op === "media-settings")
      return Response.json(
        await mediaSettings(body.action === "reset" ? "DELETE" : "PUT", body.kind, body.data)
      );
    if (body.op === "account") {
      if (body.parent) scope(body.parent);
      else if (!has("root")) return errorResponse(403, "ROOT_ISSUER_REQUIRED");
      if (account(body.id)) scope(body.id);
      return Response.json({ account: placeAccount(body.id, body.parent, body.kind) });
    }
    if (body.op === "transfer") {
      scope(body.source);
      scope(body.target);
      return Response.json({
        result: allocate(body.id, body.source, body.target, body.amount, actor),
      });
    }
    if (body.op === "principal") {
      scope(body.account);
      if (body.issuer !== process.env.BPBATAM_OIDC_ISSUER)
        return errorResponse(400, "ISSUER_MISMATCH");
      let p = principal(body.subject);
      if (!p) {
        const key = await createApiKey(
          "BP subject " + body.subject,
          await getConsistentMachineId(),
          [],
          { modelAccessMode: "restricted", allowedModels: [], allowedCombos: [], expiresAt: null }
        );
        p = bindPrincipal(body.subject, body.issuer, body.account, key.id);
        if (p.key_id !== key.id) await deleteApiKey(key.id);
      }
      if (p.account_id !== body.account || p.issuer !== body.issuer)
        throw new TokenPolicyError("SUBJECT_BINDING_CONFLICT");
      return Response.json({ subject: p.subject, account: p.account_id, key_id: p.key_id });
    }
    const p = principal(body.subject);
    if (!p) return errorResponse(404, "PRINCIPAL_NOT_FOUND");
    scope(p.account_id);
    if (body.op === "user-key") {
      if (!p.active) return errorResponse(403, "PRINCIPAL_DISABLED");
      const parent = JSON.parse(p.offers_json) as Array<{ id: string; kind: string }>;
      if (body.offers.some((id) => !parent.some((o) => o.id === id)))
        return errorResponse(403, "KEY_CANNOT_EXCEED_PRINCIPAL");
      const selected = parent.filter((o) => body.offers.includes(o.id));
      let prior = subjectKeyCommand(body.command_id);
      if (prior && (prior.subject !== p.subject || prior.purpose !== "api"))
        return errorResponse(409, "KEY_COMMAND_CONFLICT");
      if (prior?.revoked_at) return errorResponse(409, "KEY_ALREADY_REVOKED");
      if (!prior) {
        const pending = await createApiKey(body.name, await getConsistentMachineId(), [], {
          modelAccessMode: "restricted",
          allowedModels: [],
          allowedCombos: [],
          expiresAt: null,
        });
        try {
          bindSubjectKey(p.subject, pending.id, body.command_id, body.name);
        } catch {
          await deleteApiKey(pending.id);
          return errorResponse(409, "KEY_COMMAND_CONFLICT");
        }
        prior = subjectKeyCommand(body.command_id)!;
      }
      await updateApiKeyPermissions(prior.key_id, {
        modelAccessMode: "restricted",
        allowedModels: selected.filter((o) => o.kind === "model").map((o) => o.id),
        allowedCombos: selected.filter((o) => o.kind === "combo").map((o) => o.id),
        allowedEndpoints: ["chat", "audio", "images", "models", "embeddings"],
        allowAutoCombos: false,
      });
      const key = await getApiKeyById(prior.key_id);
      return Response.json({ key_id: prior.key_id, key: key?.key });
    }
    if (body.op === "revoke-key") {
      revokeSubjectKey(p.subject, body.key_id);
      await updateApiKeyPermissions(body.key_id, { isActive: false });
      return Response.json({ revoked: true, key_id: body.key_id });
    }
    if (body.op === "active") {
      setPrincipalActive(p.subject, body.active);
      await updateApiKeyPermissions(p.key_id, { isActive: body.active });
      return Response.json({ active: body.active });
    }
    if (body.op === "rotate") {
      const command = request.headers.get("x-command-id");
      if (!command || command.length > 200) return errorResponse(400, "COMMAND_ID_REQUIRED");
      const offers = JSON.parse(p.offers_json) as Array<{ id: string; kind: string }>;
      const nonce = "primary:" + command;
      let prior = subjectKeyCommand(nonce);
      if (prior && (prior.subject !== p.subject || prior.purpose !== "lc-primary"))
        return errorResponse(409, "KEY_COMMAND_CONFLICT");
      if (
        prior &&
        (prior.revoked_at || (p.key_id !== prior.key_id && p.key_id !== prior.previous_key_id))
      )
        return Response.json({ key_id: prior.key_id, superseded: true });
      if (!prior) {
        const pending = await createApiKey(
          "BP managed subject " + p.subject,
          await getConsistentMachineId(),
          [],
          { modelAccessMode: "restricted", allowedModels: [], allowedCombos: [], expiresAt: null }
        );
        try {
          bindSubjectKey(p.subject, pending.id, nonce, "LibreChat primary", "lc-primary", p.key_id);
        } catch {
          await deleteApiKey(pending.id);
          return errorResponse(409, "KEY_COMMAND_CONFLICT");
        }
        prior = subjectKeyCommand(nonce)!;
      }
      rotatePrincipal(p.subject, prior.key_id);
      await updateApiKeyPermissions(prior.key_id, {
        modelAccessMode: "restricted",
        allowedModels: offers.filter((o) => o.kind === "model").map((o) => o.id),
        allowedCombos: offers.filter((o) => o.kind === "combo").map((o) => o.id),
        allowedEndpoints: ["chat", "audio", "images", "models", "embeddings"],
        allowAutoCombos: false,
        isActive: !!p.active,
      });
      if (prior.previous_key_id) {
        retirePrimaryKey(prior.previous_key_id);
        await deleteApiKey(prior.previous_key_id);
      }
      return Response.json({ key_id: prior.key_id });
    }
    if (body.op === "policy") {
      scope(body.parent);
      if (body.revision < p.desired_revision)
        throw new TokenPolicyError("POLICY_REVISION_STALE", 409);
      if (
        body.revision === p.desired_revision &&
        (p.department_id !== body.department_id ||
          JSON.stringify(JSON.parse(p.offers_json).map((o: { id: string }) => o.id)) !==
            JSON.stringify(body.offers))
      )
        throw new TokenPolicyError("POLICY_REVISION_CONFLICT", 409);
    }
    const catalog = await publishedOffers();
    const selected = body.offers.map((id) => catalog.find((x) => x.id === id));
    if (selected.some((x) => !x)) return errorResponse(400, "OFFER_NOT_PUBLISHED");
    const offers = selected.filter((x): x is NonNullable<typeof x> => !!x);
    // Do not let a client hide a key update failure behind a changed entitlement projection.
    await updateApiKeyPermissions(p.key_id, {
      modelAccessMode: "restricted",
      allowedModels: offers.filter((x) => x.kind === "model").map((x) => x.id),
      allowedCombos: offers.filter((x) => x.kind === "combo").map((x) => x.id),
      allowedEndpoints: ["chat", "audio", "images", "models", "embeddings"],
      allowAutoCombos: false,
    });
    for (const child of followingKeys(p.subject)) {
      await updateApiKeyPermissions(child.key_id, {
        modelAccessMode: "restricted",
        allowedModels: offers.filter((o) => o.kind === "model").map((o) => o.id),
        allowedCombos: offers.filter((o) => o.kind === "combo").map((o) => o.id),
        allowedEndpoints: ["chat", "audio", "images", "models", "embeddings"],
        allowAutoCombos: false,
      });
    }
    if (body.op === "policy")
      applyPolicy(p.subject, offers, body.department_id, body.revision, body.parent);
    else setOffers(p.subject, offers);
    return Response.json({ subject: p.subject, offers });
  } catch (error) {
    return errorResponse(
      error instanceof TokenPolicyError ? error.status : 503,
      error instanceof TokenPolicyError ? error.code : "BRIDGE_UNAVAILABLE"
    );
  }
}
export const GET = handle;
export const POST = handle;
