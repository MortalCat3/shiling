import { readdir, readFile, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import vueParser from 'vue-eslint-parser';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignored = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.pnpm-store',
  '.cache',
  'data',
  'backups',
  '.impeccable',
  'secrets.local',
  'release-artifacts',
]);
const issues = [];

async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(item.name)) continue;
    if (directory === root && ['findings.md', 'progress.md', 'task_plan.md'].includes(item.name))
      continue;
    // Never inspect private runtime settings during this repository check.
    if (item.name.startsWith('.env') && item.name !== '.env.example') continue;
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...(await walk(absolute)));
    else if (item.isFile()) files.push(absolute);
    else if (item.isSymbolicLink())
      issues.push(`Unexpected source symlink: ${path.relative(root, absolute)}`);
  }
  return files;
}

const files = await walk(root);
const manifests = new Map();
for (const file of files.filter((item) => path.basename(item) === 'package.json')) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifests.set(manifest.name, { manifest, directory: path.dirname(file) });
  if (manifest.private !== true)
    issues.push(`${manifest.name}: packages are private until a release is explicitly approved.`);
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version) && version !== 'workspace:*') {
        issues.push(`${manifest.name}: ${name} must use an exact version or workspace:*.`);
      }
    }
  }
}

const allowed = {
  '@shiling/web': ['@shiling/contracts', '@shiling/ui'],
  '@shiling/api': ['@shiling/backend', '@shiling/contracts'],
  '@shiling/worker': ['@shiling/backend', '@shiling/contracts', '@shiling/media'],
  '@shiling/preview': ['@shiling/contracts'],
  '@shiling/contracts': [],
  '@shiling/backend': ['@shiling/contracts', '@shiling/media'],
  '@shiling/media': ['@shiling/contracts'],
  '@shiling/ui': ['@shiling/contracts'],
};

for (const [name, entry] of manifests) {
  if (name === 'shiling') continue;
  if (!(name in allowed)) issues.push(`Unregistered workspace package: ${name}`);
  for (const section of ['dependencies', 'devDependencies']) {
    for (const dependency of Object.keys(entry.manifest[section] ?? {})) {
      if (!dependency.startsWith('@shiling/')) continue;
      if (!manifests.has(dependency))
        issues.push(`${name}: missing workspace package ${dependency}.`);
      if (!allowed[name]?.includes(dependency))
        issues.push(`${name}: forbidden workspace dependency ${dependency}.`);
    }
  }
}

function isInside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

const workspaces = [...manifests.values()].filter(({ directory }) =>
  /^(?:apps|packages)[/\\][^/\\]+$/.test(path.relative(root, directory)),
);
const browserPackages = new Set(['@shiling/web', '@shiling/ui', '@shiling/contracts']);

function checkImport(file, owner, specifier, line) {
  const location = `${path.relative(root, file)}:${line}`;
  const name = owner.manifest.name;
  if (
    specifier.includes('\\') ||
    path.isAbsolute(specifier) ||
    path.win32.isAbsolute(specifier) ||
    specifier.startsWith('file:')
  ) {
    issues.push(
      `${location}: imports must use portable package names or package-local relative paths.`,
    );
    return;
  }
  if (specifier.startsWith('.')) {
    try {
      const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
      if (!isInside(owner.directory, target)) {
        issues.push(
          `${location}: relative import escapes ${name}: ${specifier}. Use a declared workspace package export.`,
        );
      }
    } catch {
      issues.push(`${location}: invalid relative import ${specifier}.`);
    }
    return;
  }
  if (
    browserPackages.has(name) &&
    isInside(path.join(owner.directory, 'src'), file) &&
    isBuiltin(specifier)
  ) {
    issues.push(`${location}: browser-safe source cannot import Node builtin ${specifier}.`);
  }
  if (!specifier.startsWith('@shiling/')) return;

  const segments = specifier.split('/');
  const dependency = segments.slice(0, 2).join('/');
  const subpath = segments.slice(2);
  if (subpath.some((segment) => ['src', 'dist', '.', '..', ''].includes(segment))) {
    issues.push(`${location}: forbidden workspace internal path ${specifier}.`);
  }
  const declarations = {
    ...owner.manifest.dependencies,
    ...owner.manifest.devDependencies,
    ...owner.manifest.peerDependencies,
    ...owner.manifest.optionalDependencies,
  };
  if (!Object.hasOwn(declarations, dependency)) {
    issues.push(`${location}: ${dependency} is not declared in ${name}/package.json.`);
  }
  if (!allowed[name]?.includes(dependency)) {
    issues.push(`${location}: forbidden workspace import ${dependency} from ${name}.`);
  }
  const target = manifests.get(dependency);
  if (target === undefined) {
    issues.push(`${location}: missing workspace package ${dependency}.`);
    return;
  }
  const exportKey = subpath.length === 0 ? '.' : `./${subpath.join('/')}`;
  const exports = target.manifest.exports;
  // Foundation packages expose exact paths only; new wildcard exports need an explicit guard update.
  const exported =
    exports !== null && typeof exports === 'object' && !Array.isArray(exports)
      ? Object.keys(exports).some((key) => key.startsWith('.'))
        ? Object.hasOwn(exports, exportKey) && exports[exportKey] !== null
        : exportKey === '.'
      : exportKey === '.' && exports !== undefined && exports !== null;
  if (!exported) issues.push(`${location}: ${specifier} has no explicit public package export.`);
}

function checkScript(file, owner, source, offsetLine, scriptKind) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  for (const diagnostic of tree.parseDiagnostics) {
    const line = offsetLine + tree.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
    issues.push(
      `${path.relative(root, file)}:${line}: cannot parse imports: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }
  function checkLiteral(node, argument) {
    const line = offsetLine + tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    if (
      argument &&
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      checkImport(file, owner, argument.text, line);
    } else {
      issues.push(
        `${path.relative(root, file)}:${line}: computed import()/require() cannot be checked; use a literal import.`,
      );
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) checkLiteral(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      checkLiteral(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkLiteral(node, node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      checkLiteral(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

// Source-only architecture guard, not a runtime sandbox. It does not follow eval, loader aliases,
// import.meta.glob, custom transpilers, or Vue template/style resource references.
// Root scripts intentionally import build outputs and are outside workspace source ownership.
for (const file of files.filter((item) => /\.(?:[cm]?[jt]sx?|vue)$/.test(item))) {
  const owner = workspaces.find(({ directory }) => isInside(directory, file));
  if (owner === undefined) continue;
  const source = await readFile(file, 'utf8');
  if (!file.endsWith('.vue')) {
    const kind = file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : file.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : /\.[cm]?ts$/.test(file)
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS;
    checkScript(file, owner, source, 0, kind);
    continue;
  }
  try {
    const parsed = vueParser.parseForESLint(source, {
      filePath: file,
      parser: false,
      sourceType: 'module',
      ecmaVersion: 'latest',
    });
    for (const block of parsed.services.getDocumentFragment().children) {
      if (block.type !== 'VElement' || block.name !== 'script') continue;
      const attribute = (name) =>
        block.startTag.attributes.find((item) => !item.directive && item.key.name === name)?.value
          ?.value;
      const start = block.startTag.range[1];
      const offsetLine = source.slice(0, start).split('\n').length - 1;
      const external = attribute('src');
      if (external !== undefined) checkImport(file, owner, external, offsetLine + 1);
      const language = attribute('lang') ?? 'js';
      const kinds = {
        ts: ts.ScriptKind.TS,
        tsx: ts.ScriptKind.TSX,
        js: ts.ScriptKind.JS,
        jsx: ts.ScriptKind.JSX,
      };
      if (!Object.hasOwn(kinds, language)) {
        issues.push(
          `${path.relative(root, file)}:${offsetLine + 1}: unsupported Vue script language ${language}; imports cannot be checked.`,
        );
        continue;
      }
      checkScript(
        file,
        owner,
        source.slice(start, block.endTag?.range[0] ?? start),
        offsetLine,
        kinds[language],
      );
    }
  } catch (error) {
    issues.push(`${path.relative(root, file)}: cannot extract Vue scripts: ${error.message}`);
  }
}

const textExtensions = /\.(?:md|json|ya?ml|[cm]?js|ts|vue|css|html|example)$/;
for (const file of files.filter((item) => textExtensions.test(item))) {
  const text = await readFile(file, 'utf8');
  const relative = path.relative(root, file);
  if (/(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\)/.test(text)) {
    issues.push(`${relative}: local personal filesystem path found.`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    issues.push(`${relative}: private-key material found.`);
  }
  if (!file.endsWith('.md')) continue;
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const reference = match[1].replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/.test(reference)) continue;
    if (path.isAbsolute(reference)) {
      issues.push(`${relative}: documentation must use portable relative links.`);
      continue;
    }
    const target = decodeURIComponent(reference.split('#')[0]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      issues.push(`${relative}: link escapes the repository.`);
      continue;
    }
    try {
      await stat(resolved);
    } catch {
      issues.push(`${relative}: missing local link ${target}.`);
    }
  }
}

if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Project checks passed: ${manifests.size - 1} workspace packages; portable documentation and dependency directions.`,
  );
}
