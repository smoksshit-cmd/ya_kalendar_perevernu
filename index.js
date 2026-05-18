/**
 * RP Calendar v2.1.0
 * Архитектура по образцу Chronicle: системный промпт + парсинг тегов + агрегация по чату.
 * v2.1: + система событий (<events>...</events>) и вкладка "Предстоящие события".
 */
import { getContext, extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '/script.js';

const EN = 'rp-calendar';
const VER = '2.1.0';

// ── Системный промпт для LLM ──
const SYS_PROMPT = `[RP Calendar — Time & Events Tracking — STRICT FORMAT]
В САМОМ КОНЦЕ КАЖДОГО ответа ОБЯЗАТЕЛЬНО добавляй блок <datetime> ТОЧНО в этом формате:

<datetime>
date:YYYY/M/D
time:HH:MM
weather:краткое описание с эмодзи
</datetime>

ПРИМЕР:
<datetime>
date:2025/1/10
time:12:31
weather:☀️ Солнечно, прохладно
</datetime>

НЕЛЬЗЯ:
- писать "время: 2025/1/10" вместо блока <datetime>
- ставить блок в середине текста
- забывать закрывающий </datetime>
- менять имена полей (date/time/weather на русские)

═══════════════════════════════════════════════════════════
ПРЕДСТОЯЩИЕ СОБЫТИЯ (опционально, но ВАЖНО):
═══════════════════════════════════════════════════════════
Если персонаж планирует что-то сделать, упомянул о намерении, договорился о встрече, получил задание, обещал — ДОБАВЛЯЙ блок <events> ПОСЛЕ <datetime>:

<events>
add|Купить продукты в магазине|2025/1/11|18:00|обычное
add|Собрать вещи для похода|2025/1/12||важное
done|Купить продукты в магазине
remove|Старое неактуальное событие
</events>

ФОРМАТ строки события:
- add|название|дата|время|приоритет → добавить новое
- done|название → отметить выполненным
- remove|название → удалить (если отменено/неактуально)

ПОЛЯ:
- название: короткое, до 60 символов
- дата: YYYY/M/D (можно оставить пустым если "когда-нибудь")
- время: HH:MM (можно оставить пустым)
- приоритет: обычное | важное | срочное

ПРАВИЛА:
- Создавай событие, когда персонаж/игрок СКАЗАЛ о намерении ("надо сходить", "завтра встречусь", "потом сделаю").
- Помечай done, когда дело реально сделано в RP.
- Помечай remove, если планы изменились.
- Если событий нет — блок <events> можно НЕ добавлять.
- НЕ дублируй уже существующие события.

ПРИМЕР с событиями:
<datetime>
date:2025/1/10
time:14:00
weather:☁️ Пасмурно
</datetime>
<events>
add|Купить хлеб и молоко|2025/1/10|18:00|обычное
add|Встретиться с Анной у фонтана|2025/1/11|12:00|важное
</events>

═══════════════════════════════════════════════════════════
ПРАВИЛА ПРОДВИЖЕНИЯ ВРЕМЕНИ:
═══════════════════════════════════════════════════════════
- Если игрок указал конкретную дату/время — используй её точно.
- "Через несколько часов" → +2-4 часа. "На следующий день" → +1 день, 8:00.
- Погода меняется не чаще раза в 6-12 часов RP-времени.
- Сезоны: зима (дек-фев), весна (мар-май), лето (июн-авг), осень (сен-ноя).
- Эмодзи погоды: ☀️ 🌧️ ❄️ ☁️ 🌨️ ⛈️ 🌫️ 🌪️

Блок <datetime>...</datetime> в КАЖДОМ ответе. Это критично.`;

// ── Дефолтные настройки ──
const DEFAULTS = {
    enabled: true,
    injectPrompt: true,
    startDate: '2025/1/1',
    startTime: '08:00',
    // Список вручную удалённых событий (нормализованные названия)
    // чтобы LLM не воссоздал их случайно
    manuallyRemoved: [],
    // Ручные переопределения статуса событий: { normalizedTitle: 'done' | 'removed' }
    manualOverrides: {},
};

let S = {};
function loadS() {
    S = extension_settings[EN] ? { ...DEFAULTS, ...extension_settings[EN] } : { ...DEFAULTS };
    extension_settings[EN] = S;
}
function saveS() {
    extension_settings[EN] = S;
    saveSettingsDebounced();
}

// ── Константы ──
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const SEASONS = {
    winter: { key: 'winter', name: 'Зима', icon: '❄️', months: [11, 0, 1] },
    spring: { key: 'spring', name: 'Весна', icon: '🌸', months: [2, 3, 4] },
    summer: { key: 'summer', name: 'Лето', icon: '☀️', months: [5, 6, 7] },
    autumn: { key: 'autumn', name: 'Осень', icon: '🍂', months: [8, 9, 10] },
};

function getSeason(month) {
    for (const key of Object.keys(SEASONS)) {
        if (SEASONS[key].months.includes(month)) return SEASONS[key];
    }
    return SEASONS.winter;
}

// ── Нормализация названия для сравнения (защита от дублей) ──
function normalizeTitle(title) {
    if (!title) return '';
    return String(title)
        .toLowerCase()
        .replace(/[.,!?;:«»""''`()\[\]{}<>]/g, '') // убираем пунктуацию
        .replace(/\s+/g, ' ')                       // нормализуем пробелы
        .trim();
}

// ── Проверка сходства двух названий (защита от почти-дублей) ──
function titlesMatch(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    // Одно содержит другое (>= 70% длины)
    const shorter = na.length < nb.length ? na : nb;
    const longer = na.length < nb.length ? nb : na;
    if (shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.6) return true;
    return false;
}

// ── Класс погодной анимации ──
function getWeatherClass(weather) {
    if (!weather) return '';
    const w = weather.toLowerCase();
    const heavy = /сильн|обильн|густ|метел|вьюг|пург|ливен|шквал|heavy|blizzard|downpour/.test(w);
    if (/гроз|шторм|молни|thunder|storm/.test(w) || w.includes('⛈')) return 'storm';
    if (/снег|метел|вьюг|снежн|пург|snow|blizzard/.test(w) || w.includes('❄') || w.includes('🌨')) {
        return heavy ? 'snow snow-heavy' : 'snow';
    }
    if (/дожд|ливен|морос|rain|drizzle/.test(w) || w.includes('🌧') || w.includes('🌦')) {
        return heavy ? 'rain rain-heavy' : 'rain';
    }
    if (/туман|дымк|мгла|fog|mist|haze/.test(w) || w.includes('🌫')) return 'fog';
    if (/ветр|ветер|шквал|wind|gale/.test(w) || w.includes('🌬') || w.includes('🌪')) return 'wind';
    if (/облач|пасмур|хмур|cloud|overcast/.test(w) || w.includes('☁') || w.includes('⛅')) return 'cloudy';
    if (/солнеч|ясн|sunny|clear/.test(w) || w.includes('☀') || w.includes('🌞')) return 'sunny';
    return '';
}

// ── Проверка наличия datetime ──
function hasDatetime(msg) {
    if (!msg) return false;
    if (/<datetime>[\s\S]*?<\/datetime>/i.test(msg)) return true;
    if (/(?:^|\s)(?:дата|date)\s*[:：]\s*\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}/i.test(msg)) return true;
    if (/(?:^|\s)(?:время|time)\s*[:：]\s*\d{1,2}[:.]\d{1,2}/i.test(msg)) return true;
    if (/\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}[\s,]+\d{1,2}[:.]\d{1,2}/.test(msg)) return true;
    return false;
}

function parseDatetime(msg) {
    if (!msg) return null;
    const result = { date: '', time: '', weather: '' };

    const m = msg.match(/<datetime>([\s\S]*?)<\/datetime>/i);
    if (m) {
        const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx <= 0) continue;
            const k = line.substring(0, idx).trim().toLowerCase();
            const v = line.substring(idx + 1).trim();
            if (k === 'date' || k === 'дата') result.date = v;
            else if (k === 'time' || k === 'время') result.time = v;
            else if (k === 'weather' || k === 'погода') result.weather = v;
        }
    }

    if (!result.date) {
        const dm = msg.match(/(?:дата|date)\s*[:：]\s*(\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2})/i);
        if (dm) result.date = dm[1].replace(/[\-\.]/g, '/');
    }
    if (!result.time) {
        const tm = msg.match(/(?:время|time)\s*[:：]\s*(\d{1,2}[:.]\d{1,2})/i);
        if (tm) result.time = tm[1].replace('.', ':');
    }
    if (!result.weather) {
        const wm = msg.match(/(?:погода|weather)\s*[:：]\s*([^\n<>]+)/i);
        if (wm) result.weather = wm[1].trim().substring(0, 60);
    }

    if (!result.date || !result.time) {
        const both = msg.match(/(\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2})[\s,]+(\d{1,2}[:.]\d{1,2})/);
        if (both) {
            if (!result.date) result.date = both[1].replace(/[\-\.]/g, '/');
            if (!result.time) result.time = both[2].replace('.', ':');
        }
    }

    if (!result.date && !result.time) return null;
    return result;
}

// ── Парсинг блока <events> ──
// Возвращает массив операций: [{op:'add'|'done'|'remove', title, date, time, priority}]
function parseEvents(msg) {
    if (!msg) return [];
    const m = msg.match(/<events>([\s\S]*?)<\/events>/i);
    if (!m) return [];
    const ops = [];
    const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 2) continue;
        const op = parts[0].toLowerCase();
        if (op === 'add') {
            const title = parts[1];
            if (!title) continue;
            ops.push({
                op: 'add',
                title,
                date: parts[2] || '',
                time: parts[3] || '',
                priority: (parts[4] || 'обычное').toLowerCase(),
            });
        } else if (op === 'done' || op === 'complete' || op === 'completed') {
            ops.push({ op: 'done', title: parts[1] });
        } else if (op === 'remove' || op === 'delete' || op === 'cancel') {
            ops.push({ op: 'remove', title: parts[1] });
        }
    }
    return ops;
}

// ── Парсинг строки даты ──
function parseDateStr(dateStr, timeStr) {
    if (!dateStr) return null;
    const dm = dateStr.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!dm) return null;
    const y = +dm[1], mo = +dm[2], d = +dm[3];
    let h = 0, mi = 0;
    if (timeStr) {
        const tm = timeStr.match(/(\d{1,2}):(\d{1,2})/);
        if (tm) { h = +tm[1]; mi = +tm[2]; }
    }
    return new Date(y, mo - 1, d, h, mi);
}

// ── Скрыть теги из отображения ──
function ensureRegex() {
    try {
        const ctx = getContext();
        const regex = ctx?.extensionSettings?.regex;
        if (!Array.isArray(regex)) return;

        const items = [
            {
                id: 'rpcal_hide_datetime',
                scriptName: 'RP Calendar — hide <datetime>',
                findRegex: '/<datetime>[\\s\\S]*?<\\/datetime>/gim',
            },
            {
                id: 'rpcal_hide_events',
                scriptName: 'RP Calendar — hide <events>',
                findRegex: '/<events>[\\s\\S]*?<\\/events>/gim',
            },
        ];

        for (const it of items) {
            if (regex.some(r => r.id === it.id)) continue;
            regex.push({
                id: it.id,
                scriptName: it.scriptName,
                findRegex: it.findRegex,
                replaceString: '',
                trimStrings: [],
                placement: [2],
                disabled: false,
                markdownOnly: true,
                promptOnly: false,
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            });
        }
    } catch (e) {
        console.warn('[RP Calendar] ensureRegex failed:', e);
    }
}

// ── Агрегация: пробежать чат и собрать дату/время/события ──
let LS = { date: '', time: '', weather: '' };
let EVENTS = []; // [{id, title, date, time, priority, done, addedAt}]

function agg() {
    const chat = getContext()?.chat || [];
    const result = { date: S.startDate, time: S.startTime, weather: '' };
    const events = []; // Список текущих активных + выполненных
    const removedSet = new Set((S.manuallyRemoved || []).map(t => normalizeTitle(t)));
    const overrides = S.manualOverrides || {};

    for (let i = 0; i < chat.length; i++) {
        const meta = chat[i].rpcal_meta;
        if (meta) {
            if (meta.date) result.date = meta.date;
            if (meta.time) result.time = meta.time;
            if (meta.weather) result.weather = meta.weather;
        }
        const ops = chat[i].rpcal_events;
        if (Array.isArray(ops)) {
            const ctxDate = result.date;
            const ctxTime = result.time;
            for (const op of ops) {
                if (op.op === 'add') {
                    const title = (op.title || '').trim();
                    if (!title) continue;
                    const norm = normalizeTitle(title);
                    // Пропускаем, если пользователь его удалил вручную
                    if (removedSet.has(norm)) continue;
                    // Защита от дублей — ищем любое (включая done)
                    const dup = events.find(e => titlesMatch(e.title, title));
                    if (dup) {
                        // Если LLM пришлёт более полные данные — обновим
                        if (!dup.date && op.date) dup.date = op.date;
                        if (!dup.time && op.time) dup.time = op.time;
                        if (op.priority && op.priority !== 'обычное') dup.priority = op.priority;
                        continue;
                    }
                    events.push({
                        id: `${i}_${events.length}_${Date.now()}`,
                        title,
                        normTitle: norm,
                        date: op.date || '',
                        time: op.time || '',
                        priority: op.priority || 'обычное',
                        done: false,
                        addedAt: `${ctxDate} ${ctxTime}`,
                        msgIdx: i,
                    });
                } else if (op.op === 'done') {
                    const ev = events.find(e => titlesMatch(e.title, op.title) && !e.done);
                    if (ev) ev.done = true;
                } else if (op.op === 'remove') {
                    const idx = events.findIndex(e => titlesMatch(e.title, op.title));
                    if (idx >= 0) events.splice(idx, 1);
                }
            }
        }
    }

    // Применяем ручные переопределения
    for (const ev of events) {
        const ov = overrides[ev.normTitle || normalizeTitle(ev.title)];
        if (ov === 'done') ev.done = true;
    }

    EVENTS = events;
    return result;
}

// ── Текущая дата ──
function currentDate() {
    return parseDateStr(LS.date, LS.time) || new Date();
}

// ── Сравнение дат событий с текущей ──
function eventDateValue(ev) {
    const d = parseDateStr(ev.date, ev.time);
    if (d) return d.getTime();
    return Number.MAX_SAFE_INTEGER; // без даты — в конец
}
function getOverdueClass(ev) {
    if (ev.done) return 'done';
    const evD = parseDateStr(ev.date, ev.time);
    if (!evD) return '';
    const now = currentDate();
    if (evD.getTime() < now.getTime()) return 'overdue';
    const diffH = (evD.getTime() - now.getTime()) / 3600000;
    if (diffH < 24) return 'soon';
    return '';
}

// ── События чата ──
function onMessage(idx) {
    if (!S.enabled) return;
    const chat = getContext()?.chat;
    if (!chat || idx < 0 || idx >= chat.length) return;
    const msg = chat[idx].mes;
    let changed = false;

    if (hasDatetime(msg)) {
        const parsed = parseDatetime(msg);
        if (parsed) {
            chat[idx].rpcal_meta = parsed;
            changed = true;
        }
    }
    const ops = parseEvents(msg);
    if (ops.length > 0) {
        chat[idx].rpcal_events = ops;
        changed = true;
    }

    if (changed) {
        LS = agg();
        renderWidget();
        try { getContext().saveChat?.(); } catch (_) {}
    }
}

function onChatChanged(force) {
    if (!S.enabled) return;
    const chat = getContext()?.chat || [];
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].mes) continue;
        if ((force || !chat[i].rpcal_meta) && hasDatetime(chat[i].mes)) {
            const p = parseDatetime(chat[i].mes);
            if (p) chat[i].rpcal_meta = p;
        }
        if (force || !chat[i].rpcal_events) {
            const ops = parseEvents(chat[i].mes);
            if (ops.length > 0) chat[i].rpcal_events = ops;
        }
    }
    LS = agg();
    renderWidget();
}

function onPromptReady(ed) {
    if (!S.enabled || !S.injectPrompt) return;
    if (!ed?.chat) return;
    ed.chat.unshift({ role: 'system', content: SYS_PROMPT });

    // Инжектим текущее состояние + активные события + удалённые
    const activeEvents = EVENTS.filter(e => !e.done);
    let ctxStr = `[RP Calendar — текущее время: ${LS.date} ${LS.time}${LS.weather ? ' | ' + LS.weather : ''}]`;
    if (activeEvents.length > 0) {
        const lines = activeEvents.slice(0, 15).map(e => {
            const when = e.date ? `${e.date}${e.time ? ' ' + e.time : ''}` : 'когда-нибудь';
            return `• ${e.title} (${when}, ${e.priority})`;
        });
        ctxStr += `\n[RP Calendar — активные события персонажа (НЕ дублируй их!)]:\n${lines.join('\n')}`;
    }
    // Сообщаем LLM про удалённые игроком события — чтобы не воссоздавал
    if (Array.isArray(S.manuallyRemoved) && S.manuallyRemoved.length > 0) {
        const removed = S.manuallyRemoved.slice(-10);
        ctxStr += `\n[RP Calendar — отменённые игроком события, НЕ создавай их снова]:\n${removed.map(t => '• ' + t).join('\n')}`;
    }

    let insertIdx = ed.chat.length - 1;
    for (let i = ed.chat.length - 1; i >= 0; i--) {
        if (ed.chat[i].role === 'user') { insertIdx = i; break; }
    }
    ed.chat.splice(insertIdx, 0, { role: 'system', content: ctxStr });
}

// ── Ручные действия с событиями ──
function manualRemoveEvent(normTitle, title) {
    if (!normTitle) normTitle = normalizeTitle(title);
    if (!normTitle) return;
    if (!Array.isArray(S.manuallyRemoved)) S.manuallyRemoved = [];
    // Сохраняем оригинальное название (для отображения и для LLM)
    const original = title || normTitle;
    if (!S.manuallyRemoved.some(t => normalizeTitle(t) === normTitle)) {
        S.manuallyRemoved.push(original);
        // Лимит — храним последние 50
        if (S.manuallyRemoved.length > 50) {
            S.manuallyRemoved = S.manuallyRemoved.slice(-50);
        }
    }
    if (S.manualOverrides) delete S.manualOverrides[normTitle];
    saveS();
    LS = agg();
    renderWidget();
}

function manualToggleDone(normTitle, title) {
    if (!normTitle) normTitle = normalizeTitle(title);
    if (!normTitle) return;
    if (!S.manualOverrides) S.manualOverrides = {};
    const ev = EVENTS.find(e => (e.normTitle || normalizeTitle(e.title)) === normTitle);
    if (!ev) return;
    if (ev.done) {
        // Снимаем отметку
        delete S.manualOverrides[normTitle];
    } else {
        S.manualOverrides[normTitle] = 'done';
    }
    saveS();
    LS = agg();
    renderWidget();
}

function manualRestoreRemoved(title) {
    if (!Array.isArray(S.manuallyRemoved)) return;
    const norm = normalizeTitle(title);
    S.manuallyRemoved = S.manuallyRemoved.filter(t => normalizeTitle(t) !== norm);
    saveS();
    LS = agg();
    renderWidget();
}

// ── UI ──
let cY = 2025, cM = 1;
let currentTab = 'calendar'; // 'calendar' | 'events'

function createUI() {
    if (document.getElementById('rpcal-drawer')) return;

    const holder = document.getElementById('top-settings-holder');
    if (!holder) {
        setTimeout(createUI, 500);
        return;
    }

    const wrap = document.createElement('div');
    wrap.id = 'rpcal-drawer';
    wrap.className = 'rpcal-wrapper';
    wrap.innerHTML = `
        <div id="rpcal-icon" class="rpcal-icon" title="RP Calendar">
            <i class="fa-solid fa-calendar-days"></i>
            <span id="rpcal-icon-badge" class="rpcal-icon-badge">1</span>
        </div>
        <div id="rpcal-widget" class="rpcal-widget" data-season="winter" style="display:none;">
            <div class="rpcal-header">
                <div id="rpcal-weather-fx" class="rpcal-weather-fx"></div>
                <div id="rpcal-time" class="rpcal-time">08:00</div>
                <div id="rpcal-fulldate" class="rpcal-fulldate">1 января 2025</div>
                <div id="rpcal-weekday" class="rpcal-weekday">Среда</div>
            </div>
            <div class="rpcal-tabs">
                <button class="rpcal-tab active" data-tab="calendar">
                    <i class="fa-solid fa-calendar"></i> Календарь
                </button>
                <button class="rpcal-tab" data-tab="events">
                    <i class="fa-solid fa-list-check"></i> События
                    <span id="rpcal-events-badge" class="rpcal-tab-badge" style="display:none;">0</span>
                </button>
            </div>
            <div id="rpcal-tab-calendar" class="rpcal-tab-content active">
                <div class="rpcal-info">
                    <div class="rpcal-info-row">
                        <span class="rpcal-info-label">Сезон:</span>
                        <span id="rpcal-season" class="rpcal-info-value">❄️ Зима</span>
                    </div>
                    <div class="rpcal-info-row">
                        <span class="rpcal-info-label">Погода:</span>
                        <span id="rpcal-weather" class="rpcal-info-value">—</span>
                    </div>
                </div>
                <div class="rpcal-cal-nav">
                    <button id="rpcal-cal-prev" class="rpcal-btn"><i class="fa-solid fa-chevron-left"></i></button>
                    <span id="rpcal-cal-title">Январь 2025</span>
                    <button id="rpcal-cal-next" class="rpcal-btn"><i class="fa-solid fa-chevron-right"></i></button>
                </div>
                <div id="rpcal-grid" class="rpcal-grid"></div>
                <div class="rpcal-footer">
                    <small>Время обновляется автоматически по тегу &lt;datetime&gt;</small>
                </div>
            </div>
            <div id="rpcal-tab-events" class="rpcal-tab-content">
                <div class="rpcal-events-filters">
                    <button class="rpcal-filter active" data-filter="active">Активные</button>
                    <button class="rpcal-filter" data-filter="done">Выполненные</button>
                    <button class="rpcal-filter" data-filter="all">Все</button>
                </div>
                <div id="rpcal-events-list" class="rpcal-events-list"></div>
                <div class="rpcal-footer">
                    <small>События создаются LLM через тег &lt;events&gt;</small>
                </div>
            </div>
        </div>
    `;
    holder.appendChild(wrap);

    const icon = document.getElementById('rpcal-icon');
    const widget = document.getElementById('rpcal-widget');

    icon.addEventListener('click', (e) => {
        e.stopPropagation();
        if (widget.style.display === 'none') {
            const d = currentDate();
            cY = d.getFullYear();
            cM = d.getMonth() + 1;
            renderWidget();
            widget.style.display = 'block';
        } else {
            widget.style.display = 'none';
        }
    });

    document.addEventListener('click', (e) => {
        if (widget.style.display === 'none') return;
        let t = e.target;
        while (t && t !== document) {
            if (t.id === 'rpcal-drawer') return;
            t = t.parentElement;
        }
        widget.style.display = 'none';
    });

    document.getElementById('rpcal-cal-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        cM--;
        if (cM < 1) { cM = 12; cY--; }
        renderCalendar();
    });
    document.getElementById('rpcal-cal-next').addEventListener('click', (e) => {
        e.stopPropagation();
        cM++;
        if (cM > 12) { cM = 1; cY++; }
        renderCalendar();
    });

    // Переключение вкладок
    widget.querySelectorAll('.rpcal-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tab = btn.dataset.tab;
            currentTab = tab;
            widget.querySelectorAll('.rpcal-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
            widget.querySelectorAll('.rpcal-tab-content').forEach(c => {
                c.classList.toggle('active', c.id === `rpcal-tab-${tab}`);
            });
            if (tab === 'events') renderEvents();
        });
    });

    // Фильтры событий
    widget.querySelectorAll('.rpcal-filter').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            widget.querySelectorAll('.rpcal-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderEvents();
        });
    });

    renderWidget();
}

function renderWidget() {
    const d = currentDate();
    const season = getSeason(d.getMonth());

    const badge = document.getElementById('rpcal-icon-badge');
    if (badge) badge.textContent = String(d.getDate());

    const widget = document.getElementById('rpcal-widget');
    if (!widget) return;

    widget.setAttribute('data-season', season.key);

    const elTime = document.getElementById('rpcal-time');
    const elDate = document.getElementById('rpcal-fulldate');
    const elWday = document.getElementById('rpcal-weekday');
    const elSeason = document.getElementById('rpcal-season');
    const elWeather = document.getElementById('rpcal-weather');
    const elFx = document.getElementById('rpcal-weather-fx');

    if (elTime) elTime.textContent = LS.time || '—:—';
    if (elDate) elDate.textContent = `${d.getDate()} ${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`;
    if (elWday) elWday.textContent = WEEKDAYS[d.getDay()];
    if (elSeason) elSeason.textContent = `${season.icon} ${season.name}`;
    if (elWeather) elWeather.textContent = LS.weather || '—';

    if (elFx) {
        let wxClass = getWeatherClass(LS.weather);
        if (!wxClass) {
            wxClass = season.key === 'winter' ? 'snow'
                   : season.key === 'autumn' ? 'cloudy'
                   : season.key === 'spring' ? 'cloudy'
                   : 'sunny';
        }
        elFx.className = 'rpcal-weather-fx ' + wxClass;
        const oldFlash = elFx.querySelector('.storm-flash');
        if (oldFlash) oldFlash.remove();
        if (wxClass.includes('storm')) {
            const flash = document.createElement('div');
            flash.className = 'storm-flash';
            elFx.appendChild(flash);
        }
    }

    // Бэйдж событий
    const evBadge = document.getElementById('rpcal-events-badge');
    if (evBadge) {
        const activeCount = EVENTS.filter(e => !e.done).length;
        if (activeCount > 0) {
            evBadge.textContent = String(activeCount);
            evBadge.style.display = '';
        } else {
            evBadge.style.display = 'none';
        }
    }

    cY = d.getFullYear();
    cM = d.getMonth() + 1;
    renderCalendar();
    if (currentTab === 'events') renderEvents();
}

function renderCalendar() {
    const titleEl = document.getElementById('rpcal-cal-title');
    const grid = document.getElementById('rpcal-grid');
    if (!grid || !titleEl) return;

    titleEl.textContent = `${MONTHS_NOM[cM - 1]} ${cY}`;

    const firstDay = new Date(cY, cM - 1, 1);
    const daysInMonth = new Date(cY, cM, 0).getDate();
    let startWeekday = firstDay.getDay() - 1;
    if (startWeekday < 0) startWeekday = 6;

    const cur = currentDate();
    const isCurMonth = cur.getFullYear() === cY && (cur.getMonth() + 1) === cM;
    const curDay = isCurMonth ? cur.getDate() : -1;

    // Метки событий по дням
    const dayEvents = {};
    for (const ev of EVENTS) {
        if (ev.done) continue;
        const ed = parseDateStr(ev.date, ev.time);
        if (!ed) continue;
        if (ed.getFullYear() === cY && (ed.getMonth() + 1) === cM) {
            const dn = ed.getDate();
            dayEvents[dn] = (dayEvents[dn] || 0) + 1;
        }
    }

    let html = '';
    for (const wd of WEEKDAYS_SHORT.slice(1).concat(WEEKDAYS_SHORT[0])) {
        html += `<div class="rpcal-grid-header">${wd}</div>`;
    }
    for (let i = 0; i < startWeekday; i++) {
        html += '<div class="rpcal-grid-day empty"></div>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const classes = ['rpcal-grid-day'];
        if (d === curDay) classes.push('current');
        if (dayEvents[d]) classes.push('has-event');
        const dot = dayEvents[d] ? '<span class="rpcal-day-dot"></span>' : '';
        html += `<div class="${classes.join(' ')}">${d}${dot}</div>`;
    }
    grid.innerHTML = html;
}

function renderEvents() {
    const list = document.getElementById('rpcal-events-list');
    if (!list) return;

    const widget = document.getElementById('rpcal-widget');
    const activeFilter = widget?.querySelector('.rpcal-filter.active')?.dataset.filter || 'active';

    let items = [...EVENTS];
    if (activeFilter === 'active') items = items.filter(e => !e.done);
    else if (activeFilter === 'done') items = items.filter(e => e.done);

    // Сортировка: по дате (без даты в конец), невыполненные сначала
    items.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return eventDateValue(a) - eventDateValue(b);
    });

    if (items.length === 0) {
        list.innerHTML = `
            <div class="rpcal-events-empty">
                <i class="fa-solid fa-calendar-check"></i>
                <p>Нет событий</p>
                <small>События появятся, когда персонаж запланирует что-то</small>
            </div>
        `;
        return;
    }

    let html = '';
    for (const ev of items) {
        const overdue = getOverdueClass(ev);
        const prio = ev.priority || 'обычное';
        const whenStr = ev.date
            ? `${ev.date}${ev.time ? ' • ' + ev.time : ''}`
            : 'когда-нибудь';
        const prioIcon = prio === 'срочное' ? '🔴' : prio === 'важное' ? '🟡' : '🟢';
        const norm = ev.normTitle || normalizeTitle(ev.title);
        const doneIcon = ev.done ? 'fa-rotate-left' : 'fa-check';
        const doneTitle = ev.done ? 'Снять отметку «выполнено»' : 'Отметить выполненным';
        html += `
            <div class="rpcal-event ${overdue} prio-${prio}" data-norm="${escapeHtml(norm)}" data-title="${escapeHtml(ev.title)}">
                <div class="rpcal-event-prio">${prioIcon}</div>
                <div class="rpcal-event-body">
                    <div class="rpcal-event-title">${escapeHtml(ev.title)}</div>
                    <div class="rpcal-event-meta">
                        <span class="rpcal-event-when"><i class="fa-solid fa-clock"></i> ${escapeHtml(whenStr)}</span>
                        ${ev.done ? '<span class="rpcal-event-status done">✓ выполнено</span>' : ''}
                        ${overdue === 'overdue' && !ev.done ? '<span class="rpcal-event-status overdue">просрочено</span>' : ''}
                        ${overdue === 'soon' && !ev.done ? '<span class="rpcal-event-status soon">скоро</span>' : ''}
                    </div>
                </div>
                <div class="rpcal-event-actions">
                    <button class="rpcal-event-btn rpcal-ev-done" title="${doneTitle}">
                        <i class="fa-solid ${doneIcon}"></i>
                    </button>
                    <button class="rpcal-event-btn rpcal-ev-remove" title="Удалить (отменить)">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }
    list.innerHTML = html;

    // Привязываем обработчики
    list.querySelectorAll('.rpcal-event').forEach(card => {
        const norm = card.getAttribute('data-norm') || '';
        const title = card.getAttribute('data-title') || '';
        const btnDone = card.querySelector('.rpcal-ev-done');
        const btnRem = card.querySelector('.rpcal-ev-remove');
        if (btnDone) {
            btnDone.addEventListener('click', (e) => {
                e.stopPropagation();
                manualToggleDone(norm, title);
            });
        }
        if (btnRem) {
            btnRem.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Удалить событие «${title}»?\nLLM не будет создавать его снова.`)) {
                    manualRemoveEvent(norm, title);
                }
            });
        }
    });
}

function escapeHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Инициализация ──
jQuery(async () => {
    console.log(`[RP Calendar] Loading v${VER}...`);
    try {
        loadS();
        ensureRegex();
        createUI();

        if (event_types.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessage);
        }
        if (event_types.USER_MESSAGE_RENDERED) {
            eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessage);
        }
        if (event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, () => onChatChanged(false));
        }
        if (event_types.CHAT_COMPLETION_PROMPT_READY) {
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        }
        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, () => { LS = agg(); renderWidget(); });
        }
        if (event_types.MESSAGE_DELETED) {
            eventSource.on(event_types.MESSAGE_DELETED, () => { LS = agg(); renderWidget(); });
        }
        if (event_types.MESSAGE_EDITED) {
            eventSource.on(event_types.MESSAGE_EDITED, (idx) => onMessage(idx));
        }

        onChatChanged(false);
        console.log(`[RP Calendar] v${VER} loaded ✓`);
    } catch (err) {
        console.error('[RP Calendar] Init failed:', err);
    }
});