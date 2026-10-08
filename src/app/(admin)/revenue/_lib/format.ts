/**
 * `/revenue` 的数值展示。读服务把金额 / 比例都给成**十进制字符串**（`"28.8800"` / `"0.2827"`），
 * 展示时也只在字符串 / BigInt 上做取整，**不经过 `parseFloat` / `Number`**——浮点会让
 * `"0.1" + "0.2"` 这类合计在第 17 位出现噪声，更糟的是让四舍五入边界（`x.xx5`）随机偏向一侧。
 *
 * 取整规则是"四舍五入、远离零"（`28.8750 → 28.88`）。整数部分按千分位分组。
 * 入参为 null（读服务的"未同步"/"无从计算"）或不是合法十进制串 → 一律 `—`，绝不显示成 0。
 */

export const PLACEHOLDER = "—";

const DECIMAL_SHAPE = /^(-)?(\d+)(?:\.(\d+))?$/;

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 把十进制字符串 × 10^shift 后取整到 `digits` 位小数。
 * 例：`("0.2827", 2, 2) → "28.27"`；`("28.8750", 0, 2) → "28.88"`。
 */
function roundDecimalString(value: string, shift: number, digits: number): string | null {
  const match = DECIMAL_SHAPE.exec(value.trim());
  if (!match) return null;
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  const scaled = BigInt(`${match[2]}${fraction}`);
  // 小数点右移 shift 位后，有效小数位数 = 原小数位数 - shift。
  const scale = fraction.length - shift;

  let quotient: bigint;
  if (scale <= digits) {
    quotient = scaled * 10n ** BigInt(digits - scale);
  } else {
    const divisor = 10n ** BigInt(scale - digits);
    quotient = scaled / divisor;
    if ((scaled % divisor) * 2n >= divisor) quotient += 1n;
  }

  const padded = quotient.toString().padStart(digits + 1, "0");
  const integerPart = digits === 0 ? padded : padded.slice(0, -digits);
  const fractionPart = digits === 0 ? "" : `.${padded.slice(-digits)}`;
  const sign = negative && quotient !== 0n ? "-" : "";
  return `${sign}${groupThousands(integerPart)}${fractionPart}`;
}

/** 分成收入（US$）：两位小数，千分位。 */
export function formatUsd(value: string | null | undefined): string {
  if (value === null || value === undefined) return PLACEHOLDER;
  return roundDecimalString(value, 0, 2) ?? PLACEHOLDER;
}

/** 新用户比例：读服务给的是小数（`0.2827`），展示成百分比两位小数（`28.27%`）。 */
export function formatRatioPercent(value: string | null | undefined): string {
  if (value === null || value === undefined) return PLACEHOLDER;
  const percent = roundDecimalString(value, 2, 2);
  return percent === null ? PLACEHOLDER : `${percent}%`;
}

/** 日均激活用户：读服务已给两位小数的字符串，这里只补千分位。 */
export function formatAverage(value: string | null | undefined): string {
  if (value === null || value === undefined) return PLACEHOLDER;
  return roundDecimalString(value, 0, 2) ?? PLACEHOLDER;
}

/** 整数计数（激活用户 / 新用户）：千分位；null → `—`。 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return groupThousands(String(Math.trunc(value)));
}

/** 过长文本截断（错误信息）；完整内容由调用方放进 `title`。 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
