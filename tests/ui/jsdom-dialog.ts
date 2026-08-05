/**
 * jsdom 的 `<dialog>` 补丁。
 *
 * jsdom 26 有 `HTMLDialogElement`，但原型上只实现了反射属性 `open`——
 * `showModal()` / `show()` / `close()` 三个方法都不存在。`ConfirmDialog` 在
 * effect 里调 `showModal()`，未打补丁时会直接抛 TypeError，整棵树渲染失败。
 *
 * 🔴 这是**环境补丁，不是组件替身**：被测组件仍然是真的 `ConfirmDialog`，
 * 它真的去调平台 API。补丁按规范实现这三个方法的可观察行为（`open` 反射、
 * `close` 事件、`returnValue`），并把调用次数记下来，好让用例断言
 * "破坏性操作确实打开了模态对话框"，而不是假设它打开了。
 *
 * 不写进 `setup-cleanup.ts`，是为了只让用到 `<dialog>` 的用例受影响。
 */

type DialogCalls = {
  showModal: number;
  show: number;
  close: number;
};

const CALLS = new WeakMap<HTMLDialogElement, DialogCalls>();

function callsOf(dialog: HTMLDialogElement): DialogCalls {
  let entry = CALLS.get(dialog);
  if (!entry) {
    entry = { showModal: 0, show: 0, close: 0 };
    CALLS.set(dialog, entry);
  }
  return entry;
}

/** 该 dialog 上三个平台方法各被调了几次。用例据此断言组件真的走了平台模态。 */
export function dialogCalls(dialog: HTMLDialogElement): DialogCalls {
  return { ...callsOf(dialog) };
}

/**
 * Escape 关闭模态时浏览器先派发 `cancel`（可取消），未被 preventDefault 才继续
 * 关闭。`cancel` 按规范不冒泡，所以这里直接派到 dialog 上。
 */
export function fireDialogCancel(dialog: HTMLDialogElement): boolean {
  return dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true }));
}

export function installDialogShim(): void {
  const proto = globalThis.HTMLDialogElement?.prototype;
  if (!proto) return;
  if (typeof proto.showModal === "function") return;

  Object.defineProperties(proto, {
    showModal: {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        callsOf(this).showModal += 1;
        this.open = true;
      },
    },
    show: {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        callsOf(this).show += 1;
        this.open = true;
      },
    },
    close: {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement, returnValue?: string) {
        callsOf(this).close += 1;
        if (returnValue !== undefined) this.returnValue = returnValue;
        this.open = false;
        // 规范：close() 之后派发一个不冒泡、不可取消的 `close` 事件。
        this.dispatchEvent(new Event("close", { bubbles: false, cancelable: false }));
      },
    },
  });
}
