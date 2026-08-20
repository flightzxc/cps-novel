import type { Messages } from "./en";

/** Incomplete on purpose — D-7 still blocks this locale. loadMessages() must throw. */
const messages = {} satisfies Partial<Messages>;
export default messages;
