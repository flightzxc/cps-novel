/**
 * 阅读器本地存储读写。
 *
 * 无账号体系，偏好**只在本设备生效**、不跨设备同步——这是 P1-11 的
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
