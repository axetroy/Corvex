/** 计划任务的 cron 解析与下次运行时间计算：严格 5 段 vixie-cron 子集，不引第三方依赖。 */

export interface CronSchedule {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

const fieldRanges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** 解析单个字段：支持星号、单值、星号加斜杠步长、区间、区间加步长、逗号列表；拒绝 L/W/?/名称别名与越界。 */
function parseField(raw: string, min: number, max: number): number[] | undefined {
  if (!raw || /[A-Za-z?]/.test(raw)) return undefined;
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (!part) return undefined;
    const slash = part.split("/");
    if (slash.length > 2) return undefined;
    const rangePart = slash[0]!;
    let step = 1;
    if (slash.length === 2) {
      if (!/^\d+$/.test(slash[1]!)) return undefined;
      step = Number(slash[1]!);
      if (step < 1 || step > max - min + 1) return undefined;
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (/^\d+$/.test(rangePart)) {
      start = Number(rangePart);
      end = slash.length === 2 ? max : start;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangePart);
      if (!match) return undefined;
      start = Number(match[1]);
      end = Number(match[2]);
    }
    if (start < min || end > max || start > end) return undefined;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** 解析 5 段 cron；非法返回 undefined。dayOfWeek 的 7 视作 0（周日）。 */
export function parseCron(expression: string): CronSchedule | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const parsed = fields.map((field, index) => parseField(field, fieldRanges[index]![0], fieldRanges[index]![1]));
  if (parsed.some((field) => field === undefined)) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [number[], number[], number[], number[], number[]];
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek: [...new Set(dayOfWeek.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b),
  };
}

function matches(schedule: CronSchedule, date: Date): boolean {
  // 用 UTC 字段计算；首版任务时区固定 UTC。
  return schedule.minute.includes(date.getUTCMinutes()) &&
    schedule.hour.includes(date.getUTCHours()) &&
    schedule.month.includes(date.getUTCMonth() + 1) &&
    // vixie-cron：dom 与 dow 都受限时任一匹配即可。
    ((schedule.dayOfMonth.includes(date.getUTCDate()) && schedule.dayOfWeek.length === 7) ||
      (schedule.dayOfWeek.includes(date.getUTCDay()) && schedule.dayOfMonth.length === 31) ||
      (schedule.dayOfMonth.includes(date.getUTCDate()) && schedule.dayOfWeek.includes(date.getUTCDay())));
}

/**
 * 计算严格晚于 after 的下一次触发时间（UTC，分钟粒度）。
 * 最多向前扫描 4 年，找不到返回 undefined（如 2 月 30 日）。
 */
export function nextRunAt(schedule: CronSchedule, after: Date): Date | undefined {
  const cursor = new Date(after);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = Date.UTC(cursor.getUTCFullYear() + 4, 0, 1);
  while (cursor.getTime() <= limit) {
    if (matches(schedule, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return undefined;
}

/** 相对"现在"的一次性任务时间解析：`in 45m`、`in 2h`、`in 1d`（相对），或 ISO 绝对时间。 */
export function parseRunAt(input: string, now: Date): Date | undefined {
  const relative = /^in\s+(\d+)\s*([smhd])$/i.exec(input.trim());
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
    const unit = relative[2]!.toLowerCase();
    const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + amount * factor);
  }
  const absolute = new Date(input.trim());
  return Number.isFinite(absolute.valueOf()) ? absolute : undefined;
}
