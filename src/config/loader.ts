import type { Octokit } from '@octokit/rest';
import YAML from 'yaml';
import { reviewConfigSchema, type ReviewConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { ConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const CONFIG_FILENAME = '.kimi-review.yml';

const INSTRUCTION_PATHS = [
  '.github/copilot-instructions.md',
  '.github/instructions/code-review.instructions.md',
];

export async function loadConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<ReviewConfig> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: CONFIG_FILENAME,
    });

    if (!('content' in data) || data.encoding !== 'base64') {
      logger.info('Config file found but not a regular file, using defaults');
      return DEFAULT_CONFIG;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = parseYaml(content);
    const result = reviewConfigSchema.safeParse(parsed);

    if (!result.success) {
      logger.warn({ errors: result.error.issues }, 'Config validation failed, using defaults');
      throw new ConfigError(`Invalid config: ${result.error.message}`);
    }

    const config = result.data;

    // Load external instruction files if present
    const instructionParts: string[] = [];
    const loadedPaths: string[] = [];
    for (const path of INSTRUCTION_PATHS) {
      try {
        const { data: fileData } = await octokit.repos.getContent({ owner, repo, path });
        if ('content' in fileData && fileData.encoding === 'base64') {
          const text = Buffer.from(fileData.content, 'base64').toString('utf-8');
          if (text.trim()) {
            instructionParts.push(`--- ${path} ---\n${text}`);
            loadedPaths.push(path);
          }
        }
      } catch {
        // ignore missing instruction files
      }
    }

    if (instructionParts.length > 0) {
      config.instructions = instructionParts.join('\n\n');
      logger.info({ paths: loadedPaths }, 'Loaded external instructions');
    }

    logger.info({ language: config.language, model: config.model }, 'Config loaded');
    return config;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    // 404 — no config file, use defaults
    logger.info('No .kimi-review.yml found, using defaults');
    return DEFAULT_CONFIG;
  }
}

function parseYaml(content: string): Record<string, unknown> {
  const parsed = YAML.parse(content);
  if (parsed == null || typeof parsed !== 'object') return {};
  return parsed as Record<string, unknown>;
}
