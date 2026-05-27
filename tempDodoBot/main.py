import asyncio
import json
import os
import re
import time
from io import BytesIO
from datetime import date, datetime, timedelta, timezone
from typing import Any

from aiohttp import ClientError, ClientSession
from aiogram import Bot, Dispatcher
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import BufferedInputFile, KeyboardButton, Message, ReplyKeyboardMarkup
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

CHATS_FILE = "chats.json"
DEFAULT_CODE_WORDS = "додо,код,кодовое слово"
DEFAULT_FIREBASE_SENSOR_PATH = "sensors/esp32"
DEFAULT_FIREBASE_HISTORY_PATH = "history/esp32"
MINMAX_USAGE = "/minmax 2026-05-26T10:00 2026-05-26T18:30"
REPORT_USAGE = "/report 2026-05-26 2026-05-27"
REPORT_PDF_USAGE = "/reportpdf 2026-05-26 2026-05-27"


def load_env_file(env_path: str = ".env") -> None:
    if not os.path.exists(env_path):
        return

    with open(env_path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")

            if key and key not in os.environ:
                os.environ[key] = value


load_env_file()

BOT_TOKEN = os.getenv("BOT_TOKEN")
FIREBASE_DB_URL = os.getenv("FIREBASE_DB_URL")
FIREBASE_DB_AUTH = os.getenv("FIREBASE_DB_AUTH")
FIREBASE_SENSOR_PATH = os.getenv("FIREBASE_SENSOR_PATH", DEFAULT_FIREBASE_SENSOR_PATH).strip("/")
FIREBASE_HISTORY_PATH = os.getenv("FIREBASE_HISTORY_PATH", DEFAULT_FIREBASE_HISTORY_PATH).strip("/")
ALERT_MIN_TEMP = float(os.getenv("ALERT_MIN_TEMP", "22"))
ALERT_MAX_TEMP = float(os.getenv("ALERT_MAX_TEMP", "40"))
ALERT_COOLDOWN = int(os.getenv("ALERT_COOLDOWN", "60"))
CODE_WORDS = {
    word.strip().casefold()
    for word in os.getenv("BOT_CODE_WORDS", DEFAULT_CODE_WORDS).split(",")
    if word.strip()
}

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is not set. Create a .env file and add BOT_TOKEN=your_token")

if not FIREBASE_DB_URL:
    raise RuntimeError("FIREBASE_DB_URL is not set. Create a .env file and add your Firebase Realtime Database URL")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
http_session: ClientSession | None = None


def load_chats() -> set[int]:
    if os.path.exists(CHATS_FILE):
        try:
            with open(CHATS_FILE, "r", encoding="utf-8") as f:
                return set(json.load(f))
        except Exception as e:
            print(f"Ошибка загрузки чатов: {e}")
    return set()


def save_chats(chats: set[int]) -> None:
    try:
        with open(CHATS_FILE, "w", encoding="utf-8") as f:
            json.dump(list(chats), f)
    except Exception as e:
        print(f"Ошибка сохранения чатов: {e}")


def normalize_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.strip())
    return cleaned.casefold()


def message_has_code_word(text: str) -> bool:
    return normalize_text(text) in CODE_WORDS


def format_display_time(value: str | None) -> str:
    if not value:
        return "неизвестно"

    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%d.%m.%Y %H:%M:%S")
    except ValueError:
        return value


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_local_datetime(value: str) -> datetime:
    normalized = value.strip().replace(" ", "T")
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(normalized, fmt).astimezone()
        except ValueError:
            continue
    raise ValueError("invalid datetime format")


def parse_report_date(value: str) -> date:
    return datetime.strptime(value.strip(), "%Y-%m-%d").date()


def build_firebase_url(path: str, params: dict[str, Any] | None = None) -> str:
    base_url = FIREBASE_DB_URL.rstrip("/")
    url = f"{base_url}/{path.strip('/')}.json"
    query_params: list[str] = []
    if params:
        for key, value in params.items():
            query_params.append(f"{key}={value}")
    if FIREBASE_DB_AUTH:
        query_params.append(f"auth={FIREBASE_DB_AUTH}")
    if query_params:
        url = f"{url}?{'&'.join(query_params)}"
    return url


async def firebase_get_json(path: str, params: dict[str, Any] | None = None) -> Any:
    if http_session is None:
        raise RuntimeError("HTTP session is not initialized")

    try:
        async with http_session.get(build_firebase_url(path, params)) as response:
            response.raise_for_status()
            return await response.json()
    except ClientError as e:
        print(f"Ошибка чтения из Firebase: {e}")
        return None


async def get_latest_data() -> dict[str, Any] | None:
    data = await firebase_get_json(FIREBASE_SENSOR_PATH)
    if not isinstance(data, dict):
        return None
    return data


async def get_history_data() -> dict[str, Any]:
    data = await firebase_get_json(FIREBASE_HISTORY_PATH)
    if isinstance(data, dict):
        return data
    return {}


def build_temperature_text(title: str, data: dict[str, Any]) -> str:
    text = (
        f"🌡️ *{title}*\n"
        f"• Температура: *{data['temperature']}°C*\n"
    )
    if data.get("humidity") is not None:
        text += f"• Влажность: *{data['humidity']}%*\n"
    text += f"\n_Обновлено: {format_display_time(data.get('updated_at'))}_"
    return text


def build_minmax_text(
    start_dt: datetime,
    end_dt: datetime,
    min_item: dict[str, Any],
    max_item: dict[str, Any],
    points_count: int,
) -> str:
    return (
        "📈 *Минимум и максимум температуры*\n"
        f"• Период: *{start_dt.strftime('%d.%m.%Y %H:%M')} - {end_dt.strftime('%d.%m.%Y %H:%M')}*\n"
        f"• Точек в выборке: *{points_count}*\n"
        f"• Минимум: *{min_item['temperature']}°C* в _{format_display_time(min_item.get('updated_at'))}_\n"
        f"• Максимум: *{max_item['temperature']}°C* в _{format_display_time(max_item.get('updated_at'))}_"
    )


def build_report_text(
    date_from: date,
    date_to: date,
    min_temp: float | None,
    max_temp: float | None,
    avg_temp: float | None,
    points_count: int,
    cold_duration_minutes: int,
    hot_duration_minutes: int,
) -> str:
    avg_text = f"{avg_temp:.2f}" if avg_temp is not None else "нет данных"
    min_text = f"{min_temp:.2f}" if min_temp is not None else "нет данных"
    max_text = f"{max_temp:.2f}" if max_temp is not None else "нет данных"
    cold_hours, cold_minutes = divmod(cold_duration_minutes, 60)
    hot_hours, hot_minutes = divmod(hot_duration_minutes, 60)

    return (
        "📋 *Отчет по температуре*\n"
        f"• Период: *{date_from.strftime('%d.%m.%Y')} - {date_to.strftime('%d.%m.%Y')}*\n"
        f"• Измерений: *{points_count}*\n"
        f"• Минимум: *{min_text}°C*\n"
        f"• Максимум: *{max_text}°C*\n"
        f"• Средняя: *{avg_text}°C*\n"
        f"• Ниже {ALERT_MIN_TEMP:.0f}°C: *{cold_hours} ч {cold_minutes:02d} мин*\n"
        f"• Выше {ALERT_MAX_TEMP:.0f}°C: *{hot_hours} ч {hot_minutes:02d} мин*"
    )


def resolve_report_dates(args: str | None) -> tuple[date, date]:
    today = datetime.now().astimezone().date()

    if not args:
        return today, today

    parts = args.split()
    if len(parts) == 1:
        report_date = parse_report_date(parts[0])
        return report_date, report_date
    if len(parts) == 2:
        first_date = parse_report_date(parts[0])
        second_date = parse_report_date(parts[1])
        return (first_date, second_date) if first_date <= second_date else (second_date, first_date)

    raise ValueError("invalid report args")


def calculate_critical_duration_minutes(points: list[dict[str, Any]], range_end: datetime) -> tuple[int, int]:
    cold_duration_seconds = 0.0
    hot_duration_seconds = 0.0

    for index, point in enumerate(points):
        point_time = point["updated_dt"]
        next_point_time = points[index + 1]["updated_dt"] if index + 1 < len(points) else range_end
        interval_seconds = max(0.0, (next_point_time - point_time).total_seconds())
        temperature = point["temperature"]

        if temperature < ALERT_MIN_TEMP:
            cold_duration_seconds += interval_seconds
        elif temperature > ALERT_MAX_TEMP:
            hot_duration_seconds += interval_seconds

    return round(cold_duration_seconds / 60), round(hot_duration_seconds / 60)


async def build_report_payload(args: str | None) -> dict[str, Any]:
    try:
        date_from, date_to = resolve_report_dates(args)
    except ValueError:
        raise ValueError(
            "Неверный формат даты.\n"
            f"Пример: {REPORT_USAGE}\n"
            "Можно указать одну дату или диапазон из двух дат."
        )

    if date_to - date_from > timedelta(days=180):
        raise ValueError("Слишком большой диапазон. Максимум 180 дней.")

    history = await get_history_data()
    local_timezone = datetime.now().astimezone().tzinfo
    range_start = datetime.combine(date_from, datetime.min.time(), tzinfo=local_timezone)
    range_end = datetime.combine(date_to + timedelta(days=1), datetime.min.time(), tzinfo=local_timezone)
    points: list[dict[str, Any]] = []

    for value in history.values():
        if not isinstance(value, dict):
            continue

        try:
            temperature = float(value["temperature"])
        except (KeyError, TypeError, ValueError):
            continue

        updated_at = value.get("updated_at")
        updated_dt = parse_iso_datetime(updated_at)
        if updated_dt is None:
            continue

        local_updated_dt = updated_dt.astimezone()
        if local_updated_dt < range_start or local_updated_dt >= range_end:
            continue

        points.append(
            {
                "temperature": temperature,
                "updated_at": updated_at,
                "updated_dt": local_updated_dt,
            }
        )

    points.sort(key=lambda item: item["updated_dt"])

    if not points:
        raise LookupError("За выбранный период нет данных для отчета.")

    temperatures = [point["temperature"] for point in points]
    avg_temp = sum(temperatures) / len(temperatures) if temperatures else None
    cold_duration_minutes, hot_duration_minutes = calculate_critical_duration_minutes(points, range_end)

    return {
        "date_from": date_from,
        "date_to": date_to,
        "min_temp": min(temperatures) if temperatures else None,
        "max_temp": max(temperatures) if temperatures else None,
        "avg_temp": avg_temp,
        "points_count": len(points),
        "cold_duration_minutes": cold_duration_minutes,
        "hot_duration_minutes": hot_duration_minutes,
    }


async def build_report_message(args: str | None) -> str:
    payload = await build_report_payload(args)
    return build_report_text(
        date_from=payload["date_from"],
        date_to=payload["date_to"],
        min_temp=payload["min_temp"],
        max_temp=payload["max_temp"],
        avg_temp=payload["avg_temp"],
        points_count=payload["points_count"],
        cold_duration_minutes=payload["cold_duration_minutes"],
        hot_duration_minutes=payload["hot_duration_minutes"],
    )


def get_pdf_font_name() -> str:
    font_name = "Helvetica"
    candidate_paths = [
        "C:\\Windows\\Fonts\\arial.ttf",
        "C:\\Windows\\Fonts\\verdana.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]

    for font_path in candidate_paths:
        if os.path.exists(font_path):
            try:
                pdfmetrics.registerFont(TTFont("TemperatureReportFont", font_path))
                return "TemperatureReportFont"
            except Exception:
                continue

    return font_name


def build_report_pdf_bytes(payload: dict[str, Any]) -> bytes:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    page_width, page_height = A4
    margin = 48
    line_height = 20
    current_y = page_height - margin
    font_name = get_pdf_font_name()

    def write_line(text: str, size: int = 12, gap_after: int = 0) -> None:
        nonlocal current_y

        if current_y <= margin:
            pdf.showPage()
            current_y = page_height - margin
            pdf.setFont(font_name, size)

        pdf.setFont(font_name, size)
        pdf.drawString(margin, current_y, text)
        current_y -= line_height + gap_after

    cold_hours, cold_minutes = divmod(payload["cold_duration_minutes"], 60)
    hot_hours, hot_minutes = divmod(payload["hot_duration_minutes"], 60)

    write_line("Temperature Report", size=18, gap_after=6)
    write_line(
        f"Period: {payload['date_from'].strftime('%d.%m.%Y')} - {payload['date_to'].strftime('%d.%m.%Y')}",
        gap_after=8,
    )
    write_line(f"Measurements: {payload['points_count']}")
    write_line(f"Minimum temperature: {payload['min_temp']:.2f} C")
    write_line(f"Maximum temperature: {payload['max_temp']:.2f} C")
    write_line(f"Average temperature: {payload['avg_temp']:.2f} C", gap_after=8)
    write_line(f"Below {ALERT_MIN_TEMP:.0f} C: {cold_hours} h {cold_minutes:02d} min")
    write_line(f"Above {ALERT_MAX_TEMP:.0f} C: {hot_hours} h {hot_minutes:02d} min", gap_after=8)
    write_line(f"Generated at: {datetime.now().astimezone().strftime('%d.%m.%Y %H:%M:%S')}")

    pdf.save()
    buffer.seek(0)
    return buffer.read()


active_chats = load_chats()
live_messages: dict[int, Message] = {}
last_alert_time = 0.0
last_seen_update_key: str | None = None

kb = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="Температура")],
        [KeyboardButton(text="Привет"), KeyboardButton(text="Помощь")],
        [KeyboardButton(text="Сайт")],
    ],
    resize_keyboard=True,
)

kb = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="Температура")],
        [KeyboardButton(text="Привет"), KeyboardButton(text="Помощь")],
        [KeyboardButton(text="/report")],
        [KeyboardButton(text="Сайт")],
    ],
    resize_keyboard=True,
)


async def ensure_chat_subscription(chat_id: int) -> None:
    if chat_id not in active_chats:
        active_chats.add(chat_id)
        save_chats(active_chats)


@dp.message(CommandStart())
async def start(message: Message):
    await ensure_chat_subscription(message.chat.id)
    await message.answer(
        "Привет! Я бот на aiogram.\n\n"
        "Я читаю последние данные датчика из Firebase Realtime Database и отправляю их в чат.\n\n"
        f"Кодовые слова: {', '.join(sorted(CODE_WORDS))}\n"
        f"Команда min/max: `{MINMAX_USAGE}`",
        reply_markup=kb,
        parse_mode="Markdown",
    )


@dp.message(Command("help"))
async def help_command(message: Message):
    await message.answer(
        "Команды:\n"
        "/start - запустить бота\n"
        "/help - показать помощь\n"
        "/status - показать последнее значение из Firebase\n"
        "/minmax <начало> <конец> - минимум и максимум за период\n"
        f"Пример: {MINMAX_USAGE}\n"
        "/subscribe - подписать чат на live-обновления\n"
        "/unsubscribe - отписать чат от live-обновлений\n"
        "/report - текстовый отчет по данным за сегодня\n"
        "/report [дата] или [начало конец] - текстовый отчет по данным за период\n"
        "/reportpdf — PDF-отчет документом\n"
        "/reportpdf [дата] или [начало конец] — PDF-отчет документом за период\n"
    )


@dp.message(Command("status"))
async def status_command(message: Message):
    data = await get_latest_data()
    if data and data.get("temperature") is not None:
        await message.answer(build_temperature_text("Последние данные из Firebase", data), parse_mode="Markdown")
        return

    await message.answer("В Firebase пока нет данных от ESP32.")


@dp.message(Command("minmax"))
async def minmax_command(message: Message, command: CommandObject):
    if not command.args:
        await message.answer(f"Нужен интервал.\nПример: {MINMAX_USAGE}")
        return

    parts = command.args.split()
    if len(parts) != 2:
        await message.answer(f"Укажи начало и конец периода.\nПример: {MINMAX_USAGE}")
        return

    try:
        start_dt = parse_local_datetime(parts[0])
        end_dt = parse_local_datetime(parts[1])
    except ValueError:
        await message.answer(f"Неверный формат даты.\nПример: {MINMAX_USAGE}")
        return

    if end_dt <= start_dt:
        await message.answer("Конец периода должен быть позже начала.")
        return

    history = await get_history_data()
    points: list[dict[str, Any]] = []

    for value in history.values():
        if not isinstance(value, dict):
            continue
        try:
            temperature = float(value["temperature"])
        except (KeyError, TypeError, ValueError):
            continue
        updated_at = value.get("updated_at")
        updated_dt = parse_iso_datetime(updated_at)
        if updated_dt is None:
            continue
        local_updated_dt = updated_dt.astimezone()
        if local_updated_dt < start_dt or local_updated_dt > end_dt:
            continue

        points.append(
            {
                "temperature": temperature,
                "updated_at": updated_at,
            }
        )

    if not points:
        await message.answer(
            "За этот период нет данных в истории Firebase.\n"
            "Для работы команды нужно сохранять архив измерений в отдельный путь истории."
        )
        return

    min_item = min(points, key=lambda item: item["temperature"])
    max_item = max(points, key=lambda item: item["temperature"])
    await message.answer(
        build_minmax_text(start_dt, end_dt, min_item, max_item, len(points)),
        parse_mode="Markdown",
    )


@dp.message(Command("report"))
async def report_command(message: Message, command: CommandObject):
    try:
        report_text = await build_report_message(command.args)
    except (ValueError, LookupError) as exc:
        await message.answer(str(exc))
        return

    await message.answer(report_text, parse_mode="Markdown")


@dp.message(Command("reportpdf"))
async def report_pdf_command(message: Message, command: CommandObject):
    try:
        payload = await build_report_payload(command.args)
    except (ValueError, LookupError) as exc:
        await message.answer(str(exc))
        return

    pdf_bytes = build_report_pdf_bytes(payload)
    filename = f"temperature-report-{payload['date_from'].isoformat()}-{payload['date_to'].isoformat()}.pdf"
    document = BufferedInputFile(pdf_bytes, filename=filename)
    caption = (
        f"Temperature report {payload['date_from'].strftime('%d.%m.%Y')} - "
        f"{payload['date_to'].strftime('%d.%m.%Y')}"
    )
    await message.answer_document(document=document, caption=caption)


@dp.message(Command("subscribe"))
async def subscribe_command(message: Message):
    await ensure_chat_subscription(message.chat.id)
    await message.answer("Чат подписан на live-обновления.")


@dp.message(Command("unsubscribe"))
async def unsubscribe_command(message: Message):
    active_chats.discard(message.chat.id)
    save_chats(active_chats)
    live_messages.pop(message.chat.id, None)
    await message.answer("Чат отписан от live-обновлений.")


@dp.message()
async def messages(message: Message):
    await ensure_chat_subscription(message.chat.id)

    if not message.text:
        return

    normalized = normalize_text(message.text)

    if message_has_code_word(message.text):
        data = await get_latest_data()
        if data and data.get("temperature") is not None:
            await message.answer(build_temperature_text("Кодовое слово принято", data), parse_mode="Markdown")
        else:
            await message.answer("Кодовое слово принято, но в Firebase пока нет данных.")
        return

    if normalized == "привет":
        await message.answer("И тебе привет 😄")
        return

    if normalized == "помощь":
        await help_command(message)
        return

    if normalized == "сайт":
        await message.answer("https://google.com")
        return

    if normalized == "температура":
        await status_command(message)


    if normalized in {"отчет", "/report"}:
        try:
            report_text = await build_report_message(None)
        except (ValueError, LookupError) as exc:
            await message.answer(str(exc))
            return

        await message.answer(report_text, parse_mode="Markdown")
        return


async def send_alerts_bg(alert_text: str) -> None:
    for chat_id in list(active_chats):
        try:
            await bot.send_message(chat_id=chat_id, text=alert_text, parse_mode="Markdown")
        except Exception as alert_err:
            print(f"Не удалось отправить алерт в чат {chat_id}: {alert_err}")


async def maybe_send_temperature_alert(data: dict[str, Any]) -> None:
    global last_alert_time

    try:
        temp_val = float(data["temperature"])
    except (KeyError, TypeError, ValueError):
        return

    if ALERT_MIN_TEMP <= temp_val <= ALERT_MAX_TEMP:
        return

    current_time = time.time()
    if current_time - last_alert_time < ALERT_COOLDOWN:
        return

    last_alert_time = current_time
    alert_text = (
        "🚨 *ВНИМАНИЕ! КРИТИЧЕСКАЯ ТЕМПЕРАТУРА!*\n\n"
        f"Текущее значение: *{temp_val}°C*\n"
    )
    if temp_val < ALERT_MIN_TEMP:
        alert_text += f"⚠️ Температура опустилась ниже нормы (*{ALERT_MIN_TEMP}°C*)!"
    else:
        alert_text += f"⚠️ Температура превысила норму (*{ALERT_MAX_TEMP}°C*)!"

    asyncio.create_task(send_alerts_bg(alert_text))


async def live_updater_loop():
    global last_seen_update_key

    print("Background live updater loop started")
    while True:
        try:
            data = await get_latest_data()
            if data and data.get("temperature") is not None:
                update_key = str(data.get("updated_at") or data.get("server_received_at") or "")
                if update_key and update_key != last_seen_update_key:
                    last_seen_update_key = update_key
                    live_text = build_temperature_text("Текущие показатели из Firebase (Live)", data)
                    await maybe_send_temperature_alert(data)

                    for chat_id in list(active_chats):
                        try:
                            if chat_id in live_messages:
                                msg = live_messages[chat_id]
                                try:
                                    await bot.edit_message_text(
                                        text=live_text,
                                        chat_id=chat_id,
                                        message_id=msg.message_id,
                                        parse_mode="Markdown",
                                    )
                                except Exception as edit_err:
                                    if "message is not modified" not in str(edit_err):
                                        new_msg = await bot.send_message(
                                            chat_id=chat_id,
                                            text=live_text,
                                            parse_mode="Markdown",
                                        )
                                        live_messages[chat_id] = new_msg
                            else:
                                new_msg = await bot.send_message(
                                    chat_id=chat_id,
                                    text=live_text,
                                    parse_mode="Markdown",
                                )
                                live_messages[chat_id] = new_msg
                        except Exception as send_err:
                            print(f"Не удалось отправить live-сообщение в чат {chat_id}: {send_err}")
                            if "Forbidden" in str(send_err) or "chat not found" in str(send_err):
                                active_chats.discard(chat_id)
                                save_chats(active_chats)
        except Exception as loop_err:
            print(f"Ошибка в фоновом обновлении: {loop_err}")

        await asyncio.sleep(5)


async def main():
    global http_session

    print("Bot is starting...")
    print(f"Firebase sensor path: {FIREBASE_SENSOR_PATH}")
    print(f"Firebase history path: {FIREBASE_HISTORY_PATH}")

    await bot.delete_webhook(drop_pending_updates=True)
    http_session = ClientSession()
    asyncio.create_task(live_updater_loop())

    try:
        await dp.start_polling(bot)
    finally:
        if http_session is not None:
            await http_session.close()


if __name__ == "__main__":
    asyncio.run(main())
