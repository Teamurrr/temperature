const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const multer = require("multer");

const app = express();

const PORT = Number(process.env.PORT || 5000);
const SENSOR_ID = process.env.SENSOR_ID || "esp32";
const DATABASE_URL =
  process.env.TEMPERATURE_DATABASE_URL ||
  "https://temperaturedata-68177-default-rtdb.firebaseio.com";
const CACHE_PATH = path.join(__dirname, "data", "temperature-cache.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const TOO_COLD_TEMPERATURE = 22;
const TOO_HOT_TEMPERATURE = 40;
const VALID_PERIODS = ["day", "week", "month", "halfYear"];
const BOT_APP_DIR = path.resolve(__dirname, "..", "tempDodoBot");
const BOT_ENV_PATH = path.join(BOT_APP_DIR, ".env");
const BOT_CHATS_PATH = path.join(BOT_APP_DIR, "chats.json");

if (fsSync.existsSync(BOT_ENV_PATH)) {
  dotenv.config({ path: BOT_ENV_PATH, override: false });
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "";

const state = {
  latest: null,
  history: [],
  syncedAt: null,
  source: "boot"
};

const upload = multer({
  storage: multer.memoryStorage()
});

app.use(cors());
app.use(express.json());

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatDatabaseKeyDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function getPeriodStart(period) {
  const now = new Date();

  switch (period) {
    case "day":
      now.setHours(now.getHours() - 24);
      break;
    case "week":
      now.setDate(now.getDate() - 7);
      break;
    case "month":
      now.setDate(now.getDate() - 30);
      break;
    case "halfYear":
      now.setMonth(now.getMonth() - 6);
      break;
    default:
      now.setHours(now.getHours() - 24);
      break;
  }

  return now;
}

function mapLatestData(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    id: SENSOR_ID,
    temperature: typeof raw.temperature === "number" ? raw.temperature : null,
    unit: "C",
    sensorId:
      typeof raw.device === "string" && raw.device.trim()
        ? raw.device
        : SENSOR_ID.toUpperCase(),
    createdAt: parseIsoDate(raw.updated_at)
  };
}

function mapHistoryPoint(key, raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const createdAt = parseIsoDate(raw.updated_at || key);

  if (!createdAt) {
    return null;
  }

  return {
    temperature: typeof raw.temperature === "number" ? raw.temperature : null,
    createdAt,
    unit: "C",
    sensorId:
      typeof raw.device === "string" && raw.device.trim()
        ? raw.device
        : SENSOR_ID.toUpperCase()
  };
}

function sanitizeHistory(history) {
  return history
    .filter((point) => point && typeof point.createdAt === "number")
    .sort((left, right) => left.createdAt - right.createdAt);
}

function buildReport(period) {
  const safePeriod = VALID_PERIODS.includes(period) ? period : "day";
  const from = getPeriodStart(safePeriod).getTime();
  const to = Date.now();
  const points = state.history.filter((point) => point.createdAt >= from);
  const values = points
    .map((point) => point.temperature)
    .filter((value) => typeof value === "number");

  return {
    period: safePeriod,
    from,
    to,
    points,
    count: points.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null
  };
}

function parseReportDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatDateKey(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveReportRange(dateFromValue, dateToValue) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const parsedFrom = parseReportDate(dateFromValue);
  const parsedTo = parseReportDate(dateToValue);

  const safeTo = parsedTo ?? parsedFrom ?? today;
  const safeFrom = parsedFrom ?? parsedTo ?? today;

  safeFrom.setHours(0, 0, 0, 0);
  safeTo.setHours(0, 0, 0, 0);

  const from = safeFrom.getTime() <= safeTo.getTime() ? safeFrom : safeTo;
  const to = safeFrom.getTime() <= safeTo.getTime() ? safeTo : safeFrom;
  const maxRangeEnd = from.getTime() + DAY_MS * 180;

  if (to.getTime() > maxRangeEnd) {
    to.setTime(maxRangeEnd);
  }

  return {
    from,
    to
  };
}

function calculateCriticalDurations(points, dayStart, dayEnd) {
  let coldDurationMs = 0;
  let hotDurationMs = 0;

  for (let index = 0; index < points.length; index += 1) {
    const currentPoint = points[index];

    if (!currentPoint || typeof currentPoint.temperature !== "number") {
      continue;
    }

    const nextPoint = points[index + 1];
    const intervalStart = Math.max(currentPoint.createdAt, dayStart);
    const intervalEnd = nextPoint ? Math.min(nextPoint.createdAt, dayEnd) : dayEnd;

    if (intervalEnd <= intervalStart) {
      continue;
    }

    const intervalDuration = intervalEnd - intervalStart;

    if (currentPoint.temperature < TOO_COLD_TEMPERATURE) {
      coldDurationMs += intervalDuration;
    } else if (currentPoint.temperature > TOO_HOT_TEMPERATURE) {
      hotDurationMs += intervalDuration;
    }
  }

  return {
    coldDurationMs,
    hotDurationMs
  };
}

function buildDailyReport(dateFromValue, dateToValue) {
  const resolvedRange = resolveReportRange(dateFromValue, dateToValue);
  const rangeStart = resolvedRange.from.getTime();
  const rangeEnd = resolvedRange.to.getTime() + DAY_MS;
  const points = state.history.filter(
    (point) => point.createdAt >= rangeStart && point.createdAt < rangeEnd
  );
  const values = points
    .map((point) => point.temperature)
    .filter((value) => typeof value === "number");
  const sum = values.reduce((total, value) => total + value, 0);
  const { coldDurationMs, hotDurationMs } = calculateCriticalDurations(points, rangeStart, rangeEnd);

  return {
    dateFrom: formatDateKey(resolvedRange.from),
    dateTo: formatDateKey(resolvedRange.to),
    from: rangeStart,
    to: rangeEnd,
    count: points.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    avg: values.length ? Number((sum / values.length).toFixed(2)) : null,
    coldDurationMs,
    hotDurationMs,
    tooColdThreshold: TOO_COLD_TEMPERATURE,
    tooHotThreshold: TOO_HOT_TEMPERATURE,
    points
  };
}

function formatDurationForTelegram(durationMs) {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatTemperatureForTelegram(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(2);
}

function formatTimestampForTelegram(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function buildTelegramReportMessage(report) {
  return [
    "Temperature report",
    `Period: ${report.dateFrom} - ${report.dateTo}`,
    `Measurements: ${report.count}`,
    `Min: ${formatTemperatureForTelegram(report.min)} C`,
    `Max: ${formatTemperatureForTelegram(report.max)} C`,
    `Avg: ${formatTemperatureForTelegram(report.avg)} C`,
    `Below ${report.tooColdThreshold} C: ${formatDurationForTelegram(report.coldDurationMs)}`,
    `Above ${report.tooHotThreshold} C: ${formatDurationForTelegram(report.hotDurationMs)}`,
    `Updated: ${formatTimestampForTelegram(state.syncedAt)}`,
    `Source: ${state.source}`
  ].join("\n");
}

async function readTelegramChatIds() {
  try {
    const raw = await fs.readFile(BOT_CHATS_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value) => Number.isInteger(value));
  } catch {
    return [];
  }
}

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Telegram bot token is missing. Set TELEGRAM_BOT_TOKEN or BOT_TOKEN.");
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram request failed with status ${response.status}`);
  }

  return payload.result;
}

async function sendTelegramDocument(chatId, fileBuffer, filename, mimeType, caption) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Telegram bot token is missing. Set TELEGRAM_BOT_TOKEN or BOT_TOKEN.");
  }

  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("document", new Blob([fileBuffer], { type: mimeType }), filename);

  if (caption) {
    formData.append("caption", caption);
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram request failed with status ${response.status}`);
  }

  return payload.result;
}

async function sendTelegramReportToSubscribedChats(text) {
  const chatIds = await readTelegramChatIds();

  if (!chatIds.length) {
    throw new Error("No subscribed Telegram chats found in tempDodoBot/chats.json.");
  }

  const results = await Promise.all(chatIds.map((chatId) => sendTelegramMessage(chatId, text)));
  return {
    chatIds,
    results
  };
}

async function sendTelegramPdfToSubscribedChats(fileBuffer, filename, mimeType, caption) {
  const chatIds = await readTelegramChatIds();

  if (!chatIds.length) {
    throw new Error("No subscribed Telegram chats found in tempDodoBot/chats.json.");
  }

  const results = await Promise.all(
    chatIds.map((chatId) => sendTelegramDocument(chatId, fileBuffer, filename, mimeType, caption))
  );

  return {
    chatIds,
    results
  };
}

async function ensureCacheDir() {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
}

async function writeCache() {
  await ensureCacheDir();
  await fs.writeFile(CACHE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    state.latest = parsed.latest ?? null;
    state.history = sanitizeHistory(parsed.history ?? []);
    state.syncedAt = parsed.syncedAt ?? null;
    state.source = "cache";
  } catch {
    state.latest = null;
    state.history = [];
    state.syncedAt = null;
    state.source = "boot";
  }
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Firebase request failed with status ${response.status}`);
  }

  return response.json();
}

async function syncFromFirebase() {
  const historyStart = formatDatabaseKeyDate(getPeriodStart("halfYear"));
  const latestUrl = `${DATABASE_URL}/sensors/${SENSOR_ID}.json`;
  const historyUrl = `${DATABASE_URL}/history/${SENSOR_ID}.json?orderBy=${encodeURIComponent(
    '"$key"'
  )}&startAt=${encodeURIComponent(JSON.stringify(historyStart))}`;

  const [rawLatest, rawHistory] = await Promise.all([
    fetchJson(latestUrl),
    fetchJson(historyUrl)
  ]);

  const history = rawHistory
    ? Object.entries(rawHistory)
        .map(([key, value]) => mapHistoryPoint(key, value))
        .filter(Boolean)
    : [];

  state.latest = mapLatestData(rawLatest);
  state.history = sanitizeHistory(history);
  state.syncedAt = Date.now();
  state.source = "firebase";

  await writeCache();

  return {
    latest: state.latest,
    report: buildReport("day"),
    syncedAt: state.syncedAt,
    source: state.source
  };
}

function startBackgroundSync() {
  setInterval(async () => {
    try {
      await syncFromFirebase();
      console.log("[temperature] background sync complete");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[temperature] background sync failed:", message);
    }
  }, 30_000);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "temperature-backend",
    source: state.source,
    syncedAt: state.syncedAt
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    source: state.source,
    syncedAt: state.syncedAt,
    historyPoints: state.history.length
  });
});

app.get("/api/temperature/latest", (req, res) => {
  res.json({
    success: true,
    latest: state.latest,
    syncedAt: state.syncedAt,
    source: state.source
  });
});

app.get("/api/temperature", (req, res) => {
  const period =
    typeof req.query.period === "string" && VALID_PERIODS.includes(req.query.period)
      ? req.query.period
      : "day";

  res.json({
    success: true,
    latest: state.latest,
    report: buildReport(period),
    syncedAt: state.syncedAt,
    source: state.source
  });
});

app.get("/api/temperature/daily-report", (req, res) => {
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : null;
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : null;

  res.json({
    success: true,
    report: buildDailyReport(dateFrom, dateTo),
    syncedAt: state.syncedAt,
    source: state.source
  });
});

app.post("/api/temperature/send-telegram-report", async (req, res) => {
  const dateFrom = typeof req.body?.dateFrom === "string" ? req.body.dateFrom : null;
  const dateTo = typeof req.body?.dateTo === "string" ? req.body.dateTo : null;

  try {
    const report = buildDailyReport(dateFrom, dateTo);
    const text = buildTelegramReportMessage(report);
    const telegramDelivery = await sendTelegramReportToSubscribedChats(text);

    res.json({
      success: true,
      report,
      telegramMessageId: telegramDelivery.results[0]?.message_id ?? null,
      deliveredChats: telegramDelivery.chatIds.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram send failed";
    res.status(500).json({ success: false, error: message });
  }
});

app.post(
  "/api/temperature/send-telegram-report-pdf",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file?.buffer?.length) {
        res.status(400).json({ success: false, error: "PDF file is required." });
        return;
      }

      const dateFrom = typeof req.body?.dateFrom === "string" ? req.body.dateFrom : null;
      const dateTo = typeof req.body?.dateTo === "string" ? req.body.dateTo : null;
      const report = buildDailyReport(dateFrom, dateTo);
      const caption = `Temperature report ${report.dateFrom} - ${report.dateTo}`;
      const telegramDelivery = await sendTelegramPdfToSubscribedChats(
        req.file.buffer,
        req.file.originalname || `temperature-report-${report.dateFrom}-${report.dateTo}.pdf`,
        req.file.mimetype || "application/pdf",
        caption
      );

      res.json({
        success: true,
        report,
        telegramMessageId: telegramDelivery.results[0]?.message_id ?? null,
        deliveredChats: telegramDelivery.chatIds.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Telegram PDF send failed";
      res.status(500).json({ success: false, error: message });
    }
  }
);

app.post("/api/temperature/sync", async (req, res) => {
  try {
    const result = await syncFromFirebase();
    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    res.status(500).json({ success: false, error: message });
  }
});

app.listen(PORT, async () => {
  await loadCache();
  console.log(`Server started on http://localhost:${PORT}`);

  try {
    await syncFromFirebase();
    console.log("[temperature] initial sync complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[temperature] initial sync failed, using cache if available:", message);
  }

  startBackgroundSync();
});
