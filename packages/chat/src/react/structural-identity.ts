/**
 * Identity stabilization for host-supplied prop OBJECTS (guuey#303 QA).
 *
 * Hosts write `<GuueyChat policy={{ view: { presentation: "chips" } }}>` —
 * a fresh object identity every render. Anything memo-keyed on that
 * identity would re-mint per render, and anything the re-mint feeds into a
 * `useEffect` → host `setState` edge becomes an infinite render loop (the
 * template's chat-rail shipped exactly that). Identity is not a contract
 * hosts signed up for; structure is.
 *
 * `useStructuralIdentity` returns the PREVIOUS reference while the new
 * value is structurally equal, so downstream memos see one identity per
 * structural value. Functions (and anything else non-plain) compare by
 * reference — a policy override carrying an inline closure (for example
 * `strings.humanizeTitle`) still churns; hoist such overrides.
 */
import { useRef } from "react";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => structurallyEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]))
    );
  }
  // Functions, class instances, Maps, … — reference identity only (already
  // handled by Object.is above).
  return false;
}

export function useStructuralIdentity<T>(value: T): T {
  const ref = useRef(value);
  if (!structurallyEqual(ref.current, value)) ref.current = value;
  return ref.current;
}
