/**
 * Small date helpers. Every "which day / which month is it?" question is
 * answered in the OFFICE's timezone, because 00:30 on 1 December in
 * Bengaluru is still 30 November in UTC.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The calendar date in a timezone, as 'YYYY-MM-DD' (sortable as a string). */
export function localDate(date, timeZone) {
  // The 'en-CA' locale formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The month in a timezone, as 'YYYY-MM'. */
export function monthKey(date, timeZone) {
  return localDate(date, timeZone).slice(0, 7);
}

export function addHours(date, hours) {
  return new Date(date.getTime() + hours * HOUR_MS);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

export function hoursBetween(start, end) {
  return (end.getTime() - start.getTime()) / HOUR_MS;
}
