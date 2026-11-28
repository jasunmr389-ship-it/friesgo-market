// FriesGo Global V2.1 M2-A Cloud API Worker Entrypoint
// Security: strict Origin allowlist, Bearer session auth on every private endpoint,
// Cache-Control: no-store on all responses, zero unauthenticated access to company data.

import { checkSystemMaintenanceGate, EXPECTED_SCHEMA_VERSION, handleAuthRoutes, probeSchemaHealth } from "./auth.js";
import { handleAdminRoutes } from "./routes/admin.js";
import { handleCompanyRoutes } from "./routes/companies.js";
import { handleEventRoutes } from "./routes/events.js";
import { handleFeedbackRoutes } from "./routes/feedback.js";
import { handleGmapsRoutes } from "./routes/gmaps.js";
import { handleLockRoutes } from "./routes/locks.js";
import { handleMigrateRoutes } from "./routes/migrate.js";
import { handlePublicIntakeRoutes } from "./routes/public_intake.js";
import { handleV3WorkspaceRoutes } from "./routes/v3_workspace.js";
import { buildCorsHeaders, isOriginAllowed, json, nowIso } from "./utils.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const reqOrigin = request.headers.get("Origin") || "";
    const cors = buildCorsHeaders(request, env);

    // Reject disallowed browser Origins strictly with 403
    if (reqOrigin && !isOriginAllowed(reqOrigin, env)) {
      return json({ error: "来源域名不在安全白名单内 (403 Origin Denied)", code: "ORIGIN_DENIED" }, 403, cors);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Public health endpoint (exposes zero secrets/private data; actively verifies DB schema & maintenance gate)
    if (url.pathname === "/api/health" && request.method === "GET") {
      const hasDb = Boolean(env && env.DB);
      const hasSecrets = Boolean(env && env.AUTH_PEPPER && env.TOTP_ENC_KEY);
      let bootstrapped = false;
      let schemaProbe = {
        schemaVersion: 0,
        expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
        schemaReady: false,
        missingSchema: hasDb ? ["schema_unprobed"] : ["database_binding"],
      };
      let gate = {
        allowed: false,
        frozen: true,
        readable: false,
        code: "SYSTEM_MAINTENANCE_STATE_UNAVAILABLE",
        latestJob: null,
      };

      if (hasDb) {
        schemaProbe = await probeSchemaHealth(env.DB, env);
        try {
          const row = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM employees").first();
          bootstrapped = Number((row && row.cnt) || 0) > 0;
        } catch {
          bootstrapped = false;
        }
        gate = await checkSystemMaintenanceGate(env.DB);
      }

      const ready = hasDb && hasSecrets && schemaProbe.schemaReady && gate.readable;
      const unreadyReasons = [];
      if (!hasDb) unreadyReasons.push("DATABASE_BINDING_MISSING");
      if (!hasSecrets) unreadyReasons.push("CORE_SECRETS_MISSING");
      if (!schemaProbe.schemaReady) unreadyReasons.push("SCHEMA_MIGRATION_INCOMPLETE");
      if (!gate.readable) unreadyReasons.push(gate.code || "SYSTEM_MAINTENANCE_STATE_UNAVAILABLE");

      return json(
        {
          ok: ready,
          service: "friesgo-api",
          version: schemaProbe.schemaVersion >= 4 ? "v3.0-slice1" : "v2.1-m2a",
          buildCommit: (env && env.BUILD_COMMIT) || "dev-local",
          schemaVersion: schemaProbe.schemaVersion,
          expectedSchemaVersion: schemaProbe.expectedSchemaVersion,
          schemaReady: schemaProbe.schemaReady,
          missingSchema: schemaProbe.missingSchema,
          maintenanceReadable: gate.readable,
          unreadyReasons,
          environment: (env && env.ENVIRONMENT) || "unknown",
          bootstrapped,
          restoreFrozen: !gate.allowed,
          maintenanceGateCode: gate.code || null,
          latestRestoreJob: gate.latestJob
            ? {
                job_id: gate.latestJob.job_id,
                status: gate.latestJob.status,
                started_at: gate.latestJob.started_at,
                finished_at: gate.latestJob.finished_at || null,
                verified_at: gate.latestJob.verified_at || null,
              }
            : null,
          timestamp: nowIso(),
        },
        ready ? 200 : 503,
        cors
      );
    }

    if (!env || !env.DB || !env.AUTH_PEPPER || !env.TOTP_ENC_KEY) {
      return json(
        { error: "服务端数据库或核心加密密钥未就绪 (503 Fail-Closed)", code: "SERVER_MISCONFIGURED" },
        503,
        cors
      );
    }

    try {
      const handlers = [
        handlePublicIntakeRoutes,
        handleAuthRoutes,
        handleV3WorkspaceRoutes,
        handleAdminRoutes,
        handleCompanyRoutes,
        handleLockRoutes,
        handleEventRoutes,
        handleMigrateRoutes,
        handleFeedbackRoutes,
        handleGmapsRoutes,
      ];
      for (const h of handlers) {
        const res = await h(request, env, cors, url);
        if (res) return res;
      }
      return json({ error: "API 路径不存在", code: "NOT_FOUND" }, 404, cors);
    } catch (err) {
      const status = (err && err.status) || 500;
      const msg = status < 500 ? err.message : "服务端内部异常，请稍后重试";
      return json({ error: msg, code: status < 500 ? "BAD_REQUEST" : "INTERNAL_ERROR" }, status, cors);
    }
  },
};
