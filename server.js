import express from "express";
import fse from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "3mb" }));

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const VOUCHER_FILE = path.join(DATA_DIR, "vouchers.json");
const LOG_FILE = path.join(DATA_DIR, "logs.jsonl");

const ADMIN_USERNAME = "qzadmin";
const ADMIN_PASSWORD = "Qzkj@2026#";
const SESSION_COOKIE_NAME = "pc_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MANUAL_QR_DATA_URL_LENGTH = 2 * 1024 * 1024;
const SUPPORTED_QR_DATA_URL_PREFIX = /^data:image\/(png|jpeg|jpg|webp);base64,/i;
const adminSessions = new Map();

await fse.ensureDir(DATA_DIR);
if (!(await fse.pathExists(VOUCHER_FILE))) await fse.writeJson(VOUCHER_FILE, {}, { spaces: 2 });
if (!(await fse.pathExists(LOG_FILE))) await fse.writeFile(LOG_FILE, "");

let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const run = writeQueue.then(fn);
  // Keep the queue alive after failures, but still propagate the current error to caller.
  writeQueue = run.catch((err) => {
    if (!err?.expected) console.error(err);
  });
  return run;
}

async function readVouchers() {
  return await fse.readJson(VOUCHER_FILE);
}
async function writeVouchers(obj) {
  await fse.writeJson(VOUCHER_FILE, obj, { spaces: 2 });
}
async function appendLog(entry) {
  await fse.appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
}

function warnLevel(remain) {
  if (remain <= 3) return "severe";
  if (remain <= 10) return "warn";
  return "ok";
}
function warnText(level) {
  if (level === "severe" || level === "warn") return "停车券次数即将用尽，请尽快购买！";
  return "";
}
async function voucherQrDataUrl(voucherId) {
  return await QRCode.toDataURL(voucherId, { margin: 1, width: 320 });
}

async function voucherDisplayQrDataUrl(voucher) {
  const manualQrDataUrl = voucher?.manualQr?.dataUrl;
  if (typeof manualQrDataUrl === "string" && manualQrDataUrl.startsWith("data:image/")) return manualQrDataUrl;
  return await voucherQrDataUrl(voucher.id);
}

function normalizeManualQrDataUrl(value) {
  if (typeof value !== "string") {
    const err = new Error("上传二维码必须是图片 Data URL 字符串");
    err.expected = true;
    throw err;
  }
  const trimmed = value.trim();
  if (!SUPPORTED_QR_DATA_URL_PREFIX.test(trimmed)) {
    const err = new Error("仅支持 PNG/JPEG/WEBP 图片");
    err.expected = true;
    throw err;
  }
  if (trimmed.length > MAX_MANUAL_QR_DATA_URL_LENGTH) {
    const err = new Error("二维码图片过大，请压缩后重试");
    err.expected = true;
    throw err;
  }
  const base64Index = trimmed.indexOf(",");
  const base64Raw = base64Index >= 0 ? trimmed.slice(base64Index + 1) : "";
  let decoded;
  try {
    decoded = Buffer.from(base64Raw, "base64");
  } catch {
    const err = new Error("二维码图片内容无效");
    err.expected = true;
    throw err;
  }
  if (!decoded.length) {
    const err = new Error("二维码图片内容为空");
    err.expected = true;
    throw err;
  }
  return trimmed;
}

function parseCookies(req) {
  const out = {};
  const rawCookie = req.headers.cookie || "";
  for (const part of rawCookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    out[key] = value;
  }
  return out;
}

function setAdminSessionCookie(res, sessionId) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

function clearAdminSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function getAdminSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;
  const session = adminSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(sessionId);
    return null;
  }
  return { sessionId, ...session };
}

function createAdminSession(username) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  const session = { username, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
  adminSessions.set(sessionId, session);
  return sessionId;
}

function adminAuth(req, res, next) {
  const session = getAdminSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized", message: "请先登录管理员账号" });
  req.adminUser = session.username;
  next();
}

function redeemPageAuth(req, res, next) {
  const session = getAdminSession(req);
  if (!session) {
    const nextUrl = encodeURIComponent(req.originalUrl || "/redeem.html");
    return res.redirect(`/admin.html?next=${nextUrl}`);
  }
  req.adminUser = session.username;
  next();
}

function reqMeta(req) {
  return {
    ip: req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.socket.remoteAddress,
    ua: req.headers["user-agent"] || ""
  };
}

function toIntOrDefault(value, defaultValue) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.trunc(n);
}

app.post("/api/admin/login", async (req, res) => {
  const username = (req.body?.username || "").trim();
  const password = req.body?.password || "";
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized", message: "账号或密码错误" });
  }
  const sessionId = createAdminSession(username);
  setAdminSessionCookie(res, sessionId);
  const now = new Date().toISOString();
  await appendLog({ ts: now, type: "ADMIN_LOGIN", voucherId: null, ...reqMeta(req), meta: { username } });
  res.json({ ok: true, username, expiresInSec: Math.floor(SESSION_TTL_MS / 1000) });
});

app.get("/api/admin/session", (req, res) => {
  const session = getAdminSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, username: session.username, expiresAt: new Date(session.expiresAt).toISOString() });
});

app.post("/api/admin/logout", async (req, res) => {
  const session = getAdminSession(req);
  if (session?.sessionId) adminSessions.delete(session.sessionId);
  clearAdminSessionCookie(res);
  const now = new Date().toISOString();
  await appendLog({ ts: now, type: "ADMIN_LOGOUT", voucherId: null, ...reqMeta(req), meta: { username: session?.username || "" } });
  res.json({ ok: true });
});

app.post("/api/admin/voucher", adminAuth, async (req, res) => {
  const total = Number(req.body?.total);
  if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: "Invalid total" });
  const manualQrDataUrlRaw = req.body?.manualQrDataUrl;
  let manualQrDataUrl = null;
  if (manualQrDataUrlRaw !== undefined && manualQrDataUrlRaw !== null && String(manualQrDataUrlRaw).trim() !== "") {
    try {
      manualQrDataUrl = normalizeManualQrDataUrl(manualQrDataUrlRaw);
    } catch (err) {
      return res.status(400).json({ error: "Invalid manualQrDataUrl", message: err.message || "二维码图片无效" });
    }
  }

  const id = `VCH_${new Date().toISOString().slice(0,10).replaceAll("-","")}_${nanoid(6).toUpperCase()}`;
  const now = new Date().toISOString();
  const voucher = { id, total, remain: total, createdAt: now, status: "active" };
  if (manualQrDataUrl) {
    voucher.manualQr = { dataUrl: manualQrDataUrl, uploadedAt: now, uploadedBy: req.adminUser };
  }

  await enqueueWrite(async () => {
    const all = await readVouchers();
    all[id] = voucher;
    await writeVouchers(all);
    await appendLog({
      ts: now,
      type: "CREATE",
      voucherId: id,
      ...reqMeta(req),
      meta: { total, admin: req.adminUser, hasManualQr: Boolean(manualQrDataUrl) }
    });
  });

  const redeemUrl = `/redeem.html?v=${id}`;
  const redeemFullUrl = `${req.protocol}://${req.get("host")}${redeemUrl}`;
  const redeemPageQrDataUrl = await QRCode.toDataURL(redeemFullUrl, { margin: 1, width: 320 });
  res.json({
    voucher,
    redeemUrl,
    redeemFullUrl,
    qrDataUrl: redeemPageQrDataUrl,
    voucherQrSource: voucher.manualQr ? "manual" : "auto"
  });
});

app.post("/api/admin/voucher/:id/manual-qr", adminAuth, async (req, res) => {
  let normalized;
  try {
    normalized = normalizeManualQrDataUrl(req.body?.qrDataUrl);
  } catch (err) {
    return res.status(400).json({ error: "Invalid qrDataUrl", message: err.message || "二维码图片无效" });
  }

  let updatedVoucher = null;
  const now = new Date().toISOString();
  await enqueueWrite(async () => {
    const all = await readVouchers();
    const voucher = all[req.params.id];
    if (!voucher) {
      const err = new Error("Not found");
      err.expected = true;
      throw err;
    }
    voucher.manualQr = { dataUrl: normalized, uploadedAt: now, uploadedBy: req.adminUser };
    await writeVouchers(all);
    await appendLog({ ts: now, type: "UPLOAD_QR", voucherId: req.params.id, ...reqMeta(req), meta: { admin: req.adminUser } });
    updatedVoucher = voucher;
  }).catch((err) => {
    if (err?.expected) return res.status(404).json({ error: "Not found", message: "停车券不存在" });
    return res.status(500).json({ error: "Upload failed", message: "上传二维码失败，请稍后重试" });
  });
  if (!updatedVoucher) return;

  res.json({
    ok: true,
    voucher: updatedVoucher,
    qrDataUrl: updatedVoucher.manualQr?.dataUrl || "",
    qrSource: "manual",
    uploadedAt: updatedVoucher.manualQr?.uploadedAt || now
  });
});

app.get("/api/admin/vouchers", adminAuth, async (req, res) => {
  const page = Math.max(1, toIntOrDefault(req.query.page, 1));
  const pageSize = Math.min(100, Math.max(1, toIntOrDefault(req.query.pageSize, 10)));
  const q = String(req.query.q || "").trim().toLowerCase();

  const all = await readVouchers();
  const allItems = Object.values(all)
    .map((v) => {
      const total = Number(v.total) || 0;
      const remain = Number(v.remain) || 0;
      const used = Math.max(0, total - remain);
      const level = warnLevel(remain);
      return {
        id: v.id,
        total,
        used,
        remain,
        status: v.status || "active",
        createdAt: v.createdAt || "",
        qrSource: v.manualQr?.dataUrl ? "manual" : "auto",
        manualQrUploadedAt: v.manualQr?.uploadedAt || "",
        warning: { level, text: warnText(level) }
      };
    })
    .filter((v) => (q ? (v.id || "").toLowerCase().includes(q) : true))
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt || "");
      const tb = Date.parse(b.createdAt || "");
      if (!Number.isNaN(tb) && !Number.isNaN(ta) && tb !== ta) return tb - ta;
      return String(b.id || "").localeCompare(String(a.id || ""));
    });

  const total = allItems.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const items = allItems.slice(start, start + pageSize);

  let totalIssued = 0;
  let totalUsed = 0;
  let totalRemain = 0;
  for (const item of allItems) {
    totalIssued += item.total;
    totalUsed += item.used;
    totalRemain += item.remain;
  }

  res.json({
    items,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages
    },
    summary: {
      totalVouchers: total,
      totalIssued,
      totalUsed,
      totalRemain
    }
  });
});

app.use("/api/voucher", adminAuth);

app.get("/api/voucher/:id", async (req, res) => {
  const all = await readVouchers();
  const v = all[req.params.id];
  if (!v) return res.status(404).json({ error: "Not found" });
  const level = warnLevel(v.remain);
  const qrDataUrl = await voucherDisplayQrDataUrl(v);
  res.json({ voucher: v, warning: { level, text: warnText(level) }, qrDataUrl, qrSource: v.manualQr?.dataUrl ? "manual" : "auto" });
});

app.post("/api/voucher/:id/display", async (req, res) => {
  const now = new Date().toISOString();
  await appendLog({ ts: now, type: "DISPLAY", voucherId: req.params.id, ...reqMeta(req), meta: {} });
  res.json({ ok: true });
});

app.post("/api/voucher/:id/confirm", async (req, res) => {
  let updated;
  await enqueueWrite(async () => {
    const all = await readVouchers();
    const v = all[req.params.id];
    if (!v || v.remain <= 0) {
      const err = new Error("Invalid");
      err.expected = true;
      throw err;
    }
    const before = v.remain;
    v.remain -= 1;
    await writeVouchers(all);
    const now = new Date().toISOString();
    await appendLog({ ts: now, type: "CONFIRM", voucherId: req.params.id, ...reqMeta(req), meta: { before, after: v.remain } });
    updated = v;
  }).catch(() => res.status(400).json({ error: "Cannot confirm" }));
  if (!updated) return;
  const level = warnLevel(updated.remain);
  const qrDataUrl = await voucherDisplayQrDataUrl(updated);
  res.json({
    voucher: updated,
    warning: { level, text: warnText(level) },
    qrDataUrl,
    qrSource: updated.manualQr?.dataUrl ? "manual" : "auto"
  });
});

app.get("/redeem.html", redeemPageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "redeem.html"));
});

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on http://localhost:" + PORT));
