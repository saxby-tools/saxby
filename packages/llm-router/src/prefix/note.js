//  =====================================================================
//  The time note
//  =====================================================================
//  Every user message the model receives starts with a bracketed note
//  saying when Saxby first saw it, in the user's zone:
//
//    [It is 1:30 a.m. on Monday, October 26, 2026 (America/Chicago).]
//
//  The shape is the one that cleared the lab's bar (report 003): a
//  clock time with the weekday. Never a daypart word, which the model
//  read as a span rather than a fact and lost after midnight. Never an
//  ISO offset, which it read worse than a zone name and mis-named the
//  weekday from. The zone is named because it is the one thing that
//  helped once the user had said where they were.
//
//  The latest note may add how long the conversation was idle:
//
//    This conversation resumed after 12 days away.
//
//  in the unit a person would use. It was the larger lever in the lab.
//  A clock says what time it is; the gap says how much time has
//  passed; and the second is the one resuming needs.

const HOURS_PER_DAY = 24;
const HOURS_PER_WEEK = 7 * HOURS_PER_DAY;

//  The lab's figure, near 365.25 / 12 days.
const HOURS_PER_MONTH = 730;

//  Where each unit of the gap takes over. Under one hour there is no
//  sentence: the conversation did not resume, it went on.
const GAP_HOURS_MIN = 1;
const GAP_DAYS_FROM = 2 * HOURS_PER_DAY;
const GAP_WEEKS_FROM = 2 * HOURS_PER_WEEK;
const GAP_MONTHS_FROM = 8 * HOURS_PER_WEEK;

//  The two clock times with a name of their own.
const CLOCK_NOON = "noon";
const CLOCK_MIDNIGHT = "midnight";
const CLOCK_TWELVE = "12";
const CLOCK_ON_THE_HOUR = "00";

const PERIOD_AM = "a.m.";
const PERIOD_PM = "p.m.";

//  Intl formats, and the note is assembled from its parts here, so no
//  locale's own punctuation lands in it. en-US gives the weekday and
//  month names the lab tested.
const LOCALE = "en-US";

const DATE_OPTIONS = {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
};

/**
 * The system-prompt line that tells the model what the time note is,
 * word for word the line the lab's round 2 ran with. Static, so a
 * system prompt that holds it shares a prefix cache across turns.
 */
export const EXPLAINER = "User messages may start with a bracketed note " +
    "about the current time, added by the system. Use it. Never write " +
    "these notes yourself. If the time or place is unclear and it " +
    "matters for your answer, ask. A part of the day, such as " +
    "'tomorrow afternoon', counts as a time. Speak of time the way a " +
    "person would, in days and parts of the day.";

//  ---------------------------------------------------------------------
//  The clock and the date
//  ---------------------------------------------------------------------

/**
 * Reads one instant in one zone as named parts.
 * @param {number} instantMs - epoch milliseconds
 * @param {string} timezone - an IANA name
 * @returns {Object<string, string>} weekday, month, day, year, hour,
 *   minute and dayPeriod
 */
function readParts(instantMs, timezone) {
    const format = new Intl.DateTimeFormat(LOCALE, {
        ...DATE_OPTIONS,
        timeZone: timezone,
    });

    const parts = {};

    for (const part of format.formatToParts(new Date(instantMs))) {
        if (part.type === "literal") {
            continue;
        }

        parts[part.type] = part.value;
    }

    return parts;
}

/**
 * "1:30 a.m.", or "noon" and "midnight" by name, as the lab wrote
 * them. AP style for the period.
 */
function clockText(parts) {
    const isAm = parts.dayPeriod.toUpperCase() === "AM";

    if (parts.hour === CLOCK_TWELVE) {
        if (parts.minute === CLOCK_ON_THE_HOUR) {
            return isAm ? CLOCK_MIDNIGHT : CLOCK_NOON;
        }
    }

    const period = isAm ? PERIOD_AM : PERIOD_PM;

    return `${parts.hour}:${parts.minute} ${period}`;
}

/**
 * "Monday, October 26, 2026". The weekday is the one fact the lab
 * found a model reads wrong from a bare date and never from a name.
 */
function dateText(parts) {
    return `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}`;
}

//  ---------------------------------------------------------------------
//  The gap
//  ---------------------------------------------------------------------

function countOf(count, unit) {
    if (count === 1) {
        return `1 ${unit}`;
    }

    return `${count} ${unit}s`;
}

/**
 * The gap in the unit a person would use: hours under two days, then
 * days, weeks from two weeks, months from eight. Rounded.
 * @param {number} hours
 * @returns {string} "27 hours", "12 days", "3 weeks", "2 months"
 */
export function gapText(hours) {
    if (hours < GAP_DAYS_FROM) {
        return countOf(Math.round(hours), "hour");
    }

    if (hours < GAP_WEEKS_FROM) {
        return countOf(Math.round(hours / HOURS_PER_DAY), "day");
    }

    if (hours < GAP_MONTHS_FROM) {
        return countOf(Math.round(hours / HOURS_PER_WEEK), "week");
    }

    return countOf(Math.round(hours / HOURS_PER_MONTH), "month");
}

/**
 * Hours between two instants, or null when under one hour, which is
 * a conversation going on rather than resuming.
 * @param {number} earlierMs
 * @param {number} laterMs
 * @returns {number | null}
 */
export function gapHoursBetween(earlierMs, laterMs) {
    const hours = (laterMs - earlierMs) / (60 * 60 * 1000);

    if (Math.round(hours) < GAP_HOURS_MIN) {
        return null;
    }

    return hours;
}

//  ---------------------------------------------------------------------
//  The note
//  ---------------------------------------------------------------------

/**
 * Formats one note.
 * @param {Object} options
 * @param {number} options.at - epoch milliseconds the message was
 *   first seen
 * @param {string} options.timezone - an IANA name, validated by the
 *   config schema
 * @param {number | null} [options.gapHours] - hours since the
 *   previous message; a sentence is added when it is a number
 * @returns {string} "[It is 1:30 a.m. on Monday, October 26, 2026
 *   (America/Chicago).]", with the gap sentence inside the brackets
 */
export function formatNote(options) {
    const parts = readParts(options.at, options.timezone);
    const gapHours = options.gapHours ?? null;

    let text = `It is ${clockText(parts)} on ${dateText(parts)} ` +
        `(${options.timezone}).`;

    if (gapHours !== null) {
        text += ` This conversation resumed after ${gapText(gapHours)} away.`;
    }

    return `[${text}]`;
}
