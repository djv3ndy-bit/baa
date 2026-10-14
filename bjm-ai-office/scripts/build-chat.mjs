import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Chat-only deployments expose the API functions, without the legacy frontend.
export async function buildChatOutput(outputDirectory = new URL('../dist-chat/', import.meta.url)) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const robots = outputDirectory instanceof URL ? new URL('robots.txt', outputDirectory) : resolve(outputDirectory, 'robots.txt');
  await writeFile(robots, 'User-agent: *\nDisallow: /\n', 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildChatOutput();
