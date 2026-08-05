/**
 * 阅读器本地存储读写。
 *
 * 无账号体系，偏好与阅读位置**只在本设备生效**、不跨设备同步——这是 P1-11 的
 * 预期行为（`docs/p1/P1_IMPLEMENTATION_ASSIGNMENT.md` 验收项 ⑥），不是缺陷。
 *
 * 三条纪律：
 *
 * 1. **永不抛异常。** localStorage 在两种常见情形下会直接抛：Safari 无痕模式写入、
 *    以及用户在浏览器设置里禁用了站点数据。阅读器的正文渲染不能因为「偏好存不下」
 *    而整页崩掉——存不下就退回默认值继续读。因此每个入口都是 try/catch + 兜底值。
 * 2. **读回一律过收敛层。** 存储里的内容是用户可编辑的，也可能是旧版本写的。
 *    `normalizeReaderSettings` 是唯一的信任边界，读回的东西不许绕过它直接用。
 * 3. **SSR 安全。** 这些函数会被客户端组件在模块顶层之外调用，但 Provider 的
 *    首次渲染发生在服务端，`window` 不存在。每个入口先探测再动手。
 */

import {
  DEFAULT_READER_SETTINGS,
  READER_SETTINGS_STORAGE_KEY,
  normalizeReaderSettings,
  type ReaderSettings,
} from "./reader-settings";

/**
 * 阅读位置的本地存储键。与偏好分开存，因为两者的生命周期完全不同：
 * 偏好是一份小对象、几乎不变；位置是随滚动高频更新的多章映射。
 */
export const READER_POSITION_STORAGE_KEY = "novel:reader-position:v1";

/**
 * 保留的阅读位置条数上限。
 *
 * 位置按 `novelKey:chapterNumber` 一章一条，不设上限的话，重度读者的存储会
 * 无界增长直到浏览器配额报错——而配额报错会连带打掉偏好的写入。超出时按写入
 * 时间丢最旧的：读者最可能回到的是最近读过的章节。
 */
export const READER_POSITION_MAX_ENTRIES = 200;

/** 一章的阅读位置。存段落锚点而不是像素——理由见 `useReadingPosition`。 */
export interface ReadingPosition {
  /** 视口顶部所在段落的下标。 */
  paragraphIndex: number;
  /** 视口顶部在该段落内部的高度占比，0～1。 */
  ratio: number;
  /** 写入时刻，仅用于超出上限时决定丢弃顺序。 */
  updatedAt: number;
}

type PositionMap = Record<string, ReadingPosition>;

/** 阅读位置的键：`novel + chapter` 粒度，就是验收项要求的那个粒度。 */
export function readingPositionKey(novelKey: string, chapterNumber: number): string {
  return `${novelKey}:${chapterNumber}`;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage;
  } catch {
    // 站点数据被禁用时，连读 window.localStorage 这个属性本身都会抛。
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const storage = safeLocalStorage();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch {
    // 损坏的 JSON、被手改过的值、配额异常——一律当作「没有存过」。
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const storage = safeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 写不进去就算了。阅读体验不因为存不下偏好而中断。
  }
}

/** 读回阅读偏好。没存过、存坏了、读不了，一律回默认值。 */
export function readReaderSettings(): ReaderSettings {
  const parsed = readJson<Partial<ReaderSettings>>(READER_SETTINGS_STORAGE_KEY);
  if (!parsed || typeof parsed !== "object") {
    return DEFAULT_READER_SETTINGS;
  }
  return normalizeReaderSettings(parsed);
}

/** 写入阅读偏好。 */
export function writeReaderSettings(settings: ReaderSettings): void {
  writeJson(READER_SETTINGS_STORAGE_KEY, settings);
}

function readPositionMap(): PositionMap {
  const parsed = readJson<PositionMap>(READER_POSITION_STORAGE_KEY);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

/** 读回某一章的阅读位置。形状不对就当没存过。 */
export function readReadingPosition(key: string): ReadingPosition | null {
  const entry = readPositionMap()[key];
  if (
    !entry ||
    typeof entry !== "object" ||
    !Number.isInteger(entry.paragraphIndex) ||
    entry.paragraphIndex < 0 ||
    typeof entry.ratio !== "number" ||
    !Number.isFinite(entry.ratio)
  ) {
    return null;
  }
  return {
    paragraphIndex: entry.paragraphIndex,
    ratio: Math.min(Math.max(entry.ratio, 0), 1),
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
  };
}

/** 写入某一章的阅读位置，并把总条数压回上限内。 */
export function writeReadingPosition(
  key: string,
  position: Omit<ReadingPosition, "updatedAt">,
): void {
  const map = readPositionMap();
  map[key] = { ...position, updatedAt: Date.now() };

  const keys = Object.keys(map);
  if (keys.length > READER_POSITION_MAX_ENTRIES) {
    // 按写入时间升序丢最旧的，直到回到上限。
    const ordered = keys.sort(
      (a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0),
    );
    for (const stale of ordered.slice(0, keys.length - READER_POSITION_MAX_ENTRIES)) {
      delete map[stale];
    }
  }

  writeJson(READER_POSITION_STORAGE_KEY, map);
}
