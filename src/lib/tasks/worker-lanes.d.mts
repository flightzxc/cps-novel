export type WorkerLane = "main" | "light";
export const MOBOREADER_UPSTREAM_TASK_TYPES: readonly string[];
export const APPROVED_LIGHT_TASK_TYPES: readonly string[];
export function parseWorkerLane(raw: string | undefined): WorkerLane;
export function assertWorkerLane(lane: WorkerLane, effective: readonly string[]): void;
export function parseTaskTypes(raw: string | undefined): string[];
export function validateWorkerLaneEnvironment(env: NodeJS.ProcessEnv): { main: string[]; light: string[]; mainId: string; lightId: string };
