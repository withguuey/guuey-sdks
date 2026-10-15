/**
 * A `structuredClone` for runtimes that ship without one (Hermes on React
 * Native), installed on `globalThis` only when the global is missing. A
 * native implementation (browsers, Node, newer Hermes) is never replaced.
 *
 * `@silverprotocol/core` clones with the global `structuredClone` in its fold,
 * so this module is imported FIRST by every entry point of this package. The
 * global is visible to every library in the app, so the copy implements the
 * commonly used subset of the HTML structured clone algorithm faithfully:
 *   - primitives as they are (bigint, NaN and -0 included);
 *   - plain objects, null-prototype objects and instances of ordinary classes
 *     (the copy is a plain object with `Object.prototype`, own enumerable
 *     string keys only; symbol keys are dropped) and arrays (holes and length
 *     kept);
 *   - Date, RegExp (source and flags; `lastIndex` resets), Map and Set (keys
 *     and values cloned deeply);
 *   - ArrayBuffer, every typed array and DataView (the buffer is cloned with
 *     the same byteOffset and length; views over one buffer keep sharing one
 *     cloned buffer);
 *   - Error and its standard subtypes (name, message, a string stack, cause);
 *   - Boolean, Number, String and BigInt wrapper objects;
 *   - cycles and shared references, which keep their shape in the copy.
 * These throw a `DataCloneError`, as natively: functions, symbols (and Symbol
 * wrapper objects), WeakMap, WeakSet, WeakRef, FinalizationRegistry, Promise,
 * URL and MessagePort. Blob, File and SharedArrayBuffer (and views over one)
 * throw too: the native algorithm copies them, but script cannot, and a
 * refusal beats a corrupted copy. The `transfer` option is ignored.
 */

/** Thrown for a value the structured clone algorithm (or this subset) refuses. */
export class DataCloneError extends Error {
  override readonly name = "DataCloneError";
}

const TYPED_ARRAYS = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;

const ERROR_TYPES = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
} as const;

/**
 * Objects this copy can positively identify as ones it must not flatten into
 * a plain object: uncloneable ones, plus host objects (Blob, File,
 * SharedArrayBuffer) the native algorithm copies but script cannot. Looked up
 * on `globalThis`, so a runtime without one of these simply skips it.
 */
const UNCLONEABLE = [
  "Symbol",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Promise",
  "SharedArrayBuffer",
  "Blob",
  "File",
  "URL",
  "MessagePort",
] as const;

function isErrorName(name: unknown): name is keyof typeof ERROR_TYPES {
  return typeof name === "string" && Object.hasOwn(ERROR_TYPES, name);
}

function refuse(what: string): never {
  throw new DataCloneError(`structuredClone: ${what} could not be cloned`);
}

function cloneValue(value: unknown, memo: Map<object, object>): unknown {
  if (typeof value === "function") refuse("a function");
  if (typeof value === "symbol") refuse("a symbol");
  if (typeof value !== "object" || value === null) return value;
  return memo.get(value) ?? cloneObject(value, memo);
}

/** Records the copy BEFORE its children are cloned, so cycles resolve to it. */
function remember<T extends object>(source: object, copy: T, memo: Map<object, object>): T {
  memo.set(source, copy);
  return copy;
}

function copyOwnKeys(source: object, target: object, memo: Map<object, object>): void {
  for (const key of Object.keys(source)) {
    Reflect.set(target, key, cloneValue(Reflect.get(source, key), memo));
  }
}

function cloneObject(value: object, memo: Map<object, object>): object {
  if (Array.isArray(value)) {
    const out = remember(value, new Array<unknown>(value.length), memo);
    copyOwnKeys(value, out, memo);
    return out;
  }
  if (value instanceof Boolean) return remember(value, new Boolean(value.valueOf()), memo);
  if (value instanceof Number) return remember(value, new Number(value.valueOf()), memo);
  if (value instanceof String) return remember(value, new String(value.valueOf()), memo);
  if (value instanceof BigInt) {
    const boxed: object = Object(value.valueOf());
    return remember(value, boxed, memo);
  }
  if (value instanceof Date) return remember(value, new Date(value.getTime()), memo);
  if (value instanceof RegExp) return remember(value, new RegExp(value.source, value.flags), memo);
  if (value instanceof ArrayBuffer) return remember(value, value.slice(0), memo);
  if (ArrayBuffer.isView(value)) {
    const buffer = cloneValue(value.buffer, memo);
    if (!(buffer instanceof ArrayBuffer)) return refuse("a view over a shared buffer");
    if (value instanceof DataView) {
      return remember(value, new DataView(buffer, value.byteOffset, value.byteLength), memo);
    }
    const Typed = TYPED_ARRAYS.find((ctor) => value instanceof ctor);
    if (Typed === undefined) return refuse(`a ${Object.prototype.toString.call(value)}`);
    const length = value.byteLength / Typed.BYTES_PER_ELEMENT;
    return remember(value, new Typed(buffer, value.byteOffset, length), memo);
  }
  if (value instanceof Map) {
    const out = remember(value, new Map<unknown, unknown>(), memo);
    for (const [k, v] of value) out.set(cloneValue(k, memo), cloneValue(v, memo));
    return out;
  }
  if (value instanceof Set) {
    const out = remember(value, new Set<unknown>(), memo);
    for (const v of value) out.add(cloneValue(v, memo));
    return out;
  }
  if (value instanceof Error) return cloneError(value, memo);
  for (const name of UNCLONEABLE) {
    const ctor: unknown = Reflect.get(globalThis, name);
    if (typeof ctor === "function" && value instanceof ctor) refuse(`a ${name}`);
  }
  const out = remember(value, {}, memo);
  copyOwnKeys(value, out, memo);
  return out;
}

function cloneError(value: Error, memo: Map<object, object>): Error {
  const name: unknown = value.name;
  const out = remember(value, new ERROR_TYPES[isErrorName(name) ? name : "Error"](), memo);
  const define = (key: string, data: unknown) =>
    Object.defineProperty(out, key, { value: data, writable: true, configurable: true });
  const message = Object.getOwnPropertyDescriptor(value, "message");
  if (message !== undefined && "value" in message) define("message", String(message.value));
  if (typeof value.stack === "string") define("stack", value.stack);
  if (Object.hasOwn(value, "cause")) define("cause", cloneValue(value.cause, memo));
  return out;
}

/** Deep-copies `value` per the subset described in the module comment. */
export function structuredCloneSubset<T>(value: T): T;
export function structuredCloneSubset(value: unknown): unknown {
  return cloneValue(value, new Map<object, object>());
}

/**
 * Defines `globalThis.structuredClone` as {@link structuredCloneSubset} when
 * the runtime has none. Returns `true` when it installed, `false` when a
 * native implementation was already present (and left untouched).
 */
export function installStructuredClone(): boolean {
  if (typeof Reflect.get(globalThis, "structuredClone") === "function") return false;
  Object.defineProperty(globalThis, "structuredClone", {
    value: structuredCloneSubset,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return true;
}

installStructuredClone();
