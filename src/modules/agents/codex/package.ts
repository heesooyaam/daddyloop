import type { AgentPackage } from '../../contracts.js';
import { packageMetadata } from '../cli.js';
import { installAgentPackage } from '../../../ops/agent-package.js';

const registry = 'https://registry.npmjs.org';
const stableVersion = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
function platform() {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    throw new Error('Managed Codex updates require Linux x64 or ARM64');
  return `linux-${process.arch}`;
}
export function validatePackage(value: AgentPackage) {
  if (
    !stableVersion.test(value.version) ||
    value.platform !== platform() ||
    value.url !== `${registry}/@openai/codex/-/codex-${value.version}-${value.platform}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity)
  )
    throw new Error('Invalid official Codex package metadata');
}
const metadata = (path: string, signal: AbortSignal, fetcher: typeof fetch) =>
  packageMetadata('@openai/codex', path, signal, fetcher);
export async function latestCodexPackage(
  signal: AbortSignal,
  fetcher = fetch,
): Promise<AgentPackage> {
  const target = platform(),
    main = await metadata('latest', signal, fetcher);
  if (
    main.name !== '@openai/codex' ||
    !main.version ||
    !stableVersion.test(main.version) ||
    main.optionalDependencies?.[`@openai/codex-${target}`] !==
      `npm:@openai/codex@${main.version}-${target}`
  )
    throw new Error('Unsupported Codex package layout');
  const binary = await metadata(`${main.version}-${target}`, signal, fetcher);
  if (binary.name !== '@openai/codex' || binary.version !== `${main.version}-${target}`)
    throw new Error('Codex platform package does not match the requested version');
  const result = {
    version: main.version,
    platform: target,
    url: binary.dist?.tarball ?? '',
    integrity: binary.dist?.integrity ?? '',
  };
  validatePackage(result);
  return result;
}

export async function installCodexPackage(
  pkg: AgentPackage,
  root: string,
  signal: AbortSignal,
  resourceCheck: () => void,
  fetcher = fetch,
) {
  validatePackage(pkg);
  return installAgentPackage(
    pkg,
    root,
    signal,
    resourceCheck,
    (listing) => {
      const triple =
        process.arch === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
      const prefix = `package/vendor/${triple}/`;
      const members = listing
        .filter((name) => name.startsWith(prefix) && !name.endsWith('/'))
        .map((source) => ({ source, target: source.slice(prefix.length) }));
      const executable = ['bin/codex', 'codex/codex'].find((name) =>
        members.some((m) => m.target === name),
      );
      if (!executable) throw new Error('Codex archive contains no supported executable');
      return { members, executable };
    },
    fetcher,
  );
}
