export function validateScheduledTaskSchedule(value) {
    if (value.type === "once") {
        return { type: "once", runAt: timestamp(value.runAt, "runAt") };
    }
    const minute = integer(value.minute, 0, 1439, "schedule minute");
    if (value.type === "daily")
        return { type: "daily", minute };
    if (value.type === "weekly") {
        if (!Array.isArray(value.weekdays) || value.weekdays.length === 0 || value.weekdays.length > 7) {
            throw new Error("weekly schedule requires 1-7 weekdays");
        }
        const weekdays = [...new Set(value.weekdays.map((day) => integer(day, 0, 6, "weekday")))].sort();
        return { type: "weekly", minute, weekdays };
    }
    throw new Error("Unsupported scheduled task schedule type");
}
export function nextScheduledTaskRun(schedule, timezoneOffsetMinutes, after) {
    const normalized = validateScheduledTaskSchedule(schedule);
    integer(timezoneOffsetMinutes, -14 * 60, 14 * 60, "timezoneOffsetMinutes");
    timestamp(after, "after");
    if (normalized.type === "once")
        return normalized.runAt > after ? normalized.runAt : null;
    const offsetMs = timezoneOffsetMinutes * 60_000;
    const dayMs = 24 * 60 * 60_000;
    const shiftedAfter = after + offsetMs;
    const localDayIndex = Math.floor(shiftedAfter / dayMs);
    for (let add = 0; add <= 8; add += 1) {
        const dayIndex = localDayIndex + add;
        const candidate = dayIndex * dayMs - offsetMs + normalized.minute * 60_000;
        if (candidate <= after)
            continue;
        if (normalized.type === "daily")
            return candidate;
        const weekday = new Date(dayIndex * dayMs).getUTCDay();
        if (normalized.weekdays.includes(weekday))
            return candidate;
    }
    return null;
}
export function scheduledTaskMinute(value) {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
    if (!match)
        throw new Error("localTime must use HH:mm");
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new Error("localTime must use a valid 24-hour HH:mm value");
    }
    return hour * 60 + minute;
}
function integer(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}
function timestamp(value, name) {
    if (!Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
        throw new Error(`${name} must be a positive Unix timestamp in milliseconds`);
    }
    return value;
}
//# sourceMappingURL=scheduled-task.js.map