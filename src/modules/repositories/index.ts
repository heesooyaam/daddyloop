import { githubModule } from './github.js';
import { gitlabModule } from './gitlab.js';
import { arcadiaModule } from './arcadia.js';
import { RepositoryRegistry } from './registry.js';
export const repositoryModules = () => [githubModule, gitlabModule, arcadiaModule];
export const allRepositories = () => new RepositoryRegistry(repositoryModules());
