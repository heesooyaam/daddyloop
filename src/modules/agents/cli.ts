import { command } from '../../ops/process.js';
import { executablePath, versionNumber } from '../../runtime/executable.js';

export async function probeCli(executable: string, signal: AbortSignal) {
  if (!executablePath(executable)) throw new Error('The selected agent CLI is unavailable');
  const result = await command(executable, ['--version'], {
    timeoutMs: 10000,
    maxBytes: 8000,
    signal,
  });
  const version = versionNumber(result.stdout);
  if (!version) throw new Error('The agent CLI did not report a recognizable version');
  return { executable, version };
}
export const registry = 'https://registry.npmjs.org';
export const stableVersion = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
export async function packageMetadata(
  name: string,
  version: string,
  signal: AbortSignal,
  fetcher = fetch,
) {
  const response = await fetcher(
    `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    {
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    },
  );
  if (!response.ok || !response.body)
    throw new Error(`Version registry returned HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Version registry response is too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString()) as {
    name?: string;
    version?: string;
    optionalDependencies?: Record<string, string>;
    dist?: { tarball?: string; integrity?: string };
  };
  if (value.name !== name || !value.version)
    throw new Error('Version registry returned an unexpected package');
  return value;
}
export async function latestVersion(name: string, signal: AbortSignal, fetcher = fetch) {
  const value = await packageMetadata(name, 'latest', signal, fetcher);
  if (!stableVersion.test(value.version!))
    throw new Error('Version registry returned an invalid stable version');
  return value.version!;
}
