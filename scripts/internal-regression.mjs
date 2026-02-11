import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_KEY = "demo-webhook-key-2026";

// A 1x1 transparent PNG for test uploads
const TINY_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9erj8AAAAASUVORK5CYII=",
  "base64"
);

async function waitForServerReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${BASE}/`, { redirect: "manual" });
      if (res.status >= 200 && res.status < 500) return;
    } catch {
      // keep waiting
    }
    await delay(100);
  }
  throw new Error("Server did not become ready in time");
}

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrfToken) headers["X-CSRF-Token"] = options.csrfToken;

  let body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.formData) {
    body = options.formData;
  }

  const response = await fetch(`${BASE}${pathname}`, {
    method: options.method || "GET",
    headers,
    body,
    redirect: options.redirect || "follow",
  });

  const setCookieHeader = response.headers.get("set-cookie") || "";
  let cookie = "";
  const m = setCookieHeader.match(/pc_admin_session=([^;]*)/);
  if (m) cookie = `pc_admin_session=${m[1]}`;

  let data = null;
  const ct = response.headers.get("content-type") || "";
  if (ct.includes("json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return { status: response.status, data, cookie, response };
}

/* ═══════════════════════════════════════════════
   Test Runner
   ═══════════════════════════════════════════════ */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (err.stack) {
      console.log(
        err.stack
          .split("\n")
          .slice(1, 3)
          .map((l) => `    ${l.trim()}`)
          .join("\n")
      );
    }
  }
}

/* ═══════════════════════════════════════════════
   Main
   ═══════════════════════════════════════════════ */

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "parking-test-"));
  console.log(`\nTest data dir: ${dataDir}`);
  console.log(`Server port: ${PORT}\n`);

  const server = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout.on("data", (d) => { serverOutput += d.toString(); });
  server.stderr.on("data", (d) => { serverOutput += d.toString(); });

  try {
    await waitForServerReady();
    console.log("Server ready.\n");

    /* ════════════════════════════════════════
       Auth Tests
       ════════════════════════════════════════ */
    console.log("─── Auth ───");

    let sessionCookie = "";
    let csrfToken = "";

    await test("Login with wrong password fails", async () => {
      const r = await request("/api/admin/login", {
        method: "POST",
        json: { username: "qzadmin", password: "wrong" },
      });
      assert.equal(r.status, 401);
    });

    await test("Login with correct credentials succeeds", async () => {
      const r = await request("/api/admin/login", {
        method: "POST",
        json: { username: "qzadmin", password: "Qzkj@2026#" },
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.ok(r.data.csrfToken);
      assert.ok(r.cookie);
      sessionCookie = r.cookie;
      csrfToken = r.data.csrfToken;
    });

    await test("Session check returns user", async () => {
      const r = await request("/api/admin/session", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.username, "qzadmin");
    });

    await test("CSRF token required for POST", async () => {
      const r = await request("/api/admin/voucher", {
        method: "POST",
        cookie: sessionCookie,
        json: { total: 10 },
      });
      assert.equal(r.status, 403);
    });

    await test("Rate limiting works", async () => {
      for (let i = 0; i < 6; i++) {
        await request("/api/admin/login", {
          method: "POST",
          json: { username: "qzadmin", password: "bad" },
        });
      }
      const r = await request("/api/admin/login", {
        method: "POST",
        json: { username: "qzadmin", password: "bad" },
      });
      assert.equal(r.status, 429);
    });

    /* ════════════════════════════════════════
       Create Purchase Record
       ════════════════════════════════════════ */
    console.log("\n─── Create Purchase Record ───");

    let voucherId = "";

    await test("Create purchase record with QR image", async () => {
      const formData = buildFormData({
        qrImage: { buffer: TINY_PNG_BUFFER, filename: "test-qr.png", type: "image/png" },
        total: "50",
        note: "测试物业第1批",
      });

      const r = await request("/api/admin/voucher", {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
        formData,
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.ok(r.data.voucher.id);
      assert.equal(r.data.voucher.total, 50);
      assert.equal(r.data.voucher.remain, 50);
      assert.equal(r.data.voucher.status, "active");
      voucherId = r.data.voucher.id;
    });

    await test("Create requires total > 0", async () => {
      const formData = buildFormData({
        qrImage: { buffer: TINY_PNG_BUFFER, filename: "test.png", type: "image/png" },
        total: "0",
      });
      const r = await request("/api/admin/voucher", {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
        formData,
      });
      assert.equal(r.status, 400);
    });

    await test("Create requires QR image", async () => {
      const formData = buildFormData({ total: "10" });
      const r = await request("/api/admin/voucher", {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
        formData,
      });
      assert.equal(r.status, 400);
    });

    /* ════════════════════════════════════════
       Webhook Usage (物业API回调)
       ════════════════════════════════════════ */
    console.log("\n─── Webhook Usage ───");

    await test("Webhook with invalid key is rejected", async () => {
      const r = await request("/api/webhook/usage", {
        method: "POST",
        json: { voucherId, key: "wrong-key" },
      });
      assert.equal(r.status, 401);
    });

    await test("Webhook usage decrements remain and creates usage record", async () => {
      const r = await request("/api/webhook/usage", {
        method: "POST",
        headers: { "X-Webhook-Key": WEBHOOK_KEY },
        json: { voucherId },
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.remain, 49);
      assert.ok(r.data.usage);
      assert.ok(r.data.usage.id.startsWith("USE_"));
      assert.equal(r.data.usage.source, "api");
    });

    await test("Webhook auto-picks active voucher when no voucherId", async () => {
      const r = await request("/api/webhook/usage", {
        method: "POST",
        headers: { "X-Webhook-Key": WEBHOOK_KEY },
        json: {},
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.remain, 48);
    });

    await test("Multiple webhook calls decrement correctly", async () => {
      for (let i = 0; i < 3; i++) {
        await request("/api/webhook/usage", {
          method: "POST",
          headers: { "X-Webhook-Key": WEBHOOK_KEY },
          json: { voucherId },
        });
      }
      // Check via admin detail
      const detail = await request(`/api/admin/voucher/${voucherId}`, {
        cookie: sessionCookie,
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.data.voucher.remain, 45);
      assert.equal(detail.data.used, 5);
    });

    /* ════════════════════════════════════════
       Admin Manual Usage (模拟物业回调)
       ════════════════════════════════════════ */
    console.log("\n─── Admin Manual Usage ───");

    await test("Admin manual usage decrements remain", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}/use`, {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.remain, 44);
      assert.ok(r.data.usage);
      assert.equal(r.data.usage.source, "manual");
    });

    await test("Admin manual usage requires auth", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}/use`, {
        method: "POST",
      });
      assert.equal(r.status, 401);
    });

    /* ════════════════════════════════════════
       Usage Records Query
       ════════════════════════════════════════ */
    console.log("\n─── Usage Records Query ───");

    await test("Usage records list returns all usage entries", async () => {
      const r = await request("/api/admin/usages", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data.items));
      // We made 5 webhook + 1 manual = 6 usages
      assert.equal(r.data.summary.totalUsages, 6);
    });

    await test("Usage records can filter by date", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const r = await request(`/api/admin/usages?startDate=${today}&endDate=${today}`, {
        cookie: sessionCookie,
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.summary.totalUsages, 6);
    });

    await test("Usage records filter by future date returns 0", async () => {
      const r = await request("/api/admin/usages?startDate=2099-01-01&endDate=2099-12-31", {
        cookie: sessionCookie,
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.summary.totalUsages, 0);
    });

    await test("Usage records can filter by voucherId", async () => {
      const r = await request(`/api/admin/usages?voucherId=${voucherId}`, {
        cookie: sessionCookie,
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.summary.totalUsages, 6);
    });

    /* ════════════════════════════════════════
       Admin Adjust Remain (Reconciliation)
       ════════════════════════════════════════ */
    console.log("\n─── Admin Adjust Remain ───");

    await test("Admin can adjust remain", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}`, {
        method: "PUT",
        cookie: sessionCookie,
        csrfToken,
        json: { remain: 40 },
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.voucher.remain, 40);
    });

    await test("Admin adjust to 0, then webhook is rejected", async () => {
      await request(`/api/admin/voucher/${voucherId}`, {
        method: "PUT",
        cookie: sessionCookie,
        csrfToken,
        json: { remain: 0 },
      });
      const r = await request("/api/webhook/usage", {
        method: "POST",
        headers: { "X-Webhook-Key": WEBHOOK_KEY },
        json: { voucherId },
      });
      assert.equal(r.status, 400);
    });

    await test("Admin adjust to 0, then manual use is rejected", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}/use`, {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
      });
      assert.equal(r.status, 400);
    });

    await test("Admin restore remain after zero", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}`, {
        method: "PUT",
        cookie: sessionCookie,
        csrfToken,
        json: { remain: 30 },
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.voucher.remain, 30);
    });

    /* ════════════════════════════════════════
       Disable / Enable
       ════════════════════════════════════════ */
    console.log("\n─── Disable / Enable ───");

    await test("Disable voucher", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}`, {
        method: "DELETE",
        cookie: sessionCookie,
        csrfToken,
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.voucher.status, "disabled");
    });

    await test("Webhook on disabled voucher is rejected", async () => {
      const r = await request("/api/webhook/usage", {
        method: "POST",
        headers: { "X-Webhook-Key": WEBHOOK_KEY },
        json: { voucherId },
      });
      assert.equal(r.status, 400);
    });

    await test("Manual use on disabled voucher is rejected", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}/use`, {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
      });
      assert.equal(r.status, 400);
    });

    await test("Re-enable voucher", async () => {
      const r = await request(`/api/admin/voucher/${voucherId}`, {
        method: "PUT",
        cookie: sessionCookie,
        csrfToken,
        json: { status: "active" },
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.voucher.status, "active");
    });

    /* ════════════════════════════════════════
       Enhanced Stats
       ════════════════════════════════════════ */
    console.log("\n─── Enhanced Stats ───");

    await test("Stats return correct values with date-based counts", async () => {
      const r = await request("/api/admin/stats", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      assert.equal(r.data.totalVouchers, 1);
      assert.equal(r.data.totalIssued, 50);
      // remain was set to 30 by admin adjust
      assert.equal(r.data.totalRemain, 30);
      assert.equal(r.data.totalUsed, 20); // 50 - 30
      // Date-based counts: all 6 usages happened today
      assert.equal(r.data.todayUsed, 6);
      assert.ok(r.data.thisMonthUsed >= 6);
      assert.ok(r.data.thisYearUsed >= 6);
      // recentDays should be an array of 7 days
      assert.ok(Array.isArray(r.data.recentDays));
      assert.equal(r.data.recentDays.length, 7);
      // Today should have 6 usages
      const today = new Date().toISOString().slice(0, 10);
      const todayEntry = r.data.recentDays.find(d => d.date === today);
      assert.ok(todayEntry);
      assert.equal(todayEntry.count, 6);
    });

    /* ════════════════════════════════════════
       Voucher List
       ════════════════════════════════════════ */
    console.log("\n─── Voucher List ───");

    await test("Voucher list returns correct structure", async () => {
      const r = await request("/api/admin/vouchers", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data.items));
      assert.equal(r.data.items.length, 1);
      const item = r.data.items[0];
      assert.equal(item.total, 50);
      assert.equal(item.remain, 30);
      assert.equal(item.used, 20);
      assert.equal(item.status, "active");
      assert.ok(r.data.summary);
      assert.equal(r.data.summary.totalIssued, 50);
    });

    await test("Voucher list status filter works", async () => {
      const r = await request("/api/admin/vouchers?status=disabled", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      assert.equal(r.data.items.length, 0);
    });

    await test("Voucher list search filter works", async () => {
      const r = await request("/api/admin/vouchers?q=测试", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      assert.equal(r.data.items.length, 1);
    });

    /* ════════════════════════════════════════
       Removed: Old Redeem API no longer exists
       ════════════════════════════════════════ */
    console.log("\n─── Old Redeem API Removed ───");

    await test("GET /api/voucher/active no longer exists", async () => {
      const r = await request("/api/voucher/active", { cookie: sessionCookie });
      assert.ok(r.status === 404 || r.status === 401);
    });

    /* ════════════════════════════════════════
       CSV Export (Purchase Records)
       ════════════════════════════════════════ */
    console.log("\n─── CSV Export (Purchase) ───");

    await test("Purchase CSV export contains correct columns", async () => {
      const r = await request("/api/admin/export", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      const csv = typeof r.data === "string" ? r.data : "";
      assert.ok(csv.includes("记录号"));
      assert.ok(csv.includes("购买次数"));
      assert.ok(csv.includes("已用"));
      assert.ok(csv.includes("剩余"));
      assert.ok(csv.includes(voucherId));
    });

    /* ════════════════════════════════════════
       CSV Export (Usage Records)
       ════════════════════════════════════════ */
    console.log("\n─── CSV Export (Usage) ───");

    await test("Usage CSV export contains correct columns", async () => {
      const r = await request("/api/admin/usages/export", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      const csv = typeof r.data === "string" ? r.data : "";
      assert.ok(csv.includes("使用记录ID"));
      assert.ok(csv.includes("关联记录号"));
      assert.ok(csv.includes("使用时间"));
      assert.ok(csv.includes("来源"));
      assert.ok(csv.includes("物业API"));
      assert.ok(csv.includes("手动录入"));
    });

    await test("Usage CSV export filters by date", async () => {
      const r = await request("/api/admin/usages/export?startDate=2099-01-01", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      const csv = typeof r.data === "string" ? r.data : "";
      // Header exists, but no data rows with voucherId
      assert.ok(csv.includes("使用记录ID"));
      assert.ok(!csv.includes(voucherId));
    });

    /* ════════════════════════════════════════
       Logs
       ════════════════════════════════════════ */
    console.log("\n─── Logs ───");

    await test("Logs contain CREATE, WEBHOOK_USE, MANUAL_USE, ADJUST entries", async () => {
      const r = await request("/api/admin/logs", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      const types = (r.data.items || []).map((l) => l.type);
      assert.ok(types.includes("CREATE"), "Missing CREATE log");
      assert.ok(types.includes("WEBHOOK_USE"), "Missing WEBHOOK_USE log");
      assert.ok(types.includes("MANUAL_USE"), "Missing MANUAL_USE log");
      assert.ok(types.includes("ADJUST"), "Missing ADJUST log");
    });

    await test("Log type filter works", async () => {
      const r = await request("/api/admin/logs?type=WEBHOOK_USE", { cookie: sessionCookie });
      assert.equal(r.status, 200);
      assert.ok(r.data.items.length > 0);
      for (const item of r.data.items) {
        assert.equal(item.type, "WEBHOOK_USE");
      }
    });

    /* ════════════════════════════════════════
       Use until exhausted
       ════════════════════════════════════════ */
    console.log("\n─── Exhaust & Reject ───");

    await test("Create small voucher, use until exhausted via webhook, then reject", async () => {
      // Create a small voucher with 3 uses
      const formData = buildFormData({
        qrImage: { buffer: TINY_PNG_BUFFER, filename: "small-qr.png", type: "image/png" },
        total: "3",
        note: "小额测试",
      });
      const cr = await request("/api/admin/voucher", {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
        formData,
      });
      assert.equal(cr.status, 200);
      const smallId = cr.data.voucher.id;

      // Use 3 times via webhook
      for (let i = 0; i < 3; i++) {
        const ur = await request("/api/webhook/usage", {
          method: "POST",
          headers: { "X-Webhook-Key": WEBHOOK_KEY },
          json: { voucherId: smallId },
        });
        assert.equal(ur.status, 200);
      }

      // 4th should be rejected
      const rr = await request("/api/webhook/usage", {
        method: "POST",
        headers: { "X-Webhook-Key": WEBHOOK_KEY },
        json: { voucherId: smallId },
      });
      assert.equal(rr.status, 400);

      // Admin manual use should also be rejected
      const mr = await request(`/api/admin/voucher/${smallId}/use`, {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
      });
      assert.equal(mr.status, 400);
    });

    /* ════════════════════════════════════════
       Logout
       ════════════════════════════════════════ */
    console.log("\n─── Logout ───");

    await test("Logout works", async () => {
      const r = await request("/api/admin/logout", {
        method: "POST",
        cookie: sessionCookie,
        csrfToken,
      });
      assert.equal(r.status, 200);
    });

    await test("After logout, session check fails", async () => {
      const r = await request("/api/admin/session", { cookie: sessionCookie });
      assert.equal(r.status, 401);
    });

  } finally {
    server.kill("SIGTERM");
    await delay(500);
    try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}

/* ─── Helper: build FormData with file ─── */
function buildFormData(fields) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value && typeof value === "object" && value.buffer) {
      const blob = new Blob([value.buffer], { type: value.type || "image/png" });
      formData.append(key, blob, value.filename || "file.png");
    } else {
      formData.append(key, String(value));
    }
  }
  return formData;
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(2);
});
