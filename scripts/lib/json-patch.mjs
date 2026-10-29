// RFC 6902 JSON Patch (add, remove, replace, move, copy, test) applied to a
// deep copy; the input is never modified. Proposals describe their edit-plan
// changes this way, so every change is exact, displayable and reversible.

export class PatchError extends Error {}

const parsePointer = (pointer) => {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new PatchError(`"${pointer}" is not a JSON pointer (must start with /)`);
  return pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
};

const locate = (document, pointer) => {
  const parts = parsePointer(pointer);
  const key = parts.pop();
  let parent = document;
  for (const part of parts) {
    if (parent === null || typeof parent !== "object" || !(part in parent)) throw new PatchError(`${pointer}: "${part}" does not exist`);
    parent = parent[part];
  }
  if (parent === null || typeof parent !== "object") throw new PatchError(`${pointer}: parent is not an object or array`);
  return { parent, key };
};

const arrayIndex = (array, key, pointer, forAdd) => {
  if (forAdd && key === "-") return array.length;
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new PatchError(`${pointer}: "${key}" is not an array index`);
  const index = Number(key);
  if (index > array.length || (!forAdd && index === array.length)) throw new PatchError(`${pointer}: index ${index} is out of range (length ${array.length})`);
  return index;
};

export const getAt = (document, pointer) => {
  if (pointer === "") return document;
  const { parent, key } = locate(document, pointer);
  if (Array.isArray(parent)) return parent[arrayIndex(parent, key, pointer, false)];
  if (!(key in parent)) throw new PatchError(`${pointer} does not exist`);
  return parent[key];
};

const remove = (document, pointer) => {
  const { parent, key } = locate(document, pointer);
  if (Array.isArray(parent)) return parent.splice(arrayIndex(parent, key, pointer, false), 1)[0];
  if (!(key in parent)) throw new PatchError(`${pointer} does not exist`);
  const value = parent[key];
  delete parent[key];
  return value;
};

const add = (document, pointer, value) => {
  if (pointer === "") return value;
  const { parent, key } = locate(document, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, pointer, true), 0, value);
  else parent[key] = value;
  return document;
};

const clone = (value) => structuredClone(value);

export function applyPatch(input, operations) {
  if (!Array.isArray(operations)) throw new PatchError("changes must be an array of JSON Patch operations");
  let document = clone(input);
  operations.forEach((operation, index) => {
    const where = `changes[${index}] (${operation?.op} ${operation?.path})`;
    try {
      switch (operation.op) {
        case "add":
          document = add(document, operation.path, clone(operation.value));
          break;
        case "remove":
          remove(document, operation.path);
          break;
        case "replace":
          getAt(document, operation.path);
          if (operation.path === "") document = clone(operation.value);
          else {
            remove(document, operation.path);
            document = add(document, operation.path, clone(operation.value));
          }
          break;
        case "move": {
          const value = remove(document, operation.from);
          document = add(document, operation.path, value);
          break;
        }
        case "copy":
          document = add(document, operation.path, clone(getAt(document, operation.from)));
          break;
        case "test":
          if (JSON.stringify(getAt(document, operation.path)) !== JSON.stringify(operation.value)) throw new PatchError(`value differs from the expected ${JSON.stringify(operation.value)}`);
          break;
        default:
          throw new PatchError(`unknown op "${operation?.op}"`);
      }
    } catch (error) {
      throw new PatchError(`${where}: ${error.message}`);
    }
  });
  return document;
}

// Inverse operations for a patch, computed against the document it applies to.
// Used to show "before" values next to each change.
export function describePatch(document, operations) {
  return operations.map((operation) => {
    let before;
    try {
      before = operation.op === "add" && operation.path.endsWith("/-") ? undefined : getAt(document, operation.path);
    } catch {
      before = undefined;
    }
    return { ...operation, before };
  });
}
