export const MIN_TRIM_SPAN = 0.1;

export function clampTrimRange(
  start: number,
  end: number,
  duration: number,
  minSpan = MIN_TRIM_SPAN,
) {
  const length = Number.isFinite(duration) ? Math.max(duration, 0) : 0;
  if (length < minSpan) {
    return { start: 0, end: length };
  }
  let nextStart = Number.isFinite(start) ? start : 0;
  let nextEnd = Number.isFinite(end) ? end : length;
  nextStart = Math.min(Math.max(nextStart, 0), length - minSpan);
  nextEnd = Math.min(Math.max(nextEnd, nextStart + minSpan), length);
  return { start: nextStart, end: nextEnd };
}

export function timeFromRatio(ratio: number, duration: number) {
  const length = Number.isFinite(duration) ? Math.max(duration, 0) : 0;
  const value = Number.isFinite(ratio) ? ratio : 0;
  return Math.min(Math.max(value, 0), 1) * length;
}

export function ratioFromTime(time: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const value = Number.isFinite(time) ? time : 0;
  return Math.min(Math.max(value / duration, 0), 1);
}

export function formatTimecode(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.round(seconds * 100);
  const cs = total % 100;
  const whole = Math.floor(total / 100);
  const s = whole % 60;
  const m = Math.floor(whole / 60);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function trimUnchanged(
  start: number,
  end: number,
  duration: number,
  epsilon = 0.04,
) {
  return start <= epsilon && duration - end <= epsilon;
}
