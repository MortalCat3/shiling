import { readFile } from 'node:fs/promises';

const required = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim();
const expected = required.split('.').map(Number);
const actual = process.versions.node.split('.').map(Number);
const sufficientlyNew =
  actual[0] === expected[0] &&
  (actual[1] > expected[1] || (actual[1] === expected[1] && actual[2] >= expected[2]));

if (!sufficientlyNew) {
  console.error(
    `This workspace requires Node ${required} or a newer Node 24 patch. Current: ${process.versions.node}.`,
  );
  process.exitCode = 1;
}
