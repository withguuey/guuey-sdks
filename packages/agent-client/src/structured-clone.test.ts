import { describe, it, expect, afterEach } from "vitest";
import {
  DataCloneError,
  installStructuredClone,
  structuredCloneSubset as clone,
} from "./structured-clone.js";

const nativeClone = globalThis.structuredClone;

/** Both clones of `value` must have the same shape (vitest deep equality, types included). */
function expectSameAsNative(value: unknown): void {
  expect(clone(value)).toStrictEqual(nativeClone(value));
}

describe("installStructuredClone", () => {
  afterEach(() => {
    globalThis.structuredClone = nativeClone;
  });

  it("leaves a native structuredClone untouched (identity)", () => {
    expect(typeof nativeClone).toBe("function");
    expect(installStructuredClone()).toBe(false);
    expect(globalThis.structuredClone).toBe(nativeClone);
  });

  it("installs the clone only when the global is missing", () => {
    Reflect.deleteProperty(globalThis, "structuredClone");
    expect(installStructuredClone()).toBe(true);
    expect(Reflect.get(globalThis, "structuredClone")).toBe(clone);
    // Same property shape as the native global: writable, configurable, not enumerable.
    expect(Object.getOwnPropertyDescriptor(globalThis, "structuredClone")).toMatchObject({
      writable: true,
      configurable: true,
      enumerable: false,
    });
    // A second install is a no-op.
    expect(installStructuredClone()).toBe(false);
  });
});

describe("structuredCloneSubset: supported types", () => {
  it("primitives, including bigint, NaN and -0", () => {
    for (const v of ["s", 7, true, null, undefined, 10n, Number.NaN, Infinity]) {
      expect(clone(v)).toBe(v);
      expectSameAsNative(v);
    }
    expect(Object.is(clone(-0), -0)).toBe(true);
  });

  it("plain objects: deep copy, own enumerable string keys, symbol keys dropped", () => {
    const hidden = Symbol("hidden");
    const src = { a: { b: [1, { c: "d" }] }, u: undefined, [hidden]: 1 };
    Object.defineProperty(src, "secret", { value: 1, enumerable: false });
    const copy = clone(src);
    expect(copy).toEqual({ a: { b: [1, { c: "d" }] }, u: undefined });
    expect(copy.a).not.toBe(src.a);
    expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
    expect(Object.keys(copy)).toEqual(["a", "u"]);
    expectSameAsNative(src);
  });

  it("null-prototype objects become ordinary objects", () => {
    const bare: { [key: string]: number } = Object.create(null);
    bare.k = 1;
    const copy = clone(bare);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy).toEqual({ k: 1 });
    expectSameAsNative(bare);
  });

  it("an ordinary class instance becomes a plain object of its own data, as natively", () => {
    class Point {
      readonly tags = ["a"];
      constructor(
        readonly x: number,
        readonly nested: { y: number }
      ) {}
      get norm(): number {
        return this.x;
      }
    }
    const src = new Point(1, { y: 2 });
    const copy = clone(src);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy.nested).not.toBe(src.nested);
    expect("norm" in copy).toBe(false);
    expect(copy).toStrictEqual(nativeClone(src));
    expect(copy).toStrictEqual({ tags: ["a"], x: 1, nested: { y: 2 } });
    const arrayLike: object = Object.create(Array.prototype);
    expectSameAsNative(arrayLike);
  });

  it("arrays keep holes, length and extra own keys", () => {
    const src: number[] & { extra?: string } = [1, 2, 3, 4];
    delete src[1];
    src.length = 6;
    src.extra = "x";
    const copy = clone(src);
    expect(copy).toHaveLength(6);
    expect(1 in copy).toBe(false);
    expect(copy.extra).toBe("x");
    expectSameAsNative(src);
  });

  it("Date", () => {
    const src = new Date(1_700_000_000_000);
    const copy = clone(src);
    expect(copy).toBeInstanceOf(Date);
    expect(copy).not.toBe(src);
    expect(copy.getTime()).toBe(src.getTime());
    expectSameAsNative(src);
  });

  it("RegExp keeps source and flags, not lastIndex", () => {
    const src = /a+b/giy;
    src.lastIndex = 3;
    const copy = clone(src);
    expect(copy).not.toBe(src);
    expect(copy.source).toBe("a+b");
    expect(copy.flags).toBe("giy");
    expect(copy.lastIndex).toBe(0);
    expect(nativeClone(src).lastIndex).toBe(0);
    expectSameAsNative(src);
  });

  it("Map with deep-cloned keys and values", () => {
    const key = { k: 1 };
    const src = new Map<unknown, unknown>([
      [key, { v: [1] }],
      ["s", 2],
    ]);
    const copy = clone(src);
    expect(copy).toBeInstanceOf(Map);
    const [[copiedKey, copiedValue]] = copy;
    expect(copiedKey).toEqual(key);
    expect(copiedKey).not.toBe(key);
    expect(copiedValue).not.toBe(src.get(key));
    expectSameAsNative(src);
  });

  it("Set with deep-cloned values", () => {
    const member = { m: 1 };
    const src = new Set<unknown>([member, "x"]);
    const copy = clone(src);
    expect(copy).toBeInstanceOf(Set);
    expect(copy.size).toBe(2);
    expect(copy.has(member)).toBe(false);
    expectSameAsNative(src);
  });

  it("ArrayBuffer", () => {
    const src = new Uint8Array([1, 2, 3]).buffer;
    const copy = clone(src);
    expect(copy).not.toBe(src);
    expect([...new Uint8Array(copy)]).toEqual([1, 2, 3]);
    expectSameAsNative(src);
  });

  it("every typed array keeps byteOffset, length and contents over a cloned buffer", () => {
    const views = [
      new Int8Array([-1, 2]),
      new Uint8Array([1, 2]),
      new Uint8ClampedArray([1, 255]),
      new Int16Array([-300, 2]),
      new Uint16Array([300, 2]),
      new Int32Array([-70000, 2]),
      new Uint32Array([70000, 2]),
      new Float32Array([1.5, 2]),
      new Float64Array([Math.PI, 2]),
      new BigInt64Array([-1n, 2n]),
      new BigUint64Array([1n, 2n]),
    ];
    for (const src of views) {
      const copy = clone(src);
      expect(copy.constructor).toBe(src.constructor);
      expect(copy.buffer).not.toBe(src.buffer);
      expect(copy).toStrictEqual(src);
      expectSameAsNative(src);
    }
    const offset = new Uint16Array(new ArrayBuffer(16), 4, 3);
    offset.set([7, 8, 9]);
    const copy = clone(offset);
    expect([copy.byteOffset, copy.length, copy.buffer.byteLength]).toEqual([4, 3, 16]);
    expect([...copy]).toEqual([7, 8, 9]);
    expectSameAsNative(offset);
  });

  it("DataView keeps byteOffset and byteLength", () => {
    const src = new DataView(new ArrayBuffer(8), 2, 4);
    src.setInt16(0, -5);
    const copy = clone(src);
    expect(copy).toBeInstanceOf(DataView);
    expect(copy.buffer).not.toBe(src.buffer);
    expect([copy.byteOffset, copy.byteLength, copy.getInt16(0)]).toEqual([2, 4, -5]);
    expectSameAsNative(src);
  });

  it("views over one buffer keep sharing one cloned buffer", () => {
    const buffer = new ArrayBuffer(8);
    const src = { a: new Uint8Array(buffer), b: new DataView(buffer, 4), raw: buffer };
    const copy = clone(src);
    expect(copy.a.buffer).toBe(copy.b.buffer);
    expect(copy.raw).toBe(copy.a.buffer);
    expect(copy.raw).not.toBe(buffer);
    const native = nativeClone(src);
    expect(native.a.buffer).toBe(native.b.buffer);
  });

  it("Error and its standard subtypes keep name, message, stack and cause", () => {
    const types = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError];
    for (const ErrorType of types) {
      const src = new ErrorType("boom", { cause: { why: [1] } });
      const copy = clone(src);
      const native = nativeClone(src);
      for (const out of [copy, native]) {
        expect(Object.getPrototypeOf(out)).toBe(ErrorType.prototype);
        expect(out.name).toBe(src.name);
        expect(out.message).toBe("boom");
        expect(out.stack).toBe(src.stack);
        expect(out.cause).toEqual({ why: [1] });
        expect(out.cause).not.toBe(src.cause);
      }
      expect(Object.getOwnPropertyDescriptor(copy, "message")).toEqual(
        Object.getOwnPropertyDescriptor(native, "message")
      );
    }
  });

  it("an Error with a non-standard name becomes a plain Error, as natively", () => {
    class LocalError extends Error {
      override name = "LocalError";
    }
    const copy = clone(new LocalError("x"));
    const native = nativeClone(new LocalError("x"));
    expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
    expect(Object.getPrototypeOf(native)).toBe(Error.prototype);
    expect([copy.name, copy.message]).toEqual([native.name, native.message]);
    expect(Object.hasOwn(clone(new Error()), "message")).toBe(false);
  });

  it("boxed primitives", () => {
    const boxes: object[] = [new Boolean(false), new Number(-0), new String("s"), Object(5n)];
    for (const src of boxes) {
      const copy = clone(src);
      expect(copy).not.toBe(src);
      expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(src));
      expect(Object.is(copy.valueOf(), src.valueOf())).toBe(true);
      expectSameAsNative(src);
    }
  });
});

describe("structuredCloneSubset: graph shape", () => {
  it("a cycle resolves to the copy, not the source", () => {
    const src: { name: string; self?: object; list: object[] } = { name: "root", list: [] };
    src.self = src;
    src.list.push(src);
    const copy = clone(src);
    expect(copy).not.toBe(src);
    expect(copy.self).toBe(copy);
    expect(copy.list[0]).toBe(copy);
    expectSameAsNative(src);
  });

  it("cycles through Map, Set and Error cause", () => {
    const map = new Map<string, unknown>();
    map.set("me", map);
    const set = new Set<unknown>();
    set.add(set);
    const error = new Error("loop");
    error.cause = error;
    const copy = clone({ map, set, error });
    expect(copy.map.get("me")).toBe(copy.map);
    expect(copy.set.has(copy.set)).toBe(true);
    expect(copy.error.cause).toBe(copy.error);
  });

  it("a shared reference stays shared in the copy", () => {
    const shared = { v: 1 };
    const copy = clone({ a: shared, b: [shared], c: new Map([["k", shared]]) });
    expect(copy.a).not.toBe(shared);
    expect(copy.b[0]).toBe(copy.a);
    expect(copy.c.get("k")).toBe(copy.a);
    expectSameAsNative({ a: shared, b: [shared] });
  });
});

describe("structuredCloneSubset: refused values", () => {
  it("throws a DataCloneError for every value the native clone refuses", () => {
    const refused: unknown[] = [
      () => 1,
      Symbol("s"),
      Object(Symbol("boxed")),
      new WeakMap(),
      new WeakSet(),
      new WeakRef({}),
      new FinalizationRegistry(() => undefined),
      Promise.resolve(1),
      new URL("https://example.com/"),
      new MessageChannel().port1,
      { nested: [() => 1] },
      new Map([["fn", () => 1]]),
    ];
    for (const bad of refused) {
      expect(() => clone(bad)).toThrow(DataCloneError);
      expect(() => nativeClone(bad)).toThrow();
    }
  });

  it("refuses the host objects the native clone copies but script cannot", () => {
    const shared = new SharedArrayBuffer(8);
    const hostObjects: unknown[] = [
      new Blob(["x"]),
      new File(["x"], "f.txt"),
      shared,
      new Uint8Array(shared),
      new DataView(shared),
    ];
    for (const host of hostObjects) {
      expect(() => clone(host)).toThrow(DataCloneError);
    }
    expect(() => clone(new Blob(["x"]))).toThrow(/a Blob could not be cloned/);
    expect(() => clone(new URL("https://example.com/"))).toThrow(/a URL could not be cloned/);
  });

  it("the error carries the DataCloneError name", () => {
    const error = new DataCloneError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DataCloneError");
  });
});
