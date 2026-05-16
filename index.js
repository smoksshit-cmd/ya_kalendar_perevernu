/**
 * RP Calendar v2.0.0
 * Архитектура по образцу Chronicle: системный промпт + парсинг тегов + агрегация по чату.
 */
import { getContext, extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '/script.js';

const EN = 'rp-calendar';
const VER = '2.0.0';

// ── Системный промпт для LLM ──
const SYS_PROMPT = `[RP Calendar — Time Tracking — STRICT FORMAT]
В САМОМ КОНЦЕ КАЖДОГО ответа ОБЯЗАТЕЛЬНО добавляй блок ТОЧНО в этом формате (без изменений, без перевода ключей, без префиксов "время:" и т.п.):

<datetime>
date:YYYY/M/D
time:HH:MM
weather:краткое описание с эмодзи
</datetime>

ПРИМЕР (правильно):
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

ПРАВИЛА ПРОДВИЖЕНИЯ ВРЕМЕНИ:
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

// ── Определить класс погодной анимации по строке погоды ──
function getWeatherClass(weather) {
    if (!weather) return '';
    const w = weather.toLowerCase();

    // Маркеры интенсивности
    const heavy = /сильн|обильн|густ|метел|вьюг|пург|ливен|шквал|heavy|blizzard|downpour/.test(w);

    // Гроза — проверяем первой
    if (/гроз|шторм|молни|thunder|storm/.test(w) || w.includes('⛈')) return 'storm';
    // Снег / метель
    if (/снег|метел|вьюг|снежн|пург|snow|blizzard/.test(w) || w.includes('❄') || w.includes('🌨')) {
        return heavy ? 'snow snow-heavy' : 'snow';
    }
    // Дождь / ливень / морось
    if (/дожд|ливен|морос|rain|drizzle/.test(w) || w.includes('🌧') || w.includes('🌦')) {
        return heavy ? 'rain rain-heavy' : 'rain';
    }
    // Туман / дымка
    if (/туман|дымк|мгла|fog|mist|haze/.test(w) || w.includes('🌫')) return 'fog';
    // Ветер
    if (/ветр|ветер|шквал|wind|gale/.test(w) || w.includes('🌬') || w.includes('🌪')) return 'wind';
    // Облачно / пасмурно
    if (/облач|пасмур|хмур|cloud|overcast/.test(w) || w.includes('☁') || w.includes('⛅')) return 'cloudy';
    // Солнечно / ясно
    if (/солнеч|ясн|sunny|clear/.test(w) || w.includes('☀') || w.includes('🌞')) return 'sunny';

    return '';
}

// ── Парсинг блока <datetime>...</datetime> или fallback ──
function hasDatetime(msg) {
    if (!msg) return false;
    if (/<datetime>[\s\S]*?<\/datetime>/i.test(msg)) return true;
    // Fallback: ищем "дата: YYYY/M/D" или "время: HH:MM" в тексте
    if (/(?:^|\s)(?:дата|date)\s*[:：]\s*\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}/i.test(msg)) return true;
    if (/(?:^|\s)(?:время|time)\s*[:：]\s*\d{1,2}[:.]\d{1,2}/i.test(msg)) return true;
    // Просто полная дата+время рядом
    if (/\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}[\s,]+\d{1,2}[:.]\d{1,2}/.test(msg)) return true;
    return false;
}

function parseDatetime(msg) {
    if (!msg) return null;
    const result = { date: '', time: '', weather: '' };

    // 1. Строгий блок <datetime>...</datetime>
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

    // 2. Fallback по ключам "дата:" / "время:" / "погода:" в тексте
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

    // 3. Совсем fallback: ищем "YYYY/M/D HH:MM" рядом
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

// ── Парсинг строки "YYYY/M/D" → Date ──
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

// ── Скрыть тег из отображения ──
function ensureRegex() {
    try {
        const ctx = getContext();
        const regex = ctx?.extensionSettings?.regex;
        if (!Array.isArray(regex)) return;
        const id = 'rpcal_hide_datetime';
        if (regex.some(r => r.id === id)) return;
        regex.push({
            id,
            scriptName: 'RP Calendar — hide <datetime>',
            findRegex: '/<datetime>[\\s\\S]*?<\\/datetime>/gim',
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
    } catch (e) {
        console.warn('[RP Calendar] ensureRegex failed:', e);
    }
}

// ── Агрегация: пробежать чат и взять последнее значение ──
let LS = { date: '', time: '', weather: '' };

function agg() {
    const chat = getContext()?.chat || [];
    const result = { date: S.startDate, time: S.startTime, weather: '' };
    for (let i = 0; i < chat.length; i++) {
        const meta = chat[i].rpcal_meta;
        if (!meta) continue;
        if (meta.date) result.date = meta.date;
        if (meta.time) result.time = meta.time;
        if (meta.weather) result.weather = meta.weather;
    }
    return result;
}

// ── Текущая дата как Date ──
function currentDate() {
    return parseDateStr(LS.date, LS.time) || new Date();
}

// ── События ──
function onMessage(idx) {
    if (!S.enabled) return;
    const chat = getContext()?.chat;
    if (!chat || idx < 0 || idx >= chat.length) return;
    const msg = chat[idx].mes;
    if (!hasDatetime(msg)) return;
    const parsed = parseDatetime(msg);
    if (parsed) {
        chat[idx].rpcal_meta = parsed;
        LS = agg();
        renderWidget();
        try { getContext().saveChat?.(); } catch (_) {}
    }
}

function onChatChanged(force) {
    if (!S.enabled) return;
    const chat = getContext()?.chat || [];
    for (let i = 0; i < chat.length; i++) {
        if ((force || !chat[i].rpcal_meta) && chat[i].mes && hasDatetime(chat[i].mes)) {
            const p = parseDatetime(chat[i].mes);
            if (p) chat[i].rpcal_meta = p;
        }
    }
    LS = agg();
    renderWidget();
}

function onPromptReady(ed) {
    if (!S.enabled || !S.injectPrompt) return;
    if (!ed?.chat) return;
    ed.chat.unshift({ role: 'system', content: SYS_PROMPT });
    // Также инжектим текущее состояние перед последним user-сообщением
    const ctx = `[RP Calendar — текущее время: ${LS.date} ${LS.time}${LS.weather ? ' | ' + LS.weather : ''}]`;
    let insertIdx = ed.chat.length - 1;
    for (let i = ed.chat.length - 1; i >= 0; i--) {
        if (ed.chat[i].role === 'user') { insertIdx = i; break; }
    }
    ed.chat.splice(insertIdx, 0, { role: 'system', content: ctx });
}

// ── UI ──
let cY = 2025, cM = 1; // Календарь для отображения

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
                <small>Время обновляется автоматически по тегу &lt;datetime&gt; в ответах LLM</small>
            </div>
        </div>
    `;
    holder.appendChild(wrap);

    const icon = document.getElementById('rpcal-icon');
    const widget = document.getElementById('rpcal-widget');

    icon.addEventListener('click', (e) => {
        e.stopPropagation();
        if (widget.style.display === 'none') {
            // Синхронизируем календарь с текущей датой
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

    renderWidget();
}

function renderWidget() {
    const d = currentDate();
    const season = getSeason(d.getMonth());

    const badge = document.getElementById('rpcal-icon-badge');
    if (badge) badge.textContent = String(d.getDate());

    const widget = document.getElementById('rpcal-widget');
    if (!widget) return;

    // Сезонный data-атрибут (для CSS-акцентов)
    widget.setAttribute('data-season', season.key);

    // Обновляем содержимое всегда
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

    // Анимация погоды — определяем класс
    if (elFx) {
        let wxClass = getWeatherClass(LS.weather);
        // Fallback: если погоды нет — берём дефолт по сезону
        if (!wxClass) {
            wxClass = season.key === 'winter' ? 'snow'
                   : season.key === 'autumn' ? 'cloudy'
                   : season.key === 'spring' ? 'cloudy'
                   : 'sunny';
        }
        elFx.className = 'rpcal-weather-fx ' + wxClass;

        // Очищаем старый flash-элемент и добавляем заново, если гроза
        const oldFlash = elFx.querySelector('.storm-flash');
        if (oldFlash) oldFlash.remove();
        if (wxClass.includes('storm')) {
            const flash = document.createElement('div');
            flash.className = 'storm-flash';
            elFx.appendChild(flash);
        }
    }

    // Синхронизируем календарь
    cY = d.getFullYear();
    cM = d.getMonth() + 1;
    renderCalendar();
}

function renderCalendar() {
    const titleEl = document.getElementById('rpcal-cal-title');
    const grid = document.getElementById('rpcal-grid');
    if (!grid || !titleEl) return;

    titleEl.textContent = `${MONTHS_NOM[cM - 1]} ${cY}`;

    const firstDay = new Date(cY, cM - 1, 1);
    const daysInMonth = new Date(cY, cM, 0).getDate();
    let startWeekday = firstDay.getDay() - 1; // Пн = 0
    if (startWeekday < 0) startWeekday = 6;

    const cur = currentDate();
    const isCurMonth = cur.getFullYear() === cY && (cur.getMonth() + 1) === cM;
    const curDay = isCurMonth ? cur.getDate() : -1;

    let html = '';
    for (const wd of WEEKDAYS_SHORT.slice(1).concat(WEEKDAYS_SHORT[0])) {
        html += `<div class="rpcal-grid-header">${wd}</div>`;
    }
    for (let i = 0; i < startWeekday; i++) {
        html += '<div class="rpcal-grid-day empty"></div>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const cls = d === curDay ? 'rpcal-grid-day current' : 'rpcal-grid-day';
        html += `<div class="${cls}">${d}</div>`;
    }
    grid.innerHTML = html;
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