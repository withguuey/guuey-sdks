#!/usr/bin/env node
/**
 * Every publishable package states the Node floor its production dependencies
 * already impose.
 *
 * A dependency's `engines.node` reaches every consumer of the package that
 * pulls it in: npm warns below it, yarn classic refuses the install. When a
 * package declares no floor (or a lower one) while a dependency in its
 * production closure declares one, a consumer meets that floor with nothing on
 * our package saying so. This check makes the floor a stated fact: for each
 * publishable package it reads the production closure from pnpm itself
 * (`pnpm list --prod --depth Infinity`), takes the highest lower bound among
 * the dependencies' `engines.node`, and requires the package's own
 * `engines.node` lower bound to be at least that.
 *
 * A range the parser cannot read fails closed, naming the dependency: an
 * unread floor is not "no floor".
 *
 * What it measures: the closure as THIS workspace's lockfile resolves it. The
 * families guuey pins exactly resolve the same at a consumer's install, but a
 * third-party dependency in a caret range can resolve higher there, with a
 * higher floor. So the floor this check requires is a lower bound on the floor
 * a consumer meets, never more than it. Only required edges are measured:
 * dependencies and required peers, not optional dependencies or optional peers.
 *
 * Run after install: node scripts/check-engines-floor.mjs (pnpm check:engines-floor).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {[number, number, number]} Version */

const VERSION = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.-]+)?$/;

/** @param {string} token @returns {Version | null} */
function parseVersion(token) {
  const m = VERSION.exec(token);
  if (!m) return null;
  const part = (s) => (s === undefined || /^[xX*]$/.test(s) ? 0 : Number(s));
  if (/^[xX*]$/.test(m[1])) return [0, 0, 0];
  return [part(m[1]), part(m[2]), part(m[3])];
}

/** @param {Version} a @param {Version} b */
export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** @param {Version} v */
export function formatVersion(v) {
  return v.join(".");
}

/**
 * The lowest Node version a semver range admits.
 * @param {string | undefined} range
 * @returns {{ kind: "none" } | { kind: "floor", floor: Version } | { kind: "unparsed", range: string }}
 */
export function lowerBound(range) {
  if (range === undefined || range.trim() === "" || range.trim() === "*") return { kind: "none" };
  let lowest = null;
  for (const alternative of range.split("||")) {
    const alt = alternative.trim();
    if (alt === "" || alt === "*") return { kind: "none" };
    const hyphen = /^(\S+)\s+-\s+\S+$/.exec(alt);
    let bound = null;
    if (hyphen) {
      bound = parseVersion(hyphen[1]);
      if (bound === null) return { kind: "unparsed", range };
    } else {
      // comparators like ">= 22.12.0" may carry a space after the operator
      const tokens = alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/);
      let sawUpperOnly = true;
      for (const t of tokens) {
        const op = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(t);
        if (!op) return { kind: "unparsed", range };
        const v = parseVersion(op[2]);
        if (v === null) return { kind: "unparsed", range };
        if (op[1] === "<" || op[1] === "<=") continue;
        sawUpperOnly = false;
        if (bound === null || compareVersions(v, bound) > 0) bound = v;
      }
      if (sawUpperOnly) bound = [0, 0, 0];
    }
    if (lowest === null || compareVersions(bound, lowest) < 0) lowest = bound;
  }
  if (lowest === null) return { kind: "none" };
  return compareVersions(lowest, [0, 0, 0]) === 0 ? { kind: "none" } : { kind: "floor", floor: lowest };
}

/**
 * The dependencies in a `pnpm list --json` tree node, each manifest read once
 * by path.
 * - A recursive listing shows a workspace dependency as a `link:` with no
 *   subtree of its own, so `workspaceNode(path)` supplies that package's own
 *   listed node and its dependencies are walked too.
 * - pnpm prints a repeated subtree once and marks later occurrences deduped,
 *   so a path's subtree is walked at the first occurrence that carries one.
 * - Only a REQUIRED edge binds a floor, read off the parent's manifest: a
 *   `dependencies` entry, or a peer not marked optional (npm installs required
 *   peers). An `optionalDependencies` entry or an optional peer does not: a
 *   package manager skips an optional whose engines do not match rather than
 *   refusing the install, and npm never installs an optional peer for a
 *   consumer. A workspace can still have one installed (for its own use), so
 *   it is skipped here, not measured.
 * - An absent package on a binding edge is returned in `missing`.
 * @param {{ dependencies?: Record<string, { path?: string, dependencies?: object }> }} node
 * @param {(path: string) => ({ name?: string, version?: string, engines?: { node?: string }, optionalDependencies?: Record<string, string> } | null)} readManifest null when absent
 * @param {(path: string) => { dependencies?: object } | undefined} [workspaceNode]
 * @param {{ optionalDependencies?: Record<string, string> }} [rootManifest] the listed package's own manifest
 * @returns {{ manifests: Array<{ name?: string, version?: string, engines?: { node?: string } }>, missing: string[] }}
 */
export function closureManifests(node, readManifest, workspaceNode = () => undefined, rootManifest = {}) {
  const manifests = new Map();
  const walked = new Set();
  const missing = [];
  /** an optional edge (optionalDependencies, or a peer marked optional) binds no floor */
  const optionalEdge = (parent, name) =>
    parent?.dependencies?.[name] === undefined &&
    (parent?.optionalDependencies?.[name] !== undefined ||
      (parent?.peerDependencies?.[name] !== undefined && parent?.peerDependenciesMeta?.[name]?.optional === true));
  const walk = (deps, parent) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (!info.path) continue;
      if (optionalEdge(parent, name)) continue;
      if (!manifests.has(info.path)) {
        const m = readManifest(info.path);
        if (m === null) {
          missing.push(`${name} (${info.path})`);
          continue;
        }
        manifests.set(info.path, m);
      }
      const m = manifests.get(info.path);
      if (Object.keys(info.dependencies ?? {}).length > 0 && !walked.has(`${info.path}#tree`)) {
        walked.add(`${info.path}#tree`);
        walk(info.dependencies, m);
      }
      const ws = workspaceNode(info.path);
      if (ws && !walked.has(`${info.path}#ws`)) {
        walked.add(`${info.path}#ws`);
        walk(ws.dependencies, m);
      }
    }
  };
  walk(node.dependencies, rootManifest);
  return { manifests: [...manifests.values()], missing };
}

/**
 * @param {{ name?: string, engines?: { node?: string } }} pkg the package's own manifest
 * @param {Array<{ name?: string, version?: string, engines?: { node?: string } }>} closure
 * @returns {{ floor: Version | null, by: string | null, problems: string[] }}
 */
export function judgeEnginesFloor(pkg, closure) {
  const problems = [];
  let floor = null;
  let by = null;
  for (const dep of closure) {
    const lb = lowerBound(dep.engines?.node);
    if (lb.kind === "unparsed") {
      problems.push(`${pkg.name}: the dependency ${dep.name}@${dep.version} declares engines.node '${lb.range}', which this check cannot read — an unread floor is not "no floor".`);
      continue;
    }
    if (lb.kind === "floor" && (floor === null || compareVersions(lb.floor, floor) > 0)) {
      floor = lb.floor;
      by = `${dep.name}@${dep.version} (engines.node '${dep.engines.node}')`;
    }
  }
  if (floor !== null) {
    const own = lowerBound(pkg.engines?.node);
    if (own.kind === "unparsed") {
      problems.push(`${pkg.name} declares engines.node '${pkg.engines.node}', which this check cannot read.`);
    } else if (own.kind === "none" || compareVersions(own.floor, floor) < 0) {
      problems.push(
        `${pkg.name} states ${own.kind === "none" ? "no Node floor" : `a Node floor of ${formatVersion(own.floor)}`}, but its production closure imposes ${formatVersion(floor)}, set by ${by}. ` +
          `Declare "engines": { "node": ">=${formatVersion(floor)}" } (or higher).`
      );
    }
  }
  return { floor, by, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = new URL("../", import.meta.url).pathname;
  const packagesDir = join(root, "packages");
  const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
  const publishable = readdirSync(packagesDir)
    .filter((d) => statSync(join(packagesDir, d)).isDirectory())
    .map((d) => readJson(join(packagesDir, d, "package.json")))
    .filter((m) => m.private !== true);
  const listed = JSON.parse(
    // pnpm lists optional dependencies and installed peers under `dependencies`; closureManifests
    // classifies each edge from the parent's manifest and measures only the required ones
    execFileSync("pnpm", ["-r", "--filter", "./packages/*", "list", "--prod", "--depth", "Infinity", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
  );
  const byName = new Map(listed.map((n) => [n.name, n]));
  const byPath = new Map(listed.map((n) => [n.path, n]));
  const problems = [];
  const rows = [];
  for (const pkg of publishable) {
    const node = byName.get(pkg.name);
    if (!node) {
      problems.push(`${pkg.name}: pnpm list returned no tree for it — the closure was not measured (install first).`);
      continue;
    }
    const { manifests: closure, missing } = closureManifests(
      node,
      (p) => (existsSync(join(p, "package.json")) ? readJson(join(p, "package.json")) : null),
      (p) => byPath.get(p),
      pkg
    );
    for (const m of missing)
      problems.push(`${pkg.name}: pnpm lists ${m} in its production closure, but it is not installed and is not optional — the closure was not measured.`);
    const r = judgeEnginesFloor(pkg, closure);
    problems.push(...r.problems);
    rows.push(`${pkg.name}: ${closure.length} production dependencies, floor ${r.floor ? formatVersion(r.floor) : "none"}${r.by ? ` (${r.by})` : ""}, declares ${pkg.engines?.node ?? "none"}`);
  }
  if (rows.length === 0) problems.push("no publishable package was measured — the instrument did not fire.");
  if (problems.length > 0) {
    console.error("A publishable package does not state the Node floor its dependencies impose:\n");
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  for (const r of rows) console.log(r);
  console.log(`Engines floor stated: ${rows.length} publishable packages, each at or above its production closure.`);
}
