import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MANUAL_QR_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9erj8AAAAASUVORK5CYII=";

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

  let body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  const response = await fetch(`${BASE}${pathname}`, {
    method: options.method || "GET",
    headers,
    body,
    redirect: options.redirect || "follow"
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  return {
    status: response.status,
    headers: response.headers,
    payload
  };
}

function cookieFromSetCookie(setCookieValue) {
  if (!setCookieValue) return "";
  return setCookieValue.split(";")[0] || "";
}

let serverProcess;
let tempDataDir;

try {
  tempDataDir = await mkdtemp(path.join(tmpdir(), "parking-coupon-test-"));

  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: tempDataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitForServerReady();

  const sessionUnauthorized = await request("/api/admin/session");
  assert.equal(sessionUnauthorized.status, 401, "Unauthenticated session check should return 401");

  const listUnauthorized = await request("/api/admin/vouchers?page=1&pageSize=10");
  assert.equal(listUnauthorized.status, 401, "Unauthenticated admin voucher list should return 401");

  const redeemUnauthorized = await request("/redeem.html?v=TEST123", { redirect: "manual" });
  assert.equal(redeemUnauthorized.status, 302, "Unauthenticated redeem page should redirect to login");
  const redirectLocation = redeemUnauthorized.headers.get("location") || "";
  assert.ok(redirectLocation.startsWith("/admin.html?next="), "Redirect location should include next parameter");

  const badLogin = await request("/api/admin/login", {
    method: "POST",
    json: { username: "qzadmin", password: "bad-password" }
  });
  assert.equal(badLogin.status, 401, "Wrong password should return 401");

  const login = await request("/api/admin/login", {
    method: "POST",
    json: { username: "qzadmin", password: "Qzkj@2026#" }
  });
  assert.equal(login.status, 200, "Correct admin login should return 200");
  assert.equal(login.payload.username, "qzadmin", "Login response should include admin username");

  const adminCookie = cookieFromSetCookie(login.headers.get("set-cookie"));
  assert.ok(adminCookie.startsWith("pc_admin_session="), "Login should set session cookie");

  const sessionOk = await request("/api/admin/session", { cookie: adminCookie });
  assert.equal(sessionOk.status, 200, "Authenticated session check should return 200");

  const create = await request("/api/admin/voucher", {
    method: "POST",
    cookie: adminCookie,
    json: { total: 2 }
  });
  assert.equal(create.status, 200, "Create voucher should return 200");
  assert.ok(create.payload.voucher?.id, "Create voucher should return id");
  assert.ok(create.payload.qrDataUrl?.startsWith("data:image/png;base64,"), "Create voucher should return QR data URL");
  assert.ok(String(create.payload.redeemFullUrl || "").includes("/redeem.html?v="), "Create voucher should return redeem URL");

  const voucherId = create.payload.voucher.id;

  const uploadUnauthorized = await request(`/api/admin/voucher/${encodeURIComponent(voucherId)}/manual-qr`, {
    method: "POST",
    json: { qrDataUrl: MANUAL_QR_DATA_URL }
  });
  assert.equal(uploadUnauthorized.status, 401, "Unauthenticated manual QR upload should return 401");

  const uploadInvalid = await request(`/api/admin/voucher/${encodeURIComponent(voucherId)}/manual-qr`, {
    method: "POST",
    cookie: adminCookie,
    json: { qrDataUrl: "not-a-data-url" }
  });
  assert.equal(uploadInvalid.status, 400, "Invalid manual QR upload should return 400");

  const uploadManual = await request(`/api/admin/voucher/${encodeURIComponent(voucherId)}/manual-qr`, {
    method: "POST",
    cookie: adminCookie,
    json: { qrDataUrl: MANUAL_QR_DATA_URL }
  });
  assert.equal(uploadManual.status, 200, "Manual QR upload should return 200");
  assert.equal(uploadManual.payload.qrSource, "manual", "Manual QR upload response should mark source as manual");
  assert.equal(uploadManual.payload.qrDataUrl, MANUAL_QR_DATA_URL, "Manual QR upload response should return uploaded QR");

  const history1 = await request(`/api/admin/vouchers?page=1&pageSize=10&q=${encodeURIComponent(voucherId)}`, {
    cookie: adminCookie
  });
  assert.equal(history1.status, 200, "Admin voucher list should return 200");
  assert.ok(Array.isArray(history1.payload.items), "Admin voucher list should include items array");
  const item1 = history1.payload.items.find((v) => v.id === voucherId);
  assert.ok(item1, "Created voucher should be present in history list");
  assert.equal(item1.used, 0, "New voucher used count should be 0");
  assert.equal(item1.remain, 2, "New voucher remain count should match total");
  assert.equal(item1.qrSource, "manual", "History list should show manual QR source after upload");

  const getVoucher = await request(`/api/voucher/${encodeURIComponent(voucherId)}`, { cookie: adminCookie });
  assert.equal(getVoucher.status, 200, "Get voucher should return 200");
  assert.equal(getVoucher.payload.voucher.id, voucherId, "Get voucher should return the right voucher");
  assert.equal(getVoucher.payload.qrSource, "manual", "Get voucher should report manual QR source");
  assert.equal(getVoucher.payload.qrDataUrl, MANUAL_QR_DATA_URL, "Get voucher should return uploaded QR data");

  const displayVoucher = await request(`/api/voucher/${encodeURIComponent(voucherId)}/display`, {
    method: "POST",
    cookie: adminCookie
  });
  assert.equal(displayVoucher.status, 200, "Display voucher should return 200");

  const confirm1 = await request(`/api/voucher/${encodeURIComponent(voucherId)}/confirm`, {
    method: "POST",
    cookie: adminCookie
  });
  assert.equal(confirm1.status, 200, "First confirm should return 200");
  assert.equal(confirm1.payload.voucher.remain, 1, "Remain should decrement to 1");
  assert.equal(confirm1.payload.qrDataUrl, MANUAL_QR_DATA_URL, "Confirm response should keep manual QR data");

  const confirm2 = await request(`/api/voucher/${encodeURIComponent(voucherId)}/confirm`, {
    method: "POST",
    cookie: adminCookie
  });
  assert.equal(confirm2.status, 200, "Second confirm should return 200");
  assert.equal(confirm2.payload.voucher.remain, 0, "Remain should decrement to 0");

  const confirm3 = await request(`/api/voucher/${encodeURIComponent(voucherId)}/confirm`, {
    method: "POST",
    cookie: adminCookie
  });
  assert.equal(confirm3.status, 400, "Third confirm should fail with 400");

  const history2 = await request(`/api/admin/vouchers?page=1&pageSize=10&q=${encodeURIComponent(voucherId)}`, {
    cookie: adminCookie
  });
  assert.equal(history2.status, 200, "History query after usage should return 200");
  const item2 = history2.payload.items.find((v) => v.id === voucherId);
  assert.ok(item2, "Voucher should still be present in history after usage");
  assert.equal(item2.used, 2, "Used count should be 2 after two confirms");
  assert.equal(item2.remain, 0, "Remain count should be 0 after two confirms");

  const paging = await request("/api/admin/vouchers?page=1&pageSize=1", { cookie: adminCookie });
  assert.equal(paging.status, 200, "Paged history query should return 200");
  assert.equal(paging.payload.pagination.pageSize, 1, "pageSize should be reflected in response");
  assert.ok(typeof paging.payload.pagination.totalPages === "number", "pagination.totalPages should exist");

  const redeemWithAuth = await request(`/redeem.html?v=${encodeURIComponent(voucherId)}`, { cookie: adminCookie });
  assert.equal(redeemWithAuth.status, 200, "Authenticated redeem page should return 200");

  const logout = await request("/api/admin/logout", { method: "POST", cookie: adminCookie });
  assert.equal(logout.status, 200, "Logout should return 200");

  const apiAfterLogout = await request(`/api/voucher/${encodeURIComponent(voucherId)}`);
  assert.equal(apiAfterLogout.status, 401, "Voucher API should return 401 after logout without cookie");

  const redeemAfterLogout = await request(`/redeem.html?v=${encodeURIComponent(voucherId)}`, { redirect: "manual" });
  assert.equal(redeemAfterLogout.status, 302, "Redeem page should redirect to login after logout");

  console.log("Internal regression checks passed.");

  if (stderr.trim()) {
    // Keep stderr visible in case someone wants to inspect warnings.
    console.log("Server stderr:", stderr.trim());
  }
} catch (err) {
  console.error("Internal regression checks failed:");
  console.error(err);
  process.exitCode = 1;
} finally {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await delay(200);
    if (!serverProcess.killed) serverProcess.kill("SIGKILL");
  }

  if (tempDataDir) {
    await rm(tempDataDir, { recursive: true, force: true });
  }
}
