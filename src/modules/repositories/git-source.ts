import { AppError } from '../../core/types.js';
import { credential, rememberSecret } from '../../core/security.js';
import type { GitRepositorySource, GitRepositoryTransport } from '../contracts.js';

/** Kept separate from local paths: unknown protocols must never reach a Git helper. */
export function isGitAddress(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\s]+@[^/\s]+:/.test(value);
}
export function parseGitSource(value: string): GitRepositorySource {
  const invalid = () =>
    new AppError(
      'repository_url_invalid',
      'Use an HTTPS or SSH repository URL without passwords, query parameters or fragments',
      400,
    );
  if (/[\s\\%?#\0]/.test(value)) throw invalid();
  const scp = value.match(/^([a-zA-Z0-9_][a-zA-Z0-9_.-]*)@([a-zA-Z0-9.-]+):(.+)$/);
  const address = scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : value;
  // URL() normalizes dot segments, so check the original spelling first.
  if (address.split('/').some((part) => part === '.' || part === '..')) throw invalid();
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw invalid();
  }
  if (
    !['https:', 'ssh:'].includes(url.protocol) ||
    !url.hostname ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'https:' && (url.username || url.port)) ||
    (url.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(url.username))
  )
    throw invalid();
  const repo = url.pathname
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  )
    throw invalid();
  url.pathname = `/${repo}.git`;
  return {
    url: url.toString(),
    host: url.hostname,
    repo,
    protocol: url.protocol as 'https:' | 'ssh:',
  };
}

export function gitTransport(
  provider: string,
  username: string,
  validRepo: RegExp,
): GitRepositoryTransport {
  return {
    parse(value) {
      const source = parseGitSource(value);
      if (!validRepo.test(source.repo))
        throw new AppError('repository_name_invalid', `Invalid ${provider} repository name`, 400);
      return source;
    },
    environment(source) {
      if (source.protocol === 'ssh:')
        return { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' };
      let token: string;
      try {
        token = credential(provider, source.host);
      } catch (error) {
        // Public clones and configured Git credential helpers need no application token.
        if (error instanceof AppError && error.code === 'credentials_missing') return {};
        throw error;
      }
      const header = `Authorization: Basic ${rememberSecret(Buffer.from(`${username}:${token}`).toString('base64'))}`;
      // Git's quoted environment format keeps the token out of argv and disk.
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      return {
        GIT_CONFIG_PARAMETERS: [
          process.env.GIT_CONFIG_PARAMETERS,
          quote(`http.${new URL(source.url).origin}/.extraHeader=${header}`),
          quote('credential.helper='),
        ]
          .filter(Boolean)
          .join(' '),
      };
    },
  };
}
