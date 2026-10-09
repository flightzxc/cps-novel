/**
 * 在回调执行期间接管进程级 `unhandledRejection`，把拒绝原因收进数组，结束后还原。
 *
 * 为什么需要：表单的 `onSubmit` 是 async 函数，React 丢弃它返回的 Promise。
 * 当它按设计把 NEXT_REDIRECT 原样重新抛出时，这个拒绝在 Node 看来就是
 * 「未处理的拒绝」，vitest 会把它记成整个测试运行的错误（退出码非 0）。
 * 「NEXT_REDIRECT 没被吞掉」恰恰要求它真的抛出来，所以测试必须自己接住并断言它。
 *
 * 只在回调期间摘掉 vitest 自己的监听器，并且一定在 finally 里装回去，
 * 不会影响同一文件里其它用例对真正未处理错误的上报。
 */
export async function captureUnhandledRejections<T>(
  run: (seen: unknown[]) => Promise<T>,
): Promise<T> {
  const seen: unknown[] = [];
  const original = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const collect = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", collect);
  try {
    return await run(seen);
  } finally {
    process.off("unhandledRejection", collect);
    for (const listener of original) process.on("unhandledRejection", listener);
  }
}

/** 形如 Next 的 `redirect()` 抛出的异常：digest 以 NEXT_REDIRECT 开头。 */
export function nextRedirectError(url: string): Error & { digest: string } {
  return Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
}
