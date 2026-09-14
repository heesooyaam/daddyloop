import type { AgentPackage } from '../../contracts.js';
import { installAgentPackage } from '../../../ops/agent-package.js';
import { packageMetadata, stableVersion, registry } from '../cli.js';
function platform() {
  if (
    process.platform !== 'linux' ||
    !['x64', 'arm64'].includes(process.arch) ||
    !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
      .glibcVersionRuntime
  )
    throw new Error('Managed Claude Code updates require Linux glibc x64 or ARM64');
  return `linux-${process.arch}`;
}
export function validatePackage(pkg: AgentPackage) {
  const name = `claude-code-${platform()}`;
  if (
    !stableVersion.test(pkg.version) ||
    pkg.platform !== platform() ||
    pkg.url !== `${registry}/@anthropic-ai/${name}/-/${name}-${pkg.version}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity)
  )
    throw new Error('Invalid official Claude Code package metadata');
}
export async function latestClaudePackage(
  signal: AbortSignal,
  fetcher = fetch,
): Promise<AgentPackage> {
  const target = platform(),
    name = `@anthropic-ai/claude-code-${target}`;
  const main = await packageMetadata('@anthropic-ai/claude-code', 'latest', signal, fetcher);
  if (!stableVersion.test(main.version!) || main.optionalDependencies?.[name] !== main.version)
    throw new Error('Unsupported Claude Code package layout');
  const binary = await packageMetadata(name, main.version!, signal, fetcher);
  if (binary.version !== main.version)
    throw new Error('Claude Code platform version does not match');
  const pkg = {
    version: main.version!,
    platform: target,
    url: binary.dist?.tarball ?? '',
    integrity: binary.dist?.integrity ?? '',
  };
  validatePackage(pkg);
  return pkg;
}
export async function installClaudePackage(
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
    (listing) => ({
      members: listing
        .filter((name) => name === 'package/claude')
        .map((source) => ({ source, target: 'bin/claude' })),
      executable: 'bin/claude',
    }),
    fetcher,
  );
}
