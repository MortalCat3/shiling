/** Build and verify local-only releases. Never pushes images or starts application services. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [phase, value] = process.argv.slice(2);
const context = process.env['SHILING_DOCKER_CONTEXT'] ?? 'default';
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(SHILING_|COMPOSE_)/.test(key)),
);
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 900000,
    ...options,
  });
}
const docker = (args, options) => run('docker', ['--context', context, ...args], options);
const git = (args) => run('git', args).trim();
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const save = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
assert.ok(
  JSON.parse(docker(['context', 'inspect', context]))[0].Endpoints.docker.Host.startsWith(
    'unix://',
  ),
  'Only a local Docker socket is allowed.',
);

if (phase === 'build') {
  const version = (await json(join(root, 'package.json'))).version;
  assert.match(version, /^\d+\.\d+\.\d+-rc\.\d+$/);
  assert.equal(
    git(['status', '--porcelain']),
    '',
    'Commit the reviewed release source before building.',
  );
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const sourceTree = git(['rev-parse', 'HEAD^{tree}']);
  const output = join(root, 'release-artifacts', version);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Refuse to overwrite a release or a failed build's evidence.
  const source = await mkdtemp(join(tmpdir(), 'shiling-release-source-'));
  try {
    const archive = run('git', ['archive', '--format=tar', sourceCommit], { encoding: 'buffer' });
    run('tar', ['-xf', '-', '-C', source], { input: archive });
    const baseImages = await json(join(source, 'deploy/releases/base-images.json'));
    for (const reference of Object.values(baseImages))
      assert.match(reference, /@sha256:[a-f0-9]{64}$/);
    const manifest = {
      schemaVersion: 1,
      version,
      sourceCommit,
      sourceTree,
      platform: 'linux/arm64',
      createdAt: new Date().toISOString(),
      packageManager: (await json(join(source, 'package.json'))).packageManager,
      lockfileSha256: await sha256(join(source, 'pnpm-lock.yaml')),
      baseImages,
      images: {},
      distribution: 'local-only',
      motionExecutionEnabled: false,
    };
    for (const target of ['runtime', 'web', 'postgres']) {
      const tag = `shiling-${target}:${version}`;
      assert.equal(docker(['image', 'ls', '-q', tag]).trim(), '', `Refusing to overwrite ${tag}`);
      const metadataFile = join(output, `${target}.build-metadata.json`);
      console.info(`Building ${tag} from ${sourceCommit}`);
      docker(
        [
          'buildx',
          'build',
          '--platform',
          manifest.platform,
          '--load',
          '--provenance=false',
          '--target',
          target,
          '--tag',
          tag,
          '--metadata-file',
          metadataFile,
          '--label',
          `org.opencontainers.image.version=${version}`,
          '--label',
          `org.opencontainers.image.revision=${sourceCommit}`,
          '--label',
          `org.opencontainers.image.created=${manifest.createdAt}`,
          ...Object.entries(baseImages).flatMap(([key, reference]) => [
            '--build-arg',
            `${key}=${reference}`,
          ]),
          '--file',
          join(source, 'deploy/images/Dockerfile'),
          source,
        ],
        { stdio: 'inherit' },
      );
      const metadata = await json(metadataFile);
      const digest = metadata['containerimage.digest'];
      assert.match(digest, /^sha256:[a-f0-9]{64}$/);
      const reference = `shiling-${target}@${digest}`;
      const inspected = JSON.parse(docker(['image', 'inspect', reference]))[0];
      assert.equal(inspected.Config.Labels['org.opencontainers.image.revision'], sourceCommit);
      assert.equal(inspected.Architecture, 'arm64');
      manifest.images[target] = {
        tag,
        reference,
        manifestDigest: digest,
        configDigest: metadata['containerimage.config.digest'],
        localImageId: inspected.Id,
      };
    }
    const archiveName = `shiling-${version}-linux-arm64.docker.tar`;
    docker([
      'image',
      'save',
      '--output',
      join(output, archiveName),
      ...Object.values(manifest.images).map(({ tag }) => tag),
    ]);
    manifest.archive = {
      file: archiveName,
      sha256: await sha256(join(output, archiveName)),
      bytes: (await stat(join(output, archiveName))).size,
    };
    const services = {};
    for (const service of ['api', 'worker', 'preview', 'migrate', 'web', 'postgres']) {
      const target = ['web', 'postgres'].includes(service) ? service : 'runtime';
      services[service] = { image: manifest.images[target].reference, pull_policy: 'never' };
    }
    await save(join(output, 'compose.images.json'), { services });
    await save(join(output, 'manifest.json'), manifest);
    await writeFile(join(output, 'SHA256SUMS'), `${manifest.archive.sha256}  ${archiveName}\n`);
    console.info(`Local release ready: release-artifacts/${version}/manifest.json`);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
} else if (phase === 'verify') {
  assert.ok(value, 'Pass the release manifest path.');
  const file = resolve(value);
  const manifest = await json(file);
  assert.equal(manifest.distribution, 'local-only');
  assert.equal(manifest.motionExecutionEnabled, false);
  assert.equal(git(['rev-parse', `${manifest.sourceCommit}^{tree}`]), manifest.sourceTree);
  const locked = run('git', ['show', `${manifest.sourceCommit}:pnpm-lock.yaml`], {
    encoding: 'buffer',
  });
  assert.equal(createHash('sha256').update(locked).digest('hex'), manifest.lockfileSha256);
  for (const entry of Object.values(manifest.images)) {
    const inspected = JSON.parse(docker(['image', 'inspect', entry.reference]))[0];
    assert.equal(inspected.Id, entry.localImageId);
    assert.equal(
      inspected.Config.Labels['org.opencontainers.image.revision'],
      manifest.sourceCommit,
    );
    assert.equal(inspected.Config.Labels['org.opencontainers.image.version'], manifest.version);
    assert.equal(`${inspected.Os}/${inspected.Architecture}`, manifest.platform);
  }
  assert.equal(await sha256(join(dirname(file), manifest.archive.file)), manifest.archive.sha256);
  assert.equal(
    (await stat(join(dirname(file), manifest.archive.file))).size,
    manifest.archive.bytes,
  );
  console.info(
    `PASS ${manifest.version}: source, immutable image references, OCI labels and offline archive match.`,
  );
} else throw new Error('Usage: node scripts/release-local.mjs build | verify <manifest.json>');
