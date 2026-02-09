import express from "express";
import fse from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const VOUCHER_FILE = path.join(DATA_DIR, "vouchers.json");
const LOG_FILE = path.join(DATA_DIR, "logs.jsonl");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev_admin_token";

await fse.ensureDir(DATA_DIR);
if (!(await fse.pathExists(VOUCHER_FILE))) await fse.writeJson(VOUCHER_FILE, {}, { spaces: 2 });
if (!(await fse.pathExists(LOG_FILE))) await fse.writeFile(LOG_FILE, "");

let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const run = writeQueue.then(fn);
  // Keep the queue alive after failures, but still propagate the current error to caller.
  writeQueue = run.catch((err) => console.error(err));
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

function adminAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function reqMeta(req) {
  return {
    ip: req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.socket.remoteAddress,
    ua: req.headers["user-agent"] || ""
  };
}

app.post("/api/admin/voucher", adminAuth, async (req, res) => {
  const total = Number(req.body?.total);
  if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: "Invalid total" });

  const id = `VCH_${new Date().toISOString().slice(0,10).replaceAll("-","")}_${nanoid(6).toUpperCase()}`;
  const now = new Date().toISOString();
  const voucher = { id, total, remain: total, createdAt: now, status: "active" };

  await enqueueWrite(async () => {
    const all = await readVouchers();
    all[id] = voucher;
    await writeVouchers(all);
    await appendLog({ ts: now, type: "CREATE", voucherId: id, ...reqMeta(req), meta: { total } });
  });

  const redeemUrl = `/redeem.html?v=${id}`;
  const redeemFullUrl = `${req.protocol}://${req.get("host")}${redeemUrl}`;
  const qrDataUrl = await QRCode.toDataURL(redeemFullUrl, { margin: 1, width: 320 });
  res.json({ voucher, redeemUrl, redeemFullUrl, qrDataUrl });
});

app.get("/api/voucher/:id", async (req, res) => {
  const all = await readVouchers();
  const v = all[req.params.id];
  if (!v) return res.status(404).json({ error: "Not found" });
  const level = warnLevel(v.remain);
  const qrDataUrl = await voucherQrDataUrl(v.id);
  res.json({ voucher: v, warning: { level, text: warnText(level) }, qrDataUrl });
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
    if (!v || v.remain <= 0) throw new Error("Invalid");
    const before = v.remain;
    v.remain -= 1;
    await writeVouchers(all);
    const now = new Date().toISOString();
    await appendLog({ ts: now, type: "CONFIRM", voucherId: req.params.id, ...reqMeta(req), meta: { before, after: v.remain } });
    updated = v;
  }).catch(() => res.status(400).json({ error: "Cannot confirm" }));
  if (!updated) return;
  const level = warnLevel(updated.remain);
  const qrDataUrl = await voucherQrDataUrl(updated.id);
  res.json({ voucher: updated, warning: { level, text: warnText(level) }, qrDataUrl });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on http://localhost:" + PORT));
