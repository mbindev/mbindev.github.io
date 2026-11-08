#!/usr/bin/env node
const ENGINE_VERSION = '2.2.3';
/**
 * DevTrie Native Build & Cache Engine v2
 * Zero-dependency, agent-aware monorepo task orchestrator and distributed cache runner.
 *
 * Fixes over v1:
 *   1. Discovers projects from both package.json AND project.json (catches backup-manager, devcore-sdk, subagent-dashboard)
 *   2. Topological execution order via Kahn's algorithm
 *   3. Content-based hashing via git (portable across machines)
 *   4. Actual S3 remote cache (MinIO HTTP GET/PUT)
 *   5. Input filtering (exclude test files from build cache)
 *   6. implicitDependencies from project.json
 *
 * v2.2.0 (DEVTRIE-0100) — native workspace parity for `affected`:
 *   7. Workspace-aware base resolution mirroring devtrie-lock-guard.js v2:
 *      prefer the governed `canonical` remote (gitd) over `origin` (which may
 *      be GitHub in some checkouts), best-effort refresh of the main ref,
 *      then fail-closed guidance for single-branch workspace clones. The old
 *      silent single-commit fallback diffed ONLY the last commit — on a
 *      multi-commit lock branch it silently under-reported the affected set,
 *      so a locally green run did not predict the merge gate's full affected
 *      CI. That fail-open fallback is removed: parity failures are loud.
 *
 * v2.2.2 (DEVTRIE-0253) — npm-workspaces gate parity:
 *   9. Spawned project scripts resolve CLIs from BOTH the per-project
 *      node_modules/.bin and the workspace-root node_modules/.bin, matching
 *      what npm run provides. npm workspaces hoist app CLIs (prisma, next,
 *      eslint) to the root, so the old project-only PATH failed every
 *      npm-workspaces candidate with 'sh: 1: prisma: not found' (exit 127)
 *      at the native merge gate.
 *  10. ensureProjectDeps detects workspace membership (root package.json
 *      workspaces field) and repairs at the level that owns the layout:
 *      `npm ci/install` inside a workspace member redirects to the root and
 *      never creates a per-project .bin, so the skip check now requires a
 *      resolvable .bin at either level and the install runs once per
 *      install location (workspace root for members), not once per project.
 *
 * v2.2.1 (DEVTRIE-0252) — Windows affected parity:
 *   8. Project roots and git diff paths are normalized to POSIX separators
 *      before every affected/consumer comparison. On Windows hosts
 *      path.relative() yields backslash roots ('apps\DevTrie') while git
 *      always reports forward-slash paths, so calculateAffected matched
 *      nothing and reported zero affected projects for committed app
 *      changes. checkDependencies' packages/libs classification had the
 *      same separator blindness. Zero directly-affected non-blast changes
 *      now also log a notice naming the unmatched files so a suspicious
 *      empty result is diagnosable instead of silently "100% clean".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

function assertSafeGitRef(value, label) {
  const v = String(value == null ? '' : value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^{}-]*$/.test(v)) {
    throw new Error(`${label || 'git ref'} is not a valid git ref or SHA`);
  }
  return v;
}

// DEVTRIE-0252: git always reports forward-slash paths, but path.relative()
// and path.join() yield platform separators (backslashes on Windows). Every
// comparison between a git-reported path and a locally derived path must go
// through this normalization or the two sides never match on Windows hosts.
function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}
const http = require('http');

const ROOT_DIR = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT_DIR, '.devtrie', 'cache');

// S3 & Coordinator Config
const S3_ENDPOINT = process.env.DEVTRIE_S3_ENDPOINT || 'http://10.5.0.180:9000';
const S3_BUCKET = process.env.DEVTRIE_S3_BUCKET || 'nx-cache';
const S3_ACCESS_KEY = process.env.DEVTRIE_S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || '';
const S3_SECRET_KEY = process.env.DEVTRIE_S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';

// Test file patterns to exclude from build cache inputs
const TEST_PATTERNS = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /\/__tests__\//];

// -----------------------------------------------------------------------------
// 1. PROJECT DISCOVERY (package.json + project.json + nested scan)
// -----------------------------------------------------------------------------
function discoverProjects() {
  const projects = new Map();

  /**
   * Register a project found via package.json
   */
  function registerFromPackageJson(projDir, type) {
    const pkgJsonPath = path.join(projDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const name = pkg.name || path.basename(projDir);
      if (projects.has(name)) return name; // already registered

      const projJsonPath = path.join(projDir, 'project.json');
      let implicitDeps = [];
      let targets = {};
      let requiredTargets = [];
      let aliases = [path.basename(projDir)];
      if (fs.existsSync(projJsonPath)) {
        try {
          const pj = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
          implicitDeps = pj.implicitDependencies || [];
          targets = extractTargetCommands(pj.targets || {});
          if (Array.isArray(pj.requiredTargets)) {
            requiredTargets = pj.requiredTargets;
          }
          if (pj.name) aliases.push(pj.name);
        } catch {}
      }
      if (Array.isArray(pkg.requiredTargets)) {
        requiredTargets = [...new Set([...requiredTargets, ...pkg.requiredTargets])];
      }

      projects.set(name, {
        name,
        dirName: path.basename(projDir),
        aliases: [...new Set(aliases.filter(a => a && a !== name))],
        type,
        root: toPosix(path.relative(ROOT_DIR, projDir)),
        absPath: projDir,
        packageJson: pkg,
        dependencies: new Set(),
        dependents: new Set(),
        implicitDependencies: implicitDeps,
        requiredTargets,
        scripts: { ...(pkg.scripts || {}), ...targets },
        discoveredVia: 'package.json',
      });
      return name;
    } catch {
      return null;
    }
  }

  /**
   * Register a project found only via project.json (no package.json, e.g. Python apps)
   */
  function registerFromProjectJson(projDir) {
    const projJsonPath = path.join(projDir, 'project.json');
    if (!fs.existsSync(projJsonPath)) return null;
    try {
      const pj = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
      const name = pj.name || path.basename(projDir);
      if (projects.has(name)) return name;

      const targets = extractTargetCommands(pj.targets || {});
      const requiredTargets = Array.isArray(pj.requiredTargets) ? pj.requiredTargets : [];

      projects.set(name, {
        name,
        dirName: path.basename(projDir),
        aliases: [path.basename(projDir)].filter(a => a !== name),
        type: pj.projectType === 'library' ? 'lib' : 'app',
        root: toPosix(path.relative(ROOT_DIR, projDir)),
        absPath: projDir,
        packageJson: {},
        dependencies: new Set(),
        dependents: new Set(),
        implicitDependencies: pj.implicitDependencies || [],
        requiredTargets,
        scripts: targets,
        discoveredVia: 'project.json',
      });
      return name;
    } catch {
      return null;
    }
  }

  /**
   * Extract runnable commands from project.json targets
   * Converts { "build": { "executor": "nx:run-commands", "options": { "command": "npm run build" } } }
   * into { "build": "npm run build" }
   */
  function extractTargetCommands(targets) {
    const scripts = {};
    for (const [targetName, config] of Object.entries(targets)) {
      if (config && config.options && config.options.command) {
        scripts[targetName] = config.options.command;
      }
    }
    return scripts;
  }

  /**
   * Scan a directory for projects (direct children only)
   */
  function scanDir(baseDir, type) {
    if (!fs.existsSync(baseDir)) return;
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projDir = path.join(baseDir, entry.name);

      // Try package.json first, then project.json
      const registered = registerFromPackageJson(projDir, type);
      if (!registered) {
        registerFromProjectJson(projDir);
      }
    }
  }

  /**
   * Scan for nested packages within an app directory
   * (e.g. apps/devcore-platform/packages/SubAgent-DASH/)
   */
  function scanNestedPackages(baseDir) {
    const packagesDir = path.join(baseDir, 'packages');
    if (!fs.existsSync(packagesDir)) return;
    const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nestedDir = path.join(packagesDir, entry.name);
      // Only register if it has a project.json (Nx-recognized nested project)
      const projJsonPath = path.join(nestedDir, 'project.json');
      if (fs.existsSync(projJsonPath)) {
        const registered = registerFromPackageJson(nestedDir, 'app');
        if (!registered) {
          registerFromProjectJson(nestedDir);
        }
      }
    }
  }

  /**
   * Scan for SDK-style projects where package.json is nested deeper
   * (e.g. packages/devcore-sdk has project.json at root but package.json at clients/node/)
   */
  function scanDeepPackages(baseDir) {
    if (!fs.existsSync(baseDir)) return;
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projDir = path.join(baseDir, entry.name);
      const projJsonPath = path.join(projDir, 'project.json');
      // If project.json exists but no package.json, register via project.json
      if (fs.existsSync(projJsonPath) && !fs.existsSync(path.join(projDir, 'package.json'))) {
        registerFromProjectJson(projDir);
      }
    }
  }

  // Primary scan: apps/ and packages/
  scanDir(path.join(ROOT_DIR, 'apps'), 'app');
  scanDir(path.join(ROOT_DIR, 'packages'), 'lib');
  scanDir(path.join(ROOT_DIR, 'libs'), 'lib');

  // Secondary scan: nested packages within apps
  const appsDir = path.join(ROOT_DIR, 'apps');
  if (fs.existsSync(appsDir)) {
    for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanNestedPackages(path.join(appsDir, entry.name));
      }
    }
  }

  // Tertiary scan: deep SDK-style packages
  scanDeepPackages(path.join(ROOT_DIR, 'packages'));

  // An explicitly described root project is an application, even when it has child projects.
  // Package-only root discovery is for standalone repositories; umbrella workspaces keep child scheduling.
  const rootProjectJson = path.join(ROOT_DIR, 'project.json');
  if (fs.existsSync(rootProjectJson)) {
    if (!registerFromPackageJson(ROOT_DIR, 'app')) registerFromProjectJson(ROOT_DIR);
  } else if (projects.size === 0) {
    registerFromPackageJson(ROOT_DIR, 'app');
  }

  // Build dependency edges from package.json dependencies
  for (const [name, proj] of projects) {
    const allDeps = {
      ...(proj.packageJson.dependencies || {}),
      ...(proj.packageJson.devDependencies || {}),
    };
    for (const depName of Object.keys(allDeps)) {
      if (projects.has(depName)) {
        proj.dependencies.add(depName);
        projects.get(depName).dependents.add(name);
      }
    }
    // Also add implicitDependencies from project.json
    for (const implDep of proj.implicitDependencies) {
      if (projects.has(implDep)) {
        proj.dependencies.add(implDep);
        projects.get(implDep).dependents.add(name);
      }
    }
  }

  return projects;
}

// -----------------------------------------------------------------------------
// 2. TOPOLOGICAL SORT (Kahn's Algorithm)
// -----------------------------------------------------------------------------
function topoSort(projects) {
  const inDegree = new Map();
  const adjacency = new Map();
  const sorted = [];

  for (const [name] of projects) {
    inDegree.set(name, 0);
    adjacency.set(name, []);
  }

  for (const [name, proj] of projects) {
    for (const dep of proj.dependencies) {
      if (projects.has(dep)) {
        adjacency.get(dep).push(name);
        inDegree.set(name, (inDegree.get(name) || 0) + 1);
      }
    }
  }

  const queue = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  while (queue.length > 0) {
    // Sort queue alphabetically for deterministic output
    queue.sort();
    const curr = queue.shift();
    sorted.push(curr);
    for (const neighbor of adjacency.get(curr) || []) {
      const newDegree = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // If any nodes weren't visited, they form a cycle — append them anyway
  for (const [name] of projects) {
    if (!sorted.includes(name)) sorted.push(name);
  }

  return sorted;
}

// -----------------------------------------------------------------------------
// 3. AFFECTED CALCULATION
// -----------------------------------------------------------------------------
// DEVTRIE-0100 (native workspace parity): same remote policy as
// devtrie-lock-guard.js v2 — native DevTrie worktrees carry the governed
// `canonical` (gitd) remote; consulting `origin` there may contact GitHub,
// which a git-blind native publish must never do. GitHub-mode checkouts have
// no `canonical` remote and keep using `origin`.
function hasRemote(remote) {
  try {
    execFileSync('git', ['remote', 'get-url', remote], { cwd: ROOT_DIR, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the affected base ref. An explicit --base is honored verbatim (the
 * native merge gate pins the exact merge-base SHA this way). Otherwise the
 * governed main ref is refreshed best-effort and the first resolvable
 * candidate wins: <pushRemote>/main, then a local main. Single-branch
 * workspace clones (the DevTrie access contract: `git clone --branch
 * <lock> --single-branch <gitd>`) carry no main ref at all — that is a
 * parity failure and fails closed with the exact remediation instead of
 * silently diffing a fragment of the lock branch.
 */
function resolveAffectedBase(explicitBase) {
  if (explicitBase) {
    const safe = assertSafeGitRef(explicitBase, '--base');
    if (!refExists(safe)) {
      throw new Error(
        `[devtrie-engine] --base '${safe}' does not resolve to a commit in this checkout. ` +
        `FAIL-CLOSED: Cannot determine changed files safely.`
      );
    }
    return safe;
  }
  const pushRemote = hasRemote('canonical') ? 'canonical' : 'origin';
  try {
    // Best-effort refresh; offline is tolerated and the locally available
    // refs below are used. The explicit refspec (re)creates the tracking ref
    // even in single-branch clones, healing workspace parity autonomously.
    execFileSync(
      'git',
      ['fetch', '--quiet', pushRemote, `+refs/heads/main:refs/remotes/${pushRemote}/main`],
      { cwd: ROOT_DIR, stdio: 'ignore', timeout: 20000 },
    );
  } catch { /* offline OK — fall through to locally available main refs */ }
  const tracking = `${pushRemote}/main`;
  if (refExists(tracking)) return tracking;
  if (refExists('main')) return 'main';
  throw new Error(
    `[devtrie-engine] No affected base ref is resolvable (no '${tracking}' and no local 'main'). ` +
    `This checkout looks like a single-branch native workspace clone, so affected cannot see the full lock-branch diff ` +
    `and must not silently under-report it (the removed single-commit fallback did exactly that). ` +
    `FAIL-CLOSED. Restore workspace parity by fetching the governed main ref:\n` +
    `  git fetch ${pushRemote} +refs/heads/main:refs/remotes/${pushRemote}/main\n` +
    `or pin the merge base explicitly: npm run affected -- --base=<merge-base-sha>`
  );
}

function getChangedFiles(base) {
  const safeBase = assertSafeGitRef(base, '--base');
  let diff = '';

  try {
    diff = execFileSync('git', ['diff', '--name-only', `${safeBase}...HEAD`], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(
      `[devtrie-engine] Git diff failed against base '${safeBase}...HEAD': ` +
      `${err && err.message ? err.message.trim() : err}\n` +
      `FAIL-CLOSED: Cannot determine changed files safely. Pass an explicit --base=<ref> if the default base resolution is wrong for this checkout.`
    );
  }

  const files = (diff || '').trim().split('\n').filter(Boolean);
  const allowEmpty = process.env.DEVTRIE_ALLOW_EMPTY === 'true' || process.argv.includes('--allow-empty');
  if (files.length === 0 && !allowEmpty) {
    throw new Error(
      `[devtrie-engine] Git diff returned 0 changed files against base '${base}'. ` +
      `FAIL-CLOSED: Refusing to silently succeed on empty diff. Use --allow-empty or DEVTRIE_ALLOW_EMPTY=true if intended.`
    );
  }

  return files;
}

function getProject(projects, name) {
  if (projects.has(name)) return projects.get(name);
  for (const p of projects.values()) {
    if (p.dirName === name || (p.aliases && p.aliases.includes(name))) return p;
  }
  return undefined;
}

function findConsumers(projects, packageName) {
  const consumers = [];
  for (const [name, proj] of projects) {
    if (name === packageName) continue;
    const allDeps = {
      ...(proj.packageJson.dependencies || {}),
      ...(proj.packageJson.devDependencies || {}),
      ...(proj.packageJson.peerDependencies || {}),
    };
    if (
      allDeps[packageName] ||
      proj.dependencies.has(packageName) ||
      (proj.implicitDependencies || []).includes(packageName) ||
      (proj.aliases || []).includes(packageName)
    ) {
      consumers.push(name);
    }
  }
  return [...new Set(consumers)];
}

const ROOT_BLAST_RADIUS_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'nx.json',
  'AGENTS.md',
  'GEMINI.md',
  'tsconfig.json',
  'tsconfig.base.json',
  '.nvmrc',
]);

function isBlastRadiusFile(file) {
  if (ROOT_BLAST_RADIUS_FILES.has(file)) return true;
  if (
    file.startsWith('scripts/') ||
    file.startsWith('.github/') ||
    file.startsWith('.agents/')
  ) {
    return true;
  }
  return false;
}

// DEVTRIE-0252: pure project/file matcher over POSIX-normalized paths so
// Windows backslash roots match git's forward-slash diff output.
function matchDirectlyAffected(projects, changedFiles) {
  const directlyAffected = new Set();
  for (const file of changedFiles) {
    const posixFile = toPosix(file);
    for (const [name, proj] of projects) {
      const root = toPosix(proj.root);
      if (root === '' || posixFile === root || posixFile.startsWith(root + '/')) {
        directlyAffected.add(name);
      }
    }
  }
  return directlyAffected;
}

function calculateAffected(projects, base) {
  const changedFiles = getChangedFiles(base);

  for (const file of changedFiles) {
    // Root config, tooling, governance, or lockfile change → all projects affected (monorepo blast radius)
    if (isBlastRadiusFile(toPosix(file))) {
      console.log(`\x1b[33m⚡ Blast radius triggered by root file '${file}'. All projects marked affected.\x1b[0m`);
      return topoSort(projects);
    }
  }

  const directlyAffected = matchDirectlyAffected(projects, changedFiles);

  // DEVTRIE-0252: a non-empty diff that matches no project and triggers no
  // blast radius is legitimate for files outside every root (e.g. docs/), but
  // it is exactly what the Windows separator bug looked like — surface the
  // unmatched files so a suspicious zero is diagnosable instead of "clean".
  if (directlyAffected.size === 0 && changedFiles.length > 0) {
    const preview = changedFiles.slice(0, 5).join(', ');
    const suffix = changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : '';
    console.warn(`\x1b[33m[devtrie-engine] Notice: ${changedFiles.length} changed file(s) matched no discovered project root: ${preview}${suffix}\x1b[0m`);
  }

  // Transitive closure (DAG blast radius)
  const affected = new Set(directlyAffected);
  const queue = Array.from(directlyAffected);

  while (queue.length > 0) {
    const curr = queue.shift();
    const proj = projects.get(curr);
    if (proj) {
      for (const dependent of proj.dependents) {
        if (!affected.has(dependent)) {
          affected.add(dependent);
          queue.push(dependent);
        }
      }
    }
  }

  // Return in topological order
  const sortedAll = topoSort(projects);
  return sortedAll.filter(name => affected.has(name));
}

// -----------------------------------------------------------------------------
// 4. CONTENT-BASED CRYPTOGRAPHIC TASK HASHING
// -----------------------------------------------------------------------------
function hashTask(projectName, target, project, projects, memo = new Map()) {
  const memoKey = `${project.absPath}:${target}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  memo.set(memoKey, 'in-progress');

  const hasher = crypto.createHash('sha256');
  hasher.update(`project:${projectName}\n`);
  hasher.update(`target:${target}\n`);
  hasher.update(`command:${project.scripts[target] || ''}\n`);

  // Use git to hash tracked file contents (portable across machines)
  try {
    const gitFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: project.absPath,
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean).sort();

    const isBuildTarget = ['build', 'typecheck', 'pack', 'verify-consumer', 'auth-check'].includes(target);

    for (const file of gitFiles) {
      // For build targets, skip test files (input filtering)
      if (isBuildTarget && TEST_PATTERNS.some(p => p.test(file))) {
        continue;
      }
      // Skip generated/output directories
      if (file.startsWith('node_modules/') || file.startsWith('.next/') || file.startsWith('dist/') || file.startsWith('.devtrie/')) {
        continue;
      }

      const fullPath = path.join(project.absPath, file);
      try {
        const content = fs.readFileSync(fullPath);
        const fileHash = crypto.createHash('md5').update(content).digest('hex');
        hasher.update(`${file}:${fileHash}\n`);
      } catch {
        // File listed by git but unreadable — skip
      }
    }
  } catch {
    // git not available — fall back to directory walk with content hashing
    hashDirContents(hasher, project.absPath, target);
  }

  if (projects) {
    for (const depName of project.dependencies) {
      const dep = getProject(projects, depName);
      if (dep && dep.absPath !== project.absPath) {
        hasher.update(`dep:${depName}:${hashTask(dep.name, 'build', dep, projects, memo)}\n`);
      }
    }
  }

  const digest = hasher.digest('hex');
  memo.set(memoKey, digest);
  return digest;
}

function hashDirContents(hasher, dir, target) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const isBuildTarget = ['build', 'typecheck', 'pack', 'verify-consumer', 'auth-check'].includes(target);

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist' || entry.name === '.devtrie') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' && isBuildTarget) continue;
      hashDirContents(hasher, full, target);
    } else if (entry.isFile()) {
      if (isBuildTarget && TEST_PATTERNS.some(p => p.test(entry.name))) continue;
      try {
        const content = fs.readFileSync(full);
        const fileHash = crypto.createHash('md5').update(content).digest('hex');
        hasher.update(`${entry.name}:${fileHash}\n`);
      } catch {}
    }
  }
}

// -----------------------------------------------------------------------------
// 5. CACHE MANAGER (LOCAL DISK + S3 REMOTE)
// -----------------------------------------------------------------------------
function checkLocalCache(hash) {
  const localFile = path.join(CACHE_DIR, `${hash}.json`);
  if (fs.existsSync(localFile)) {
    try {
      return JSON.parse(fs.readFileSync(localFile, 'utf8'));
    } catch {}
  }
  return null;
}

function saveLocalCache(hash, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(CACHE_DIR, `${hash}.json`), JSON.stringify(data, null, 2));
  } catch {}
}

// AWS Signature Version 4 signing for MinIO/S3 (path-style, pure Node crypto).
// Without this, MinIO rejects every request — unsigned plain HTTP is not S3.
const S3_REGION = process.env.DEVTRIE_S3_REGION || 'us-east-1';

function s3SignV4(method, key, payloadBuffer) {
  const service = 's3';
  const host = new URL(S3_ENDPOINT).host;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(payloadBuffer).digest('hex');

  const canonicalUri = `/${S3_BUCKET}/${key}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${S3_REGION}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = crypto.createHmac('sha256', 'AWS4' + S3_SECRET_KEY).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(S3_REGION).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

let s3Warned = false;
function warnS3Once(context, detail) {
  if (s3Warned) return;
  s3Warned = true;
  console.warn(`[devtrie-engine] S3 cache ${context} failed: ${detail}. Check DEVTRIE_S3_* credentials and bucket '${S3_BUCKET}'.`);
}

function checkS3Cache(hash) {
  if (!S3_ACCESS_KEY || !S3_SECRET_KEY) return Promise.resolve(null);
  const key = `${hash}.json`;
  const url = new URL(`/${S3_BUCKET}/${key}`, S3_ENDPOINT);
  const authHeaders = s3SignV4('GET', key, Buffer.alloc(0));

  return new Promise((resolve) => {
    const req = http.get(url.href, { timeout: 2000, headers: authHeaders }, (res) => {
      if (res.statusCode !== 200) {
        if (res.statusCode !== 404) warnS3Once('read', `HTTP ${res.statusCode}`);
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          // Also save to local disk for faster future access
          saveLocalCache(hash, data);
          resolve(data);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', (err) => { warnS3Once('read', err.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function saveS3Cache(hash, data) {
  if (!S3_ACCESS_KEY || !S3_SECRET_KEY) return;
  const body = JSON.stringify(data, null, 2);
  const key = `${hash}.json`;
  const url = new URL(`/${S3_BUCKET}/${key}`, S3_ENDPOINT);
  const authHeaders = s3SignV4('PUT', key, Buffer.from(body));

  const req = http.request(url.href, {
    method: 'PUT',
    timeout: 3000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...authHeaders,
    },
  }, (res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      warnS3Once('write', `HTTP ${res.statusCode}`);
    }
    res.resume();
  });
  req.on('error', (err) => warnS3Once('write', err.message));
  req.on('timeout', () => req.destroy());
  req.write(body);
  req.end();
}

async function checkCache(hash) {
  // Try local first (fastest)
  const local = checkLocalCache(hash);
  if (local) return { ...local, cacheSource: 'local' };

  // Try S3 remote
  const remote = await checkS3Cache(hash);
  if (remote) return { ...remote, cacheSource: 's3' };

  return null;
}

function saveCache(hash, data) {
  saveLocalCache(hash, data);
  saveS3Cache(hash, data);
}

// -----------------------------------------------------------------------------
// 6. TASK EXECUTION RUNNER
// -----------------------------------------------------------------------------
// A workspace install can leave partial nested node_modules directories. In
// CI, directory existence is therefore not proof that a project's declared
// build tools are available. Install once per project per engine process;
// subsequent lint/test/build targets reuse that verified installation.
const ensuredProjectDeps = new Set();

function ensureProjectDeps(project) {
  const pkgPath = path.join(project.absPath, 'package.json');
  const nmPath = path.join(project.absPath, 'node_modules');
  if (!fs.existsSync(pkgPath)) return;
  let rootWorkspaces = null;
  try {
    const rp = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    rootWorkspaces = rp.workspaces || null;
  } catch { /* fall through to per-project behavior */ }
  const isWorkspaceMember = Array.isArray(rootWorkspaces) && project.absPath !== ROOT_DIR;
  const installCwd = isWorkspaceMember ? ROOT_DIR : project.absPath;
  // Workspace members share one root install; key the once-per-process guard
  // on the install location so N apps do not trigger N root installs.
  if (ensuredProjectDeps.has(installCwd)) return;
  const projectBin = path.join(nmPath, '.bin');
  const rootBin = path.join(ROOT_DIR, 'node_modules', '.bin');
  // DEVTRIE-0253: directory existence is not proof CLIs resolve — npm in a
  // workspace member installs at the ROOT and never creates a per-project
  // .bin (the merge gate hit exactly this: 'prisma: not found', exit 127).
  // Skip only when a .bin resolves at either level; repair at the level that
  // owns the layout (workspace root when hoisted).
  if (process.env.CI !== 'true' && (fs.existsSync(projectBin) || fs.existsSync(rootBin))) {
    ensuredProjectDeps.add(installCwd);
    return;
  }
  const hasLock = fs.existsSync(path.join(installCwd, 'package-lock.json'));
  // CI may set NODE_ENV=production, but compilation needs each project's
  // declared build-time dependencies (for example @types/react). Make this
  // explicit so a clean native merge worktree cannot silently omit them.
  const npmArgs = hasLock
    ? ['ci', '--ignore-scripts', '--include=dev']
    : ['install', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'];
  console.log(`Installing dependencies for ${project.name} in ${isWorkspaceMember ? 'workspace root' : project.root} (${hasLock ? 'npm ci --ignore-scripts --include=dev' : 'npm install --include=dev'})...`);
  try {
    execFileSync('npm', npmArgs, { cwd: installCwd, stdio: 'inherit' });
    ensuredProjectDeps.add(installCwd);
  } catch (err) {
    throw new Error(`[devtrie-engine] Dependency install failed for ${project.name} in ${project.root}: ${err.message}`);
  }
}

async function executeTask(projectName, target, project, projects) {
  const scriptCmd = project.scripts[target];
  if (!scriptCmd) {
    return { status: 'skipped', message: `No script '${target}' in ${projectName}` };
  }

  const hash = hashTask(projectName, target, project, projects);
  const skipReplay = process.env.CI === 'true';
  const cached = skipReplay ? null : await checkCache(hash);

  if (cached && cached.exitCode === 0) {
    const source = cached.cacheSource === 's3' ? 'DevTrie S3' : 'Local Disk';
    console.log(`\x1b[32m✔\x1b[0m \x1b[1m${projectName}:${target}\x1b[0m \x1b[36m[Cache Hit (${source}) — Replayed in ${cached.durationMs || 12}ms]\x1b[0m`);
    if (cached.stdout) process.stdout.write(cached.stdout);
    return { status: 'cached', durationMs: cached.durationMs || 12 };
  }

  console.log(`\x1b[33m▶\x1b[0m \x1b[1m${projectName}:${target}\x1b[0m \x1b[90m(Running cold...)\x1b[0m`);
  const startTime = Date.now();

  const cwd = project.absPath;
  ensureProjectDeps(project);
  // DEVTRIE-0253: npm workspaces hoist app binaries (next/prisma/eslint) into
  // the workspace root node_modules/.bin; a per-project .bin only exists for
  // non-hoistable deps. Spawn PATH must carry BOTH bins so project scripts
  // resolve their CLIs under every layout — matching what npm run provides.
  const binPath = [
    path.join(cwd, 'node_modules', '.bin'),
    path.join(ROOT_DIR, 'node_modules', '.bin'),
  ].join(path.delimiter);

  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', scriptCmd], {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        PATH: `${binPath}${path.delimiter}${process.env.PATH || ''}`,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    child.on('close', (exitCode) => {
      const durationMs = Date.now() - startTime;
      if (exitCode === 0) {
        saveCache(hash, { exitCode, stdout, durationMs, timestamp: new Date().toISOString() });
        console.log(`\x1b[32m✔\x1b[0m \x1b[1m${projectName}:${target}\x1b[0m \x1b[90m(${durationMs}ms — Cached)\x1b[0m`);
        resolve({ status: 'success', durationMs });
      } else {
        console.log(`\x1b[31m✖\x1b[0m \x1b[1m${projectName}:${target}\x1b[0m failed with exit code ${exitCode}`);
        resolve({ status: 'failed', exitCode, durationMs });
      }
    });
  });
}

// -----------------------------------------------------------------------------
// 7. DEPENDENCY INTEGRITY & GOVERNANCE GATE
// -----------------------------------------------------------------------------

function checkDependencies(projects) {
  const errors = [];
  const warnings = [];

  let rootPkg = null;
  const rootPkgPath = path.join(ROOT_DIR, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    try {
      rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    } catch {}
  }

  const rootPkgManager = rootPkg?.packageManager || 'npm';

  // Check all projects for internal dependency coherence
  for (const [name, proj] of projects) {
    const allDeps = {
      ...(proj.packageJson.dependencies || {}),
      ...(proj.packageJson.devDependencies || {}),
      ...(proj.packageJson.peerDependencies || {}),
    };

    for (const [depName, depVer] of Object.entries(allDeps)) {
      const isInternalNamespace = depName.startsWith('@devcore/') || depName.startsWith('@mbindev/');
      const isWorkspaceRef = String(depVer).includes('workspace:') || String(depVer).includes('file:');

      if (isInternalNamespace || isWorkspaceRef) {
        if (!projects.has(depName)) {
          errors.push(
            `[ORPHANED_DEPENDENCY] Project "${name}" (${proj.root}) requires internal package "${depName}" (${depVer}), but "${depName}" was not found in the monorepo workspace!`
          );
        }
      }
    }

    for (const implDep of proj.implicitDependencies) {
      if (!projects.has(implDep)) {
        warnings.push(
          `[MISSING_IMPLICIT_DEP] Project "${name}" declares implicit dependency "${implDep}", which does not exist.`
        );
      }
    }

    if (proj.packageJson.scripts) {
      for (const [scriptName, scriptCmd] of Object.entries(proj.packageJson.scripts)) {
        if (typeof scriptCmd === 'string' && (scriptCmd.includes('--package-lock=false') || scriptCmd.includes('--no-lockfile'))) {
          errors.push(
            `[BANNED_CI_FLAG] Project "${name}" script "${scriptName}" contains a forbidden lockfile bypass flag. Strict lockfile integrity is required.`
          );
        }
      }
    }
  }

  const consumerMap = {};
  for (const [name, proj] of projects) {
    // DEVTRIE-0252: classify via POSIX root so Windows backslash roots are
    // still recognized as packages/libs entries.
    const posixRoot = toPosix(proj.root);
    if (!posixRoot.startsWith('packages/') && !posixRoot.startsWith('libs/')) continue;
    consumerMap[name] = findConsumers(projects, name);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    rootPkgManager,
    consumerMap,
  };
}

// -----------------------------------------------------------------------------
// 8. CLI DISPATCHER
// -----------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const projects = discoverProjects();

  if (command === 'check-deps') {
    console.log(`\n\x1b[1m\x1b[36mDevTrie Dependency Integrity & Governance Gate\x1b[0m\n`);
    const result = checkDependencies(projects);
    let consumersPkg = '';
    for (const arg of args) {
      if (arg.startsWith('--consumers=')) consumersPkg = arg.split('=')[1];
    }

    if (result.warnings.length > 0) {
      console.log(`\x1b[33mWarnings (${result.warnings.length}):\x1b[0m`);
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
      console.log();
    }

    if (result.consumerMap && Object.keys(result.consumerMap).length > 0) {
      console.log(`\x1b[1mInternal package consumers:\x1b[0m`);
      for (const [pkg, consumers] of Object.entries(result.consumerMap)) {
        console.log(`  • ${pkg} ← ${consumers.length ? consumers.join(', ') : '(no downstream consumers)'}`);
      }
      console.log();
    }

    if (consumersPkg) {
      const consumers = findConsumers(projects, consumersPkg);
      if (consumers.length > 0) {
        console.error(`\x1b[31m✖ Cannot remove "${consumersPkg}": ${consumers.length} downstream consumer(s) remain:\x1b[0m`);
        for (const c of consumers) console.error(`  ✖ ${c}`);
        process.exit(1);
      }
      console.log(`\x1b[32m✔ "${consumersPkg}" has zero downstream consumers.\x1b[0m\n`);
      return;
    }

    if (!result.valid) {
      console.error(`\x1b[31m✖ Dependency Integrity Failed (${result.errors.length} error(s)):\x1b[0m`);
      for (const e of result.errors) {
        console.error(`  ✖ ${e}`);
      }
      console.error(`\n\x1b[31mAction Required: Restore missing internal packages or update consuming package.json files.\x1b[0m\n`);
      process.exit(1);
    }

    console.log(`\x1b[32m✔ All internal workspace dependencies resolved cleanly across ${projects.size} projects.\x1b[0m`);
    console.log(`\x1b[90mRoot Package Manager: ${result.rootPkgManager}\x1b[0m\n`);
    return;
  }

  if (command === 'show' || command === 'projects') {
    const sorted = topoSort(projects);
    console.log(`\n\x1b[1m\x1b[36mDevTrie Monorepo Workspace Projects (${projects.size}):\x1b[0m\n`);
    for (const name of sorted) {
      const p = projects.get(name);
      const via = p.discoveredVia === 'project.json' ? ' \x1b[90m(project.json)\x1b[0m' : '';
      console.log(`  • \x1b[1m${name}\x1b[0m (${p.type}) \x1b[90m-> ${p.root}\x1b[0m${via}`);
      if (p.dependencies.size > 0) {
        console.log(`    \x1b[90mdeps:\x1b[0m ${Array.from(p.dependencies).join(', ')}`);
      }
      if (p.implicitDependencies.length > 0 && p.discoveredVia === 'project.json') {
        console.log(`    \x1b[90mimplicit:\x1b[0m ${p.implicitDependencies.join(', ')}`);
      }
    }
    console.log();
    return;
  }

  if (command === 'graph') {
    const sorted = topoSort(projects);
    console.log(`\n\x1b[1m\x1b[36mDevTrie Topological Dependency Graph:\x1b[0m\n`);
    console.log(`  \x1b[90mExecution order (dependencies first):\x1b[0m`);
    sorted.forEach((name, i) => {
      const p = projects.get(name);
      const deps = p.dependencies.size > 0 ? ` \x1b[90m← [${Array.from(p.dependencies).join(', ')}]\x1b[0m` : '';
      console.log(`  ${i + 1}. \x1b[33m${name}\x1b[0m (${p.type})${deps}`);
    });
    console.log();

    // Also show provider → dependent tree
    console.log(`  \x1b[90mDependency tree:\x1b[0m`);
    for (const name of sorted) {
      const p = projects.get(name);
      if (p.dependents.size > 0) {
        console.log(`  \x1b[33m${name}\x1b[0m (Core Provider)`);
        for (const dep of p.dependents) {
          console.log(`    └── \x1b[32m${dep}\x1b[0m`);
        }
      }
    }
    console.log();
    return;
  }

  if (command === 'affected') {
    // Run dependency integrity check before executing affected tasks
    const depCheck = checkDependencies(projects);
    if (!depCheck.valid) {
      console.error(`\n\x1b[31m✖ DevTrie Dependency Gate Blocked:\x1b[0m`);
      for (const e of depCheck.errors) {
        console.error(`  ✖ ${e}`);
      }
      console.error(`\n\x1b[31mAction Required: Resolve broken/orphaned dependencies before running affected targets.\x1b[0m\n`);
      process.exit(1);
    }

    let target = 'build';
    let base = '';

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '-t' || args[i] === '--target') target = args[i + 1];
      if (args[i].startsWith('--target=')) target = args[i].split('=')[1];
      if (args[i].startsWith('--base=')) base = assertSafeGitRef(args[i].slice('--base='.length), '--base');
      if (args[i] === '--base') base = assertSafeGitRef(args[i + 1], '--base');
    }

    const targets = target.includes(',') ? target.split(',') : [target];
    const resolvedBase = resolveAffectedBase(base);
    const affected = calculateAffected(projects, resolvedBase);

    console.log(`\n\x1b[1m\x1b[36mDevTrie Affected Engine (Target: ${targets.join(', ')} | Base: ${resolvedBase})\x1b[0m`);
    console.log(`\x1b[90mDetected ${affected.length} affected projects out of ${projects.size} total (topological order).\x1b[0m\n`);

    if (affected.length === 0) {
      console.log(`\x1b[32m✔ No projects affected. Monorepo is 100% clean!\x1b[0m\n`);
      return;
    }

    let failCount = 0;
    const strictTargets = args.includes('--strict-targets') || process.env.DEVTRIE_STRICT_TARGETS === 'true';

    for (const projName of affected) {
      const proj = projects.get(projName);
      if (!proj) continue;
      for (const t of targets) {
        if (proj.scripts[t]) {
          const res = await executeTask(projName, t, proj, projects);
          if (res.status === 'failed') {
            failCount++;
            if (!process.env.DEVTRIE_KEEP_GOING) {
              console.log(`\n\x1b[31m✖ Task ${projName}:${t} failed. Stopping.\x1b[0m\n`);
              process.exit(1);
            }
          }
        } else {
          const isRequired = strictTargets || (proj.requiredTargets && proj.requiredTargets.includes(t));
          if (isRequired) {
            failCount++;
            console.log(`\x1b[31m✖\x1b[0m \x1b[1m${projName}:${t}\x1b[0m \x1b[31m[Missing required target]\x1b[0m`);
            if (!process.env.DEVTRIE_KEEP_GOING) {
              console.log(`\n\x1b[31m✖ Required target '${t}' missing in project '${projName}'. Stopping.\x1b[0m\n`);
              process.exit(1);
            }
          } else {
            console.log(`\x1b[90m–\x1b[0m \x1b[1m${projName}:${t}\x1b[0m \x1b[90m[Skipped — target not defined in project]\x1b[0m`);
          }
        }
      }
    }

    if (failCount > 0) {
      console.log(`\n\x1b[31m✖ ${failCount} task(s) failed.\x1b[0m\n`);
      process.exit(1);
    }
    console.log(`\n\x1b[32m✔ All ${affected.length} affected DevTrie tasks completed successfully!\x1b[0m\n`);
    return;
  }

  if (command === 'run-many') {
    let target = 'build';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '-t' || args[i] === '--target') target = args[i + 1];
      if (args[i].startsWith('--target=')) target = args[i].split('=')[1];
    }

    const sorted = topoSort(projects);
    console.log(`\n\x1b[1m\x1b[36mDevTrie Running '${target}' across all projects (topological order)...\x1b[0m\n`);
    const strictTargets = args.includes('--strict-targets') || process.env.DEVTRIE_STRICT_TARGETS === 'true';

    for (const name of sorted) {
      const proj = projects.get(name);
      if (proj.scripts[target]) {
        const res = await executeTask(name, target, proj, projects);
        if (res.status === 'failed') {
          process.exit(1);
        }
      } else {
        const isRequired = strictTargets || (proj.requiredTargets && proj.requiredTargets.includes(target));
        if (isRequired) {
          console.error(`\x1b[31m✖ Required target '${target}' missing in project '${name}'. Stopping.\x1b[0m`);
          process.exit(1);
        } else {
          console.log(`\x1b[90m–\x1b[0m \x1b[1m${name}:${target}\x1b[0m \x1b[90m[Skipped — target not defined in project]\x1b[0m`);
        }
      }
    }
    console.log(`\n\x1b[32m✔ DevTrie run-many completed.\x1b[0m\n`);
    return;
  }

  if (command === 'run') {
    const targetSpec = args[1];
    if (!targetSpec || !targetSpec.includes(':')) {
      console.error('Usage: devtrie run <project>:<target>');
      process.exit(1);
    }
    const colonIdx = targetSpec.lastIndexOf(':');
    const projName = targetSpec.slice(0, colonIdx);
    const target = targetSpec.slice(colonIdx + 1);
    const proj = getProject(projects, projName);
    if (!proj) {
      console.error(`Project '${projName}' not found. Available: ${Array.from(projects.keys()).join(', ')}`);
      process.exit(1);
    }
    const res = await executeTask(proj.name, target, proj, projects);
    if (res.status === 'failed') process.exit(1);
    if (res.status === 'skipped') {
      console.error(`\x1b[31m✖ Target '${target}' not defined in project '${proj.name}'.\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  console.log(`
\x1b[1mDevTrie Native Monorepo Task & Cache Engine v2\x1b[0m

Usage:
  devtrie show / projects                      Show all discovered projects (topological order)
  devtrie graph                                Display topological DAG with dependency tree
  devtrie check-deps [--consumers=<pkg>]       Validate workspace graph; --consumers fails if downstream users remain
  devtrie affected -t <target> [--base=<ref>]  Run target on affected projects only
  devtrie run-many -t <target>                 Run target on all projects (topological order)
  devtrie run <project>:<target>               Run single project target

Affected base resolution (DEVTRIE-0100 native workspace parity):
  --base=<ref>          Explicit base (the native merge gate pins the merge-base SHA).
  default               Refresh <canonical|origin>/main best-effort, then use it;
                       fall back to a local main. Single-branch workspace clones
                       without any main ref FAIL CLOSED with the fetch command
                       that restores parity — never a partial-branch diff.

Environment:
  DEVTRIE_S3_ENDPOINT      S3 endpoint (default: http://10.5.0.180:9000)
  DEVTRIE_S3_BUCKET        S3 bucket (default: nx-cache)
  DEVTRIE_S3_ACCESS_KEY    S3 access key (or AWS_ACCESS_KEY_ID)
  DEVTRIE_S3_SECRET_KEY    S3 secret key (or AWS_SECRET_ACCESS_KEY)
  DEVTRIE_KEEP_GOING       If set, don't stop on first failure
`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('DevTrie Engine Error:', err);
    process.exit(1);
  });
}

// Exported for scripts/pipeline-contract.test.js (DEVTRIE-0252 Windows
// affected-parity assertions). Requiring this module never runs the engine.
module.exports = {
  toPosix,
  matchDirectlyAffected,
  isBlastRadiusFile,
  discoverProjects,
  topoSort,
  calculateAffected,
  checkDependencies,
  getProject,
  findConsumers,
};
