export type PatchOperation =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

export class PatchError extends Error {}
export function getAt(document: unknown, pointer: string): unknown;
export function applyPatch<T>(input: T, operations: PatchOperation[]): T;
export function describePatch(document: unknown, operations: PatchOperation[]): (PatchOperation & { before: unknown })[];
