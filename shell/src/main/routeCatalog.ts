/**
 * Loads the route catalogs (ROUTE_CATALOGS, default parivahan.UP.json) at
 * boot. Relative paths are tried against the app folder, its parent (the repo
 * root in development) and the working directory. A missing or invalid file
 * is logged and skipped: the agent then works without routes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseCatalog, type RouteService } from '../agent/routes';
import type { LoggerPort } from '../agent/types';

export function catalogCandidates(file: string, appPath: string, cwd: string = process.cwd()): string[] {
  if (isAbsolute(file)) return [file];
  return [...new Set([resolve(appPath, file), resolve(appPath, '..', file), resolve(cwd, file)])];
}

export function loadRouteCatalogs(files: string[], appPath: string, logger: LoggerPort): RouteService[] {
  const services: RouteService[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = catalogCandidates(file, appPath).find((p) => existsSync(p));
    if (!path) {
      logger.warn('routes', 'catalog not found', { file });
      continue;
    }
    try {
      const { services: parsed, skipped } = parseCatalog(JSON.parse(readFileSync(path, 'utf8')));
      for (const service of parsed) {
        if (seen.has(service.id)) continue;
        seen.add(service.id);
        services.push(service);
      }
      logger.info('routes', 'catalog loaded', { path, services: parsed.length, skipped });
    } catch (error) {
      logger.warn('routes', 'catalog unreadable', { path, error: String(error) });
    }
  }
  return services;
}
