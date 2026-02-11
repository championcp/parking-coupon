import express from "express";
import fse from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import crypto from "crypto";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "3mb" }));

/* ════════════════════════════════════════════════
   Configuration
   ════════════════════════════════════════════════ */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const VOUCHER_FILE = path.join(DATA_DIR, "vouchers.json");
const USAGE_FILE = path.join(DATA_DIR, "usages.jsonl");
const LOG_FILE = path.join(DATA_DIR, "logs.jsonl");
const QR_DIR = path.join(DATA_DIR, "qr");

const ADMIN_USERNAME = "qzadmin";
const ADMIN_PASSWORD_RAW = "Qzkj@2026#";
const SESSION_COOKIE_NAME = "pc_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/* Webhook key for property management API callback (Demo) */
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || "demo-webhook-key-2026";

/* ════════════════════════════════════════════════
   Security: Password Hashing (crypto.scrypt)
   ════════════════════════════════════════════════ */

const ADMIN_SALT = "parking-coupon-admin-salt-v1";
const ADMIN_PASSWORD_HASH = crypto.scryptSync(
  ADMIN_PASSWORD_RAW,
  ADMIN_SALT,
  64
);

function verifyPassword(input) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, ADMIN_SALT, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(derived, ADMIN_PASSWORD_HASH));
    });
  });
}

/* ════════════════════════════════════════════════
   Security: Login Rate Limiting
   ════════════════════════════════════════════════ */

const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now - record.start > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, start: now });
    return true;
  }
  record.count += 1;
  return record.count <= RATE_LIMIT_MAX;
}

const _rlCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) {
    if (now - rec.start > RATE_LIMIT_WINDOW_MS * 2) loginAttempts.delete(ip);
  }
}, 60_000);
_rlCleanup.unref();

/* ════════════════════════════════════════════════
   Security: Response Headers
   ════════════════════════════════════════════════ */

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

/* ════════════════════════════════════════════════
   Data Initialisation
   ════════════════════════════════════════════════ */

const adminSessions = new Map();

await fse.ensureDir(DATA_DIR);
await fse.ensureDir(QR_DIR);
if (!(await fse.pathExists(VOUCHER_FILE)))
  await fse.writeJson(VOUCHER_FILE, {}, { spaces: 2 });
if (!(await fse.pathExists(USAGE_FILE))) await fse.writeFile(USAGE_FILE, "");
if (!(await fse.pathExists(LOG_FILE))) await fse.writeFile(LOG_FILE, "");

/* ════════════════════════════════════════════════
   Write Queue (sequential file writes)
   ════════════════════════════════════════════════ */

let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const run = writeQueue.then(fn);
  writeQueue = run.catch((err) => {
    if (!err?.expected) console.error(err);
  });
  return run;
}

/* ════════════════════════════════════════════════
   Data Access Helpers
   ════════════════════════════════════════════════ */

async function readVouchers() {
  return await fse.readJson(VOUCHER_FILE);
}
async function writeVouchers(obj) {
  await fse.writeJson(VOUCHER_FILE, obj, { spaces: 2 });
}
async function appendLog(entry) {
  await fse.appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
}
async function readLogs() {
  const content = await fse.readFile(LOG_FILE, "utf-8");
  if (!content.trim()) return [];
  return content
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* Usage records (usages.jsonl) */
async function appendUsage(entry) {
  await fse.appendFile(USAGE_FILE, JSON.stringify(entry) + "\n");
}
async function readUsages() {
  const content = await fse.readFile(USAGE_FILE, "utf-8");
  if (!content.trim()) return [];
  return content
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* ════════════════════════════════════════════════
   QR File Storage
   ════════════════════════════════════════════════ */

async function readQrDataUrl(voucher) {
  const qrFile = voucher.qrFile;
  if (!qrFile) return null;
  try {
    const buffer = await fse.readFile(path.join(QR_DIR, qrFile));
    const mime = voucher.qrMimeType || "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/* ════════════════════════════════════════════════
   Multer Configuration (single file upload)
   ════════════════════════════════════════════════ */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("仅支持上传图片文件"));
    }
  },
});

/* ════════════════════════════════════════════════
   Cookie & Session Management
   ════════════════════════════════════════════════ */

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const t = part.trim();
    if (!t) continue;
    const idx = t.indexOf("=");
    if (idx <= 0) continue;
    out[t.slice(0, idx)] = t.slice(idx + 1);
  }
  return out;
}

function setAdminSessionCookie(res, sessionId) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearAdminSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
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
  const csrfToken = crypto.randomBytes(24).toString("hex");
  const session = {
    username,
    csrfToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  adminSessions.set(sessionId, session);
  return { sessionId, csrfToken };
}

/* ════════════════════════════════════════════════
   Auth Middleware
   ════════════════════════════════════════════════ */

function adminAuth(req, res, next) {
  const session = getAdminSession(req);
  if (!session)
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "请先登录管理员账号" });

  if (req.method !== "GET" && req.method !== "HEAD") {
    const headerToken = req.headers["x-csrf-token"];
    if (!headerToken || headerToken !== session.csrfToken) {
      return res.status(403).json({
        error: "CSRF validation failed",
        message: "请求验证失败，请刷新页面重试",
      });
    }
  }

  req.adminUser = session.username;
  next();
}

/* ════════════════════════════════════════════════
   Misc Helpers
   ════════════════════════════════════════════════ */

function reqMeta(req) {
  return {
    ip:
      req.headers["x-forwarded-for"]?.toString().split(",")[0] ||
      req.socket.remoteAddress,
    ua: req.headers["user-agent"] || "",
  };
}

function toIntOrDefault(value, defaultValue) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.trunc(n);
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function monthDateStr() {
  return new Date().toISOString().slice(0, 7);
}

function yearStr() {
  return new Date().toISOString().slice(0, 4);
}

/* Core: record a usage event (shared by webhook and admin manual) */
async function recordUsage(voucherId, source, meta = {}) {
  let usage = null;
  let voucher = null;
  await enqueueWrite(async () => {
    const all = await readVouchers();
    const v = all[voucherId];
    if (!v || v.status !== "active" || Number(v.remain) <= 0) {
      const err = new Error("Cannot use");
      err.expected = true;
      throw err;
    }
    const now = new Date().toISOString();
    const dateStr = now.slice(0, 10).replaceAll("-", "");
    const usageId = `USE_${dateStr}_${nanoid(6).toUpperCase()}`;

    usage = {
      id: usageId,
      voucherId,
      usedAt: now,
      source,
    };

    const before = v.remain;
    v.remain -= 1;
    v.lastUsedAt = now;
    await writeVouchers(all);
    await appendUsage(usage);
    await appendLog({
      ts: now,
      type: source === "api" ? "WEBHOOK_USE" : "MANUAL_USE",
      voucherId,
      ...meta,
      meta: { usageId, before, after: v.remain, source, ...(meta.extra || {}) },
    });
    voucher = v;
  });
  return { usage, voucher };
}

/* ════════════════════════════════════════════════
   API: Admin Authentication
   ════════════════════════════════════════════════ */

app.post("/api/admin/login", async (req, res) => {
  const ip = reqMeta(req).ip;
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({
      error: "Too many requests",
      message: "登录尝试过于频繁，请稍后再试",
    });
  }

  const username = (req.body?.username || "").trim();
  const password = req.body?.password || "";

  if (username !== ADMIN_USERNAME) {
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "账号或密码错误" });
  }

  const valid = await verifyPassword(password);
  if (!valid) {
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "账号或密码错误" });
  }

  const { sessionId, csrfToken } = createAdminSession(username);
  setAdminSessionCookie(res, sessionId);

  const now = new Date().toISOString();
  await appendLog({
    ts: now,
    type: "ADMIN_LOGIN",
    voucherId: null,
    ...reqMeta(req),
    meta: { username },
  });

  res.json({
    ok: true,
    username,
    expiresInSec: Math.floor(SESSION_TTL_MS / 1000),
    csrfToken,
  });
});

app.get("/api/admin/session", (req, res) => {
  const session = getAdminSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  res.json({
    ok: true,
    username: session.username,
    expiresAt: new Date(session.expiresAt).toISOString(),
    csrfToken: session.csrfToken,
  });
});

app.post("/api/admin/logout", async (req, res) => {
  const session = getAdminSession(req);
  if (session?.sessionId) adminSessions.delete(session.sessionId);
  clearAdminSessionCookie(res);
  const now = new Date().toISOString();
  await appendLog({
    ts: now,
    type: "ADMIN_LOGOUT",
    voucherId: null,
    ...reqMeta(req),
    meta: { username: session?.username || "" },
  });
  res.json({ ok: true });
});

/* ════════════════════════════════════════════════
   API: Webhook — Property Management Callback
   ════════════════════════════════════════════════ */

app.post("/api/webhook/usage", async (req, res) => {
  const key = req.headers["x-webhook-key"] || req.body?.key;
  if (key !== WEBHOOK_KEY) {
    return res.status(401).json({ error: "Invalid webhook key" });
  }

  let voucherId = (req.body?.voucherId || "").trim();

  // If no voucherId provided, auto-pick first active voucher with remain > 0
  if (!voucherId) {
    const all = await readVouchers();
    const active = Object.values(all).find(
      (v) => v.status === "active" && Number(v.remain) > 0
    );
    if (!active) {
      return res
        .status(400)
        .json({ error: "No active voucher", message: "没有可用的停车券" });
    }
    voucherId = active.id;
  }

  try {
    const result = await recordUsage(voucherId, "api", reqMeta(req));
    res.json({ ok: true, usage: result.usage, remain: result.voucher.remain });
  } catch (err) {
    if (err?.expected)
      return res
        .status(400)
        .json({ error: "Cannot use", message: "次数已用完或已停用" });
    res.status(500).json({ error: "Internal error" });
  }
});

/* ════════════════════════════════════════════════
   API: Create Purchase Record (录入购买)
   ════════════════════════════════════════════════ */

app.post(
  "/api/admin/voucher",
  adminAuth,
  upload.single("qrImage"),
  async (req, res) => {
    const total = Number(req.body?.total);
    if (!Number.isFinite(total) || total <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid total", message: "请输入有效的购买次数" });
    }

    const file = req.file;
    if (!file) {
      return res
        .status(400)
        .json({ error: "No file", message: "请上传停车券二维码图片" });
    }

    const note =
      typeof req.body?.note === "string"
        ? req.body.note.trim().slice(0, 200)
        : "";
    const now = new Date().toISOString();
    const dateStr = now.slice(0, 10).replaceAll("-", "");
    const id = `VCH_${dateStr}_${nanoid(6).toUpperCase()}`;

    const ext =
      file.mimetype === "image/png"
        ? "png"
        : file.mimetype === "image/webp"
          ? "webp"
          : "jpg";
    const filename = `${id}.${ext}`;
    await fse.writeFile(path.join(QR_DIR, filename), file.buffer);

    const voucher = {
      id,
      total: Math.trunc(total),
      remain: Math.trunc(total),
      status: "active",
      note,
      createdAt: now,
      lastUsedAt: null,
      qrFile: filename,
      qrMimeType: file.mimetype,
    };

    await enqueueWrite(async () => {
      const all = await readVouchers();
      all[id] = voucher;
      await writeVouchers(all);
      await appendLog({
        ts: now,
        type: "CREATE",
        voucherId: id,
        ...reqMeta(req),
        meta: { total: voucher.total, admin: req.adminUser, note },
      });
    });

    res.json({ ok: true, voucher });
  }
);

/* ════════════════════════════════════════════════
   API: Voucher Detail & Update (Admin)
   ════════════════════════════════════════════════ */

/* Single voucher detail — includes recent logs */
app.get("/api/admin/voucher/:id", adminAuth, async (req, res) => {
  const all = await readVouchers();
  const v = all[req.params.id];
  if (!v) return res.status(404).json({ error: "Not found" });

  const qrDataUrl = await readQrDataUrl(v);

  const allLogs = await readLogs();
  const voucherLogs = allLogs
    .filter((l) => l.voucherId === req.params.id)
    .slice(-20)
    .reverse();

  const t = Number(v.total) || 0;
  const r = Number(v.remain) || 0;

  res.json({
    voucher: v,
    used: Math.max(0, t - r),
    qrDataUrl,
    logs: voucherLogs,
  });
});

/* Update voucher (note / status / remain adjustment) */
app.put("/api/admin/voucher/:id", adminAuth, async (req, res) => {
  let updatedVoucher = null;
  const now = new Date().toISOString();
  let adjustLog = null;

  await enqueueWrite(async () => {
    const all = await readVouchers();
    const v = all[req.params.id];
    if (!v) {
      const err = new Error("Not found");
      err.expected = true;
      throw err;
    }
    if (typeof req.body?.note === "string")
      v.note = req.body.note.trim().slice(0, 200);
    if (req.body?.status === "disabled" || req.body?.status === "active") {
      v.status = req.body.status;
    }
    if (req.body?.remain !== undefined) {
      const newRemain = Number(req.body.remain);
      if (Number.isFinite(newRemain) && newRemain >= 0) {
        const oldRemain = v.remain;
        v.remain = Math.trunc(newRemain);
        adjustLog = { oldRemain, newRemain: v.remain };
      }
    }
    await writeVouchers(all);
    await appendLog({
      ts: now,
      type: adjustLog ? "ADJUST" : "UPDATE",
      voucherId: req.params.id,
      ...reqMeta(req),
      meta: {
        admin: req.adminUser,
        changes: req.body,
        ...(adjustLog || {}),
      },
    });
    updatedVoucher = v;
  }).catch((err) => {
    if (err?.expected)
      return res
        .status(404)
        .json({ error: "Not found", message: "购买记录不存在" });
    return res.status(500).json({ error: "Update failed" });
  });
  if (!updatedVoucher) return;

  res.json({ ok: true, voucher: updatedVoucher });
});

/* Disable voucher */
app.delete("/api/admin/voucher/:id", adminAuth, async (req, res) => {
  let updatedVoucher = null;
  const now = new Date().toISOString();

  await enqueueWrite(async () => {
    const all = await readVouchers();
    const v = all[req.params.id];
    if (!v) {
      const err = new Error("Not found");
      err.expected = true;
      throw err;
    }
    v.status = "disabled";
    await writeVouchers(all);
    await appendLog({
      ts: now,
      type: "DISABLE",
      voucherId: req.params.id,
      ...reqMeta(req),
      meta: { admin: req.adminUser },
    });
    updatedVoucher = v;
  }).catch((err) => {
    if (err?.expected)
      return res
        .status(404)
        .json({ error: "Not found", message: "购买记录不存在" });
    return res.status(500).json({ error: "Disable failed" });
  });
  if (!updatedVoucher) return;

  res.json({ ok: true, voucher: updatedVoucher });
});

/* Admin manually record usage (模拟物业回调) */
app.post("/api/admin/voucher/:id/use", adminAuth, async (req, res) => {
  try {
    const result = await recordUsage(req.params.id, "manual", {
      ...reqMeta(req),
      extra: { admin: req.adminUser },
    });
    res.json({ ok: true, usage: result.usage, remain: result.voucher.remain });
  } catch (err) {
    if (err?.expected)
      return res
        .status(400)
        .json({ error: "Cannot use", message: "次数已用完或已停用" });
    res.status(500).json({ error: "Internal error" });
  }
});

/* ════════════════════════════════════════════════
   API: Usage Records Query
   ════════════════════════════════════════════════ */

app.get("/api/admin/usages", adminAuth, async (req, res) => {
  const page = Math.max(1, toIntOrDefault(req.query.page, 1));
  const pageSize = Math.min(
    100,
    Math.max(1, toIntOrDefault(req.query.pageSize, 20))
  );
  const startDate = (req.query.startDate || "").trim();
  const endDate = (req.query.endDate || "").trim();
  const voucherFilter = (req.query.voucherId || "").trim();

  const allUsages = await readUsages();
  const filtered = allUsages
    .filter((u) => {
      if (startDate && u.usedAt < startDate) return false;
      if (endDate) {
        // endDate is inclusive: compare against endDate + "T23:59:59"
        const endBound = endDate.length === 10 ? endDate + "T23:59:59.999Z" : endDate;
        if (u.usedAt > endBound) return false;
      }
      if (voucherFilter && !(u.voucherId || "").includes(voucherFilter))
        return false;
      return true;
    })
    .reverse(); // newest first

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  res.json({
    items,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
    },
    summary: { totalUsages: total },
  });
});

/* Usage records CSV export */
app.get("/api/admin/usages/export", adminAuth, async (req, res) => {
  const startDate = (req.query.startDate || "").trim();
  const endDate = (req.query.endDate || "").trim();

  const allUsages = await readUsages();
  const filtered = allUsages.filter((u) => {
    if (startDate && u.usedAt < startDate) return false;
    if (endDate) {
      const endBound = endDate.length === 10 ? endDate + "T23:59:59.999Z" : endDate;
      if (u.usedAt > endBound) return false;
    }
    return true;
  });

  const BOM = "\uFEFF";
  const header = "使用记录ID,关联记录号,使用时间,来源\n";
  const rows = filtered
    .map((u) => {
      const sourceText = u.source === "api" ? "物业API" : "手动录入";
      return [u.id, u.voucherId, u.usedAt, sourceText].join(",");
    })
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=usages_${todayDateStr()}.csv`
  );
  res.send(BOM + header + rows);
});

/* ════════════════════════════════════════════════
   API: Voucher List, Stats, Logs, Export
   ════════════════════════════════════════════════ */

app.get("/api/admin/vouchers", adminAuth, async (req, res) => {
  const page = Math.max(1, toIntOrDefault(req.query.page, 1));
  const pageSize = Math.min(
    100,
    Math.max(1, toIntOrDefault(req.query.pageSize, 10))
  );
  const q = String(req.query.q || "")
    .trim()
    .toLowerCase();
  const statusFilter = String(req.query.status || "").trim();

  const all = await readVouchers();
  const allItems = Object.values(all)
    .map((v) => {
      const t = Number(v.total) || 0;
      const r = Number(v.remain) || 0;
      return {
        id: v.id,
        total: t,
        used: Math.max(0, t - r),
        remain: r,
        status: v.status || "active",
        note: v.note || "",
        createdAt: v.createdAt || "",
        lastUsedAt: v.lastUsedAt || null,
        qrFile: v.qrFile || "",
      };
    })
    .filter((v) =>
      q
        ? (v.id || "").toLowerCase().includes(q) ||
          (v.note || "").toLowerCase().includes(q)
        : true
    )
    .filter((v) => (statusFilter ? v.status === statusFilter : true))
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
      hasNext: safePage < totalPages,
    },
    summary: { totalVouchers: total, totalIssued, totalUsed, totalRemain },
  });
});

/* Dashboard stats — enhanced with date-based usage counts */
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const all = await readVouchers();
  const items = Object.values(all);
  const today = todayDateStr();
  const thisMonth = monthDateStr();
  const thisYear = yearStr();

  let totalVouchers = 0;
  let activeVouchers = 0;
  let disabledVouchers = 0;
  let totalIssued = 0;
  let totalUsed = 0;
  let totalRemain = 0;

  for (const v of items) {
    totalVouchers++;
    const t = Number(v.total) || 0;
    const r = Number(v.remain) || 0;
    totalIssued += t;
    totalUsed += Math.max(0, t - r);
    totalRemain += r;
    if (v.status === "disabled") disabledVouchers++;
    else activeVouchers++;
  }

  // Count usages by period from usages.jsonl
  let todayUsed = 0;
  let thisMonthUsed = 0;
  let thisYearUsed = 0;

  // Recent 7 days breakdown
  const recentDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    recentDays.push({ date: d.toISOString().slice(0, 10), count: 0 });
  }
  const recentDatesSet = new Set(recentDays.map((d) => d.date));
  const recentDaysMap = Object.fromEntries(
    recentDays.map((d) => [d.date, d])
  );

  try {
    const usages = await readUsages();
    for (const u of usages) {
      if (!u.usedAt) continue;
      const dateStr = u.usedAt.slice(0, 10);
      if (dateStr === today) todayUsed++;
      if (dateStr.startsWith(thisMonth)) thisMonthUsed++;
      if (dateStr.startsWith(thisYear)) thisYearUsed++;
      if (recentDatesSet.has(dateStr)) {
        recentDaysMap[dateStr].count++;
      }
    }
  } catch {
    /* ignore */
  }

  res.json({
    totalVouchers,
    activeVouchers,
    disabledVouchers,
    totalIssued,
    totalUsed,
    totalRemain,
    todayUsed,
    thisMonthUsed,
    thisYearUsed,
    recentDays,
  });
});

/* Operation logs */
app.get("/api/admin/logs", adminAuth, async (req, res) => {
  const page = Math.max(1, toIntOrDefault(req.query.page, 1));
  const pageSize = Math.min(
    100,
    Math.max(1, toIntOrDefault(req.query.pageSize, 20))
  );
  const typeFilter = req.query.type || "";
  const voucherFilter = (req.query.voucherId || "").trim();

  const allLogs = await readLogs();
  const filtered = allLogs
    .filter((l) => (typeFilter ? l.type === typeFilter : true))
    .filter((l) =>
      voucherFilter ? (l.voucherId || "").includes(voucherFilter) : true
    )
    .reverse();

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  res.json({
    items,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
    },
  });
});

/* CSV export (purchase records) */
app.get("/api/admin/export", adminAuth, async (req, res) => {
  const all = await readVouchers();
  const items = Object.values(all).sort((a, b) => {
    const ta = Date.parse(a.createdAt || "");
    const tb = Date.parse(b.createdAt || "");
    return (tb || 0) - (ta || 0);
  });

  const BOM = "\uFEFF";
  const header = "记录号,购买次数,已用,剩余,状态,备注,创建时间\n";
  const rows = items
    .map((v) => {
      const t = Number(v.total) || 0;
      const r = Number(v.remain) || 0;
      const used = Math.max(0, t - r);
      const statusText = v.status === "disabled" ? "已停用" : "活跃";
      return [
        v.id,
        t,
        used,
        r,
        statusText,
        `"${(v.note || "").replace(/"/g, '""')}"`,
        v.createdAt || "",
      ].join(",");
    })
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=vouchers_${todayDateStr()}.csv`
  );
  res.send(BOM + header + rows);
});

/* ════════════════════════════════════════════════
   Page Routes & Static Files
   ════════════════════════════════════════════════ */

app.use(
  express.static(path.join(__dirname, "public"), { index: "index.html" })
);

/* ════════════════════════════════════════════════
   Start Server
   ════════════════════════════════════════════════ */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("Server running on http://localhost:" + PORT)
);
