import { differenceInCalendarDays, format as formatDateFns } from "date-fns";
import { ru } from "date-fns/locale";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { useEffect, useMemo, useRef, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import "./Temperature.scss";

type TemperaturePoint = {
  temperature: number | null;
  createdAt: number;
  unit: string;
  sensorId: string | null;
};

type LatestTemperature = {
  id: string;
  temperature: number | null;
  unit: string | null;
  sensorId: string | null;
  createdAt: number | null;
} | null;

type ReportPeriod = "day" | "week" | "month" | "halfYear";

type ReportData = {
  period: ReportPeriod;
  from: number;
  to: number;
  points: TemperaturePoint[];
  count: number;
  min: number | null;
  max: number | null;
};

type TemperatureApiResponse = {
  success: boolean;
  latest: LatestTemperature;
  report: ReportData;
  syncedAt: number | null;
  source: string;
};

type DailyReport = {
  dateFrom: string;
  dateTo: string;
  from: number;
  to: number;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  coldDurationMs: number;
  hotDurationMs: number;
  tooColdThreshold: number;
  tooHotThreshold: number;
  points: TemperaturePoint[];
};

type DailyReportApiResponse = {
  success: boolean;
  report: DailyReport;
  syncedAt: number | null;
  source: string;
};

type TelegramReportApiResponse = {
  success: boolean;
  report: DailyReport;
  telegramMessageId: number | null;
  deliveredChats?: number;
  error?: string;
};

type ChartTooltip = {
  x: number;
  y: number;
  label: string;
  value: string;
};

const PERIOD_OPTIONS = [
  { value: "day", label: "День", heading: "За последние 24 часа" },
  { value: "week", label: "Неделя", heading: "За последние 7 дней" },
  { value: "month", label: "Месяц", heading: "За последние 30 дней" },
  { value: "halfYear", label: "Полгода", heading: "За последние 6 месяцев" }
] as const;

type PointIntervalMinutes = number;

const POINT_INTERVAL_OPTIONS_BY_PERIOD: Record<
  ReportPeriod,
  { value: PointIntervalMinutes; label: string }[]
> = {
  day: [
    { value: 0, label: "Все точки" },
    { value: 1, label: "1 мин" },
    { value: 5, label: "5 мин" },
    { value: 10, label: "10 мин" },
    { value: 30, label: "30 мин" },
    { value: 60, label: "1 час" }
  ],
  week: [
    { value: 0, label: "Все точки" },
    { value: 360, label: "6 часов" },
    { value: 720, label: "12 часов" },
    { value: 1440, label: "1 день" },
    { value: 2880, label: "2 дня" }
  ],
  month: [
    { value: 0, label: "Все точки" },
    { value: 1440, label: "1 день" },
    { value: 4320, label: "3 дня" },
    { value: 10080, label: "1 неделя" },
    { value: 20160, label: "2 недели" }
  ],
  halfYear: [
    { value: 0, label: "Все точки" },
    { value: 10080, label: "1 неделя" },
    { value: 20160, label: "2 недели" },
    { value: 43200, label: "1 месяц" },
    { value: 86400, label: "2 месяца" }
  ]
};

const DEFAULT_POINT_INTERVAL_BY_PERIOD: Record<ReportPeriod, PointIntervalMinutes> = {
  day: 10,
  week: 360,
  month: 1440,
  halfYear: 10080
};

const TOO_COLD_TEMPERATURE = 22;
const TOO_HOT_TEMPERATURE = 40;
const CHART_WIDTH = 1000;
const CHART_HEIGHT = 280;
const CHART_PADDING_X = 56;
const CHART_PADDING_Y = 20;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

const formatUpdatedAt = (value: number | null) => {
  if (!value) {
    return "Нет данных";
  }

  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
};

const formatShortTime = (value: number) =>
  new Date(value).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit"
  });

const formatShortDate = (value: number) =>
  new Date(value).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit"
  });

const formatTemperature = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return "--";
  }

  return value.toFixed(2);
};

const formatDateInputValue = (value: Date) => formatDateFns(value, "yyyy-MM-dd");

const formatRangeDate = (value: Date) =>
  formatDateFns(value, "d MMMM yyyy", {
    locale: ru
  });

const formatReportDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
};

const formatDuration = (durationMs: number) => {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours} ч ${String(minutes).padStart(2, "0")} мин`;
};

const isCriticalTemperature = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return false;
  }

  return value < TOO_COLD_TEMPERATURE || value > TOO_HOT_TEMPERATURE;
};

const getTemperatureColor = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return "#22c55e";
  }

  if (value > TOO_HOT_TEMPERATURE) {
    return "#ef4444";
  }

  if (value < TOO_COLD_TEMPERATURE) {
    return "#3b82f6";
  }

  return "#22c55e";
};

const getTemperatureAlert = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return null;
  }

  if (value > TOO_HOT_TEMPERATURE) {
    return {
      title: "Слишком жарко",
      message: "В зале слишком высокая температура."
    } as const;
  }

  if (value < TOO_COLD_TEMPERATURE) {
    return {
      title: "Слишком холодно",
      message: "Температура опустилась ниже комфортного диапазона."
    } as const;
  }

  return null;
};

const filterPointsByInterval = (
  points: TemperaturePoint[],
  intervalMinutes: PointIntervalMinutes
) => {
  if (intervalMinutes === 0 || points.length <= 2) {
    return points;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  const includedIndexes = new Set<number>();
  let lastPointTime: number | null = null;

  points.forEach((point, index) => {
    if (lastPointTime === null || point.createdAt - lastPointTime >= intervalMs) {
      includedIndexes.add(index);
      lastPointTime = point.createdAt;
    }
  });

  points.forEach((point, index) => {
    if (!isCriticalTemperature(point.temperature)) {
      return;
    }

    includedIndexes.add(index);

    if (index > 0 && points[index - 1]?.temperature !== null) {
      includedIndexes.add(index - 1);
    }

    if (index < points.length - 1 && points[index + 1]?.temperature !== null) {
      includedIndexes.add(index + 1);
    }
  });

  includedIndexes.add(0);
  includedIndexes.add(points.length - 1);

  return Array.from(includedIndexes)
    .sort((left, right) => left - right)
    .map((index) => points[index]!)
    .filter(Boolean);
};

const getChartPointPosition = (
  point: TemperaturePoint,
  index: number,
  points: TemperaturePoint[],
  minValue: number,
  maxValue: number
) => {
  const drawableWidth = CHART_WIDTH - CHART_PADDING_X * 2;
  const drawableHeight = CHART_HEIGHT - CHART_PADDING_Y * 2;
  const safeRange = Math.max(maxValue - minValue, 1);
  const x =
    points.length === 1
      ? CHART_WIDTH / 2
      : CHART_PADDING_X + (drawableWidth / (points.length - 1)) * index;
  const y =
    CHART_HEIGHT -
    CHART_PADDING_Y -
    (((point.temperature as number) - minValue) / safeRange) * drawableHeight;

  return { x, y };
};

const normalizeRange = (range: DateRange | undefined) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const from = range?.from ?? today;
  const rawTo = range?.to ?? range?.from ?? today;
  const safeFrom = new Date(from);
  const safeTo = new Date(rawTo);
  safeFrom.setHours(0, 0, 0, 0);
  safeTo.setHours(0, 0, 0, 0);

  return safeFrom.getTime() <= safeTo.getTime()
    ? { from: safeFrom, to: safeTo }
    : { from: safeTo, to: safeFrom };
};

const buildReportPdf = async (
  element: HTMLDivElement,
  report: DailyReport
): Promise<{ blob: Blob; filename: string }> => {
  const canvas = await html2canvas(element, {
    backgroundColor: "#07111f",
    scale: 2,
    useCORS: true
  });
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4"
  });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = (canvas.height * contentWidth) / canvas.width;
  const renderHeight = Math.min(contentHeight, pageHeight - margin * 2);

  pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin, margin, contentWidth, renderHeight);

  return {
    blob: pdf.output("blob"),
    filename: `temperature-report-${report.dateFrom}-${report.dateTo}.pdf`
  };
};

const Temperature = () => {
  const today = useMemo(() => {
    const value = new Date();
    value.setHours(0, 0, 0, 0);
    return value;
  }, []);
  const [data, setData] = useState<LatestTemperature>(null);
  const [report, setReport] = useState<ReportData>();
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<ReportPeriod>("day");
  const [selectedPointInterval, setSelectedPointInterval] =
    useState<PointIntervalMinutes>(DEFAULT_POINT_INTERVAL_BY_PERIOD.day);
  const [selectedReportRange, setSelectedReportRange] = useState<DateRange | undefined>(() => ({
    from: today,
    to: today
  }));
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isReportLoading, setIsReportLoading] = useState(true);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isSendingTelegramText, setIsSendingTelegramText] = useState(false);
  const [isSendingTelegramPdf, setIsSendingTelegramPdf] = useState(false);
  const [isRangePickerOpen, setIsRangePickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [reportError, setReportError] = useState("");
  const [telegramStatus, setTelegramStatus] = useState("");
  const [tooltip, setTooltip] = useState<ChartTooltip | null>(null);
  const [sourceInfo, setSourceInfo] = useState<{ source: string; syncedAt: number | null }>({
    source: "boot",
    syncedAt: null
  });
  const isAlertLoopRunningRef = useRef(false);
  const reportExportRef = useRef<HTMLDivElement | null>(null);
  const rangePickerRef = useRef<HTMLDivElement | null>(null);

  const effectiveReportRange = useMemo(
    () => normalizeRange(selectedReportRange),
    [selectedReportRange]
  );
  const selectedReportDayCount =
    differenceInCalendarDays(effectiveReportRange.to, effectiveReportRange.from) + 1;

  const loadData = async (period: ReportPeriod, showLoader: boolean) => {
    if (showLoader) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/temperature?period=${period}`);

      if (!response.ok) {
        throw new Error("Failed to load temperature data");
      }

      const payload = (await response.json()) as TemperatureApiResponse;
      setData(payload.latest);
      setReport(payload.report);
      setSourceInfo({ source: payload.source, syncedAt: payload.syncedAt });
      setError("");
    } catch {
      setError("Не удалось получить температуру через локальный backend.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  const loadDailyReport = async (dateFrom: string, dateTo: string) => {
    setIsReportLoading(true);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/temperature/daily-report?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`
      );

      if (!response.ok) {
        throw new Error("Failed to load daily report");
      }

      const payload = (await response.json()) as DailyReportApiResponse;
      setDailyReport(payload.report);
      setReportError("");
    } catch {
      setDailyReport(null);
      setReportError("Не удалось получить отчет по выбранному диапазону.");
    } finally {
      setIsReportLoading(false);
    }
  };

  const handleExportPdf = async () => {
    if (!reportExportRef.current || !dailyReport) {
      return;
    }

    setIsExportingPdf(true);

    try {
      const { blob, filename } = await buildReportPdf(reportExportRef.current, dailyReport);
      const url = URL.createObjectURL(blob);

      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handleSendTelegramTextReport = async () => {
    if (!dailyReport) {
      return;
    }

    setIsSendingTelegramText(true);
    setTelegramStatus("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/temperature/send-telegram-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          dateFrom: dailyReport.dateFrom,
          dateTo: dailyReport.dateTo
        })
      });

      const payload = (await response.json()) as TelegramReportApiResponse;

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Failed to send Telegram text report");
      }

      const deliveredChatsText =
        typeof payload.deliveredChats === "number" ? ` (${payload.deliveredChats} chats)` : "";
      setTelegramStatus(`Сообщение отправлено в Telegram${deliveredChatsText}.`);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : "Не удалось отправить сообщение в Telegram.";
      setTelegramStatus(message);
    } finally {
      setIsSendingTelegramText(false);
    }
  };

  const handleSendTelegramPdfReport = async () => {
    if (!dailyReport || !reportExportRef.current) {
      return;
    }

    setIsSendingTelegramPdf(true);
    setTelegramStatus("");

    try {
      const { blob, filename } = await buildReportPdf(reportExportRef.current, dailyReport);
      const formData = new FormData();
      formData.append("file", blob, filename);
      formData.append("dateFrom", dailyReport.dateFrom);
      formData.append("dateTo", dailyReport.dateTo);

      const response = await fetch(`${API_BASE_URL}/api/temperature/send-telegram-report-pdf`, {
        method: "POST",
        body: formData
      });

      const payload = (await response.json()) as TelegramReportApiResponse;

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Failed to send Telegram PDF report");
      }

      const deliveredChatsText =
        typeof payload.deliveredChats === "number" ? ` (${payload.deliveredChats} chats)` : "";
      setTelegramStatus(`PDF отправлен в Telegram${deliveredChatsText}.`);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : "Не удалось отправить PDF в Telegram.";
      setTelegramStatus(message);
    } finally {
      setIsSendingTelegramPdf(false);
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      void loadData(selectedPeriod, true);
    });

    const intervalId = window.setInterval(() => {
      void loadData(selectedPeriod, false);
    }, 30_000);

    return () => window.clearInterval(intervalId);
  }, [selectedPeriod]);

  useEffect(() => {
    if (isLoading || error || isAlertLoopRunningRef.current) {
      return;
    }

    const nextAlert = getTemperatureAlert(data?.temperature ?? null);

    if (!nextAlert) {
      return;
    }

    isAlertLoopRunningRef.current = true;
    window.alert(`${nextAlert.title}. ${nextAlert.message}`);
    isAlertLoopRunningRef.current = false;
  }, [data, error, isLoading]);

  useEffect(() => {
    void loadDailyReport(
      formatDateInputValue(effectiveReportRange.from),
      formatDateInputValue(effectiveReportRange.to)
    );
  }, [effectiveReportRange.from, effectiveReportRange.to, sourceInfo.syncedAt]);

  useEffect(() => {
    if (!isRangePickerOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rangePickerRef.current?.contains(event.target as Node)) {
        setIsRangePickerOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isRangePickerOpen]);

  const chart = useMemo(() => {
    const rawPoints = report?.points ?? [];
    const points = filterPointsByInterval(rawPoints, selectedPointInterval);
    const latestTemperature = data?.temperature ?? null;
    const visiblePoints = points.filter((point) => point.temperature !== null);
    const visibleValues = visiblePoints.map((point) => point.temperature as number);
    const minValue =
      visibleValues.length > 0
        ? Math.min(...visibleValues)
        : latestTemperature !== null
          ? latestTemperature
          : null;
    const maxValue =
      visibleValues.length > 0
        ? Math.max(...visibleValues)
        : latestTemperature !== null
          ? latestTemperature
          : null;

    if (visiblePoints.length === 0 || minValue === null || maxValue === null) {
      return null;
    }

    const paddedMin = Math.floor((minValue - 1) * 10) / 10;
    const paddedMax = Math.ceil((maxValue + 1) * 10) / 10;

    return {
      points,
      minValue: paddedMin,
      maxValue: paddedMax
    };
  }, [data?.temperature, report, selectedPointInterval]);

  const selectedPeriodOption =
    PERIOD_OPTIONS.find((option) => option.value === selectedPeriod) ?? PERIOD_OPTIONS[0];
  const pointIntervalOptions = POINT_INTERVAL_OPTIONS_BY_PERIOD[selectedPeriod];

  const xAxisLabels = useMemo(() => {
    if (!chart || chart.points.length === 0) {
      return [];
    }

    const labelCount = selectedPeriod === "day" ? 4 : 5;
    const lastIndex = chart.points.length - 1;
    const drawableWidth = CHART_WIDTH - CHART_PADDING_X * 2;

    return Array.from({ length: labelCount }, (_, index) => {
      const ratio = index / (labelCount - 1);
      const pointIndex = Math.round(lastIndex * ratio);
      const point = chart.points[pointIndex]!;

      return {
        x:
          chart.points.length === 1
            ? CHART_WIDTH / 2
            : CHART_PADDING_X + (drawableWidth / lastIndex) * pointIndex,
        label:
          selectedPeriod === "day"
            ? formatShortTime(point.createdAt)
            : formatShortDate(point.createdAt)
      };
    });
  }, [chart, selectedPeriod]);

  return (
    <main className="temperature-page">
      <div className="temperature-shell">
        <header className="temperature-header">
          <div>
            <p className="temperature-kicker">Датчик ESP32</p>
            <h1>Температура зала</h1>
            <p className="temperature-subtitle">
              Фронтенд берет данные только из локального backend. Сервер сам
              синхронизируется с Firebase RTDB, кеширует историю и отдает готовые данные для
              графика.
            </p>
          </div>

          <div className="temperature-actions">
            <button
              type="button"
              className="temperature-refresh-button"
              onClick={() => void loadData(selectedPeriod, false)}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Обновляем..." : "Обновить"}
            </button>
          </div>
        </header>

        <section className="temperature-hero-card">
          <div className="temperature-reading-block">
            <p className="temperature-reading-label">Текущее значение</p>
            <div className="temperature-reading">
              <strong>{formatTemperature(data?.temperature ?? null)}</strong>
              <span>{data?.unit || "C"}</span>
            </div>
          </div>

          <div className="temperature-meta-grid">
            <article className="temperature-meta-card">
              <span>Последнее обновление</span>
              <strong>{formatUpdatedAt(data?.createdAt ?? null)}</strong>
            </article>
            <article className="temperature-meta-card">
              <span>Источник</span>
              <strong>{data?.sensorId || "ESP32"}</strong>
            </article>
            <article className="temperature-meta-card">
              <span>Режим</span>
              <strong>
                {sourceInfo.source === "firebase"
                  ? "Локальный cache + Firebase"
                  : "Локальный cache"}
              </strong>
            </article>
          </div>
        </section>

        <section className="temperature-summary-grid">
          <article className="temperature-summary-card">
            <span>Интервал</span>
            <strong>{selectedPeriodOption.label}</strong>
          </article>
          <article className="temperature-summary-card">
            <span>Минимум</span>
            <strong>{formatTemperature(report?.min ?? null)} C</strong>
          </article>
          <article className="temperature-summary-card">
            <span>Максимум</span>
            <strong>{formatTemperature(report?.max ?? null)} C</strong>
          </article>
          <article className="temperature-summary-card">
            <span>Точек</span>
            <strong>
              {chart?.points.length ?? 0} / {report?.points.length ?? 0}
            </strong>
          </article>
        </section>

        <section className="temperature-report-card">
          <div className="temperature-report-header">
            <div>
              <p className="temperature-chart-kicker">Отчет</p>
              <h2>Сводка по выбранному диапазону</h2>
            </div>

            <div className="temperature-report-actions">
              <div className="temperature-report-range-picker" ref={rangePickerRef}>
                <button
                  type="button"
                  className="temperature-report-range-button"
                  onClick={() => setIsRangePickerOpen((value) => !value)}
                >
                  <span className="temperature-report-range-label">Период отчета</span>
                  <strong className="temperature-report-range-value">
                    {formatRangeDate(effectiveReportRange.from)} -{" "}
                    {formatRangeDate(effectiveReportRange.to)}
                  </strong>
                </button>

                {isRangePickerOpen ? (
                  <div className="temperature-report-calendar-popover">
                    <DayPicker
                      mode="range"
                      locale={ru}
                      weekStartsOn={1}
                      numberOfMonths={2}
                      selected={selectedReportRange}
                      defaultMonth={effectiveReportRange.from}
                      onSelect={(range) => setSelectedReportRange(range)}
                      disabled={{ after: today }}
                      className="temperature-daypicker"
                    />

                    <div className="temperature-report-calendar-footer">
                      <button
                        type="button"
                        className="temperature-report-calendar-action"
                        onClick={() =>
                          setSelectedReportRange({
                            from: today,
                            to: today
                          })
                        }
                      >
                        Сегодня
                      </button>
                      <button
                        type="button"
                        className="temperature-report-calendar-action"
                        onClick={() => setIsRangePickerOpen(false)}
                      >
                        Готово
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                className="temperature-refresh-button"
                onClick={() =>
                  void loadDailyReport(
                    formatDateInputValue(effectiveReportRange.from),
                    formatDateInputValue(effectiveReportRange.to)
                  )
                }
                disabled={isReportLoading || isExportingPdf}
              >
                {isReportLoading ? "Загружаем..." : "Обновить отчет"}
              </button>
              <button
                type="button"
                className="temperature-refresh-button"
                onClick={() => void handleSendTelegramTextReport()}
                disabled={
                  isReportLoading ||
                  isExportingPdf ||
                  isSendingTelegramText ||
                  isSendingTelegramPdf ||
                  !dailyReport
                }
              >
                {isSendingTelegramText ? "Отправляем..." : "Отправить сообщением"}
              </button>
              <button
                type="button"
                className="temperature-refresh-button"
                onClick={() => void handleSendTelegramPdfReport()}
                disabled={
                  isReportLoading ||
                  isExportingPdf ||
                  isSendingTelegramText ||
                  isSendingTelegramPdf ||
                  !dailyReport
                }
              >
                {isSendingTelegramPdf ? "Отправляем..." : "Отправить PDF"}
              </button>
              <button
                type="button"
                className="temperature-refresh-button"
                onClick={() => void handleExportPdf()}
                disabled={isReportLoading || isExportingPdf || !dailyReport}
              >
                {isExportingPdf ? "PDF создается..." : "Скачать PDF"}
              </button>
            </div>
          </div>

          <p className="temperature-report-days-count">
            Выбрано дней: <strong>{selectedReportDayCount}</strong>
          </p>

          {telegramStatus ? (
            <p
              className={
                telegramStatus.startsWith("PDF отправлен в Telegram") ||
                telegramStatus.startsWith("Сообщение отправлено в Telegram")
                  ? "temperature-status-text"
                  : "temperature-status-text temperature-status-error"
              }
            >
              {telegramStatus}
            </p>
          ) : null}

          {isReportLoading ? (
            <p className="temperature-status-text">Формируем отчет...</p>
          ) : reportError ? (
            <p className="temperature-status-text temperature-status-error">{reportError}</p>
          ) : dailyReport ? (
            <div className="temperature-report-export" ref={reportExportRef}>
              <div className="temperature-report-sheet">
                <div className="temperature-report-sheet-header">
                  <div>
                    <p className="temperature-kicker">Temperature Report</p>
                    <h3>
                      Отчет с {formatReportDate(dailyReport.dateFrom)} по{" "}
                      {formatReportDate(dailyReport.dateTo)}
                    </h3>
                  </div>
                  <div className="temperature-report-sheet-meta">
                    <span>Последнее обновление</span>
                    <strong>{formatUpdatedAt(sourceInfo.syncedAt)}</strong>
                  </div>
                </div>

                <div className="temperature-report-grid">
                  <article className="temperature-report-metric">
                    <span>Максимальная температура</span>
                    <strong>{formatTemperature(dailyReport.max)} C</strong>
                  </article>
                  <article className="temperature-report-metric">
                    <span>Минимальная температура</span>
                    <strong>{formatTemperature(dailyReport.min)} C</strong>
                  </article>
                  <article className="temperature-report-metric">
                    <span>Средняя температура</span>
                    <strong>{formatTemperature(dailyReport.avg)} C</strong>
                  </article>
                  <article className="temperature-report-metric">
                    <span>Количество измерений</span>
                    <strong>{dailyReport.count}</strong>
                  </article>
                </div>

                <div className="temperature-report-grid temperature-report-grid-critical">
                  <article className="temperature-report-metric temperature-report-metric-cold">
                    <span>Время ниже {dailyReport.tooColdThreshold} C</span>
                    <strong>{formatDuration(dailyReport.coldDurationMs)}</strong>
                  </article>
                  <article className="temperature-report-metric temperature-report-metric-hot">
                    <span>Время выше {dailyReport.tooHotThreshold} C</span>
                    <strong>{formatDuration(dailyReport.hotDurationMs)}</strong>
                  </article>
                </div>

                <p className="temperature-report-note">
                  Длительность критических интервалов считается по промежуткам между соседними
                  измерениями в пределах выбранного диапазона.
                </p>
              </div>
            </div>
          ) : (
            <p className="temperature-status-text">Нет данных для отчета.</p>
          )}
        </section>

        <section className="temperature-chart-card">
          <div className="temperature-chart-header">
            <div>
              <p className="temperature-chart-kicker">График температуры</p>
              <h2>{selectedPeriodOption.heading}</h2>
            </div>
          </div>

          <div className="temperature-period-switcher" role="tablist" aria-label="Период графика">
            {PERIOD_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  option.value === selectedPeriod
                    ? "temperature-period-button temperature-period-button-active"
                    : "temperature-period-button"
                }
                onClick={() => {
                  setSelectedPeriod(option.value);
                  setSelectedPointInterval(DEFAULT_POINT_INTERVAL_BY_PERIOD[option.value]);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="temperature-point-controls">
            <span>Частота точек</span>
            <div
              className="temperature-period-switcher"
              role="tablist"
              aria-label="Частота точек графика"
            >
              {pointIntervalOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={
                    option.value === selectedPointInterval
                      ? "temperature-period-button temperature-period-button-active"
                      : "temperature-period-button"
                  }
                  onClick={() => setSelectedPointInterval(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {chart ? (
            <div className="temperature-chart-wrap">
              <div className="temperature-chart-axis-label temperature-chart-axis-label-y">
                Температура, °C
              </div>
              <svg
                className="temperature-chart"
                viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                role="img"
                aria-label="График температуры за выбранный период"
                preserveAspectRatio="none"
              >
                {[0, 0.5, 1].map((ratio) => {
                  const y = CHART_PADDING_Y + (CHART_HEIGHT - CHART_PADDING_Y * 2) * ratio;

                  return (
                    <line
                      key={ratio}
                      x1={CHART_PADDING_X}
                      y1={y}
                      x2={CHART_WIDTH - CHART_PADDING_X}
                      y2={y}
                      className="temperature-chart-grid"
                    />
                  );
                })}

                {[chart.maxValue, (chart.maxValue + chart.minValue) / 2, chart.minValue].map(
                  (value, index) => {
                    const ratio = index / 2;
                    const y = CHART_PADDING_Y + (CHART_HEIGHT - CHART_PADDING_Y * 2) * ratio;

                    return (
                      <text
                        key={`${value}-${index}`}
                        x={CHART_PADDING_X - 12}
                        y={y + 4}
                        textAnchor="end"
                        className="temperature-chart-y-label"
                      >
                        {value.toFixed(1)}
                      </text>
                    );
                  }
                )}

                {chart.points.map((point, index) => {
                  if (index === 0 || point.temperature === null) {
                    return null;
                  }

                  const previousPoint = chart.points[index - 1];

                  if (!previousPoint || previousPoint.temperature === null) {
                    return null;
                  }

                  const start = getChartPointPosition(
                    previousPoint,
                    index - 1,
                    chart.points,
                    chart.minValue,
                    chart.maxValue
                  );
                  const end = getChartPointPosition(
                    point,
                    index,
                    chart.points,
                    chart.minValue,
                    chart.maxValue
                  );
                  const segmentColor = getTemperatureColor(
                    (previousPoint.temperature + point.temperature) / 2
                  );

                  return (
                    <line
                      key={`segment-${previousPoint.createdAt}-${point.createdAt}-${index}`}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      className="temperature-chart-line"
                      style={{ stroke: segmentColor }}
                    />
                  );
                })}

                {chart.points.map((point, index) => {
                  if (point.temperature === null) {
                    return null;
                  }

                  const { x, y } = getChartPointPosition(
                    point,
                    index,
                    chart.points,
                    chart.minValue,
                    chart.maxValue
                  );

                  const label =
                    selectedPeriod === "day"
                      ? formatShortTime(point.createdAt)
                      : formatShortDate(point.createdAt);
                  const value = `${point.temperature.toFixed(2)} ${point.unit}`;

                  return (
                    <circle
                      key={`${point.createdAt}-${index}`}
                      cx={x}
                      cy={y}
                      r="5"
                      className="temperature-chart-point"
                      style={{ stroke: getTemperatureColor(point.temperature) }}
                      onMouseEnter={() => setTooltip({ x, y, label, value })}
                      onMouseMove={() => setTooltip({ x, y, label, value })}
                      onMouseLeave={() => setTooltip(null)}
                    />
                  );
                })}

                {xAxisLabels.map((item, index) => (
                  <text
                    key={`${item.label}-${index}`}
                    x={item.x}
                    y={CHART_HEIGHT - 2}
                    textAnchor="middle"
                    className="temperature-chart-x-label"
                  >
                    {item.label}
                  </text>
                ))}

                {tooltip && (
                  <g
                    transform={`translate(${Math.min(tooltip.x + 12, CHART_WIDTH - 140)} ${Math.max(
                      tooltip.y - 56,
                      16
                    )})`}
                  >
                    <rect
                      width="128"
                      height="46"
                      rx="12"
                      className="temperature-chart-tooltip-box"
                    />
                    <text x="12" y="18" className="temperature-chart-tooltip-label">
                      {tooltip.label}
                    </text>
                    <text x="12" y="34" className="temperature-chart-tooltip-value">
                      {tooltip.value}
                    </text>
                  </g>
                )}
              </svg>

              <div className="temperature-chart-footer">
                <span>
                  {report
                    ? selectedPeriod === "day"
                      ? formatShortTime(report.from)
                      : formatShortDate(report.from)
                    : "--"}
                </span>
                <span>
                  {report
                    ? selectedPeriod === "day"
                      ? formatShortTime(report.to)
                      : formatShortDate(report.to)
                    : "--"}
                </span>
              </div>
              <div className="temperature-chart-axis-label temperature-chart-axis-label-x">
                {selectedPeriod === "day" ? "Время" : "Дата"}
              </div>
            </div>
          ) : (
            <p className="temperature-chart-empty">
              Пока недостаточно данных для построения графика.
            </p>
          )}
        </section>

        <section className="temperature-status-card">
          {isLoading ? (
            <p className="temperature-status-text">
              Загружаем данные через локальный backend...
            </p>
          ) : error ? (
            <p className="temperature-status-text temperature-status-error">{error}</p>
          ) : data?.temperature === null || data?.temperature === undefined ? (
            <p className="temperature-status-text">
              Данные пока не приходили. Проверь ESP32 или синхронизацию backend с Firebase.
            </p>
          ) : (
            <p className="temperature-status-text">
              Последняя синхронизация backend: {formatUpdatedAt(sourceInfo.syncedAt)}.
            </p>
          )}
        </section>
      </div>
    </main>
  );
};

export default Temperature;
