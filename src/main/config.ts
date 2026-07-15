import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { selectDevelopmentServerUrl } from './security.js';

const applicationEnvironmentSchema = z.object({
  viteDevelopmentServerUrl: z.string().min(1).optional(),
  dfuUtilPath: z.string().trim().min(1).optional(),
  executableSearchPath: z.string(),
}).strict();

export interface ApplicationConfig {
  readonly developmentServerUrl?: URL;
  readonly dfuUtilPath?: string;
  readonly executableSearchPath: string;
}

/** Parses every supported environment input once at the composition root. */
export function loadApplicationConfig(environment: NodeJS.ProcessEnv, isPackaged: boolean): ApplicationConfig {
  const input = applicationEnvironmentSchema.parse({
    ...(environment.VITE_DEV_SERVER_URL === undefined ? {} : { viteDevelopmentServerUrl: environment.VITE_DEV_SERVER_URL }),
    ...(environment.TINYSA_DFU_UTIL === undefined ? {} : { dfuUtilPath: environment.TINYSA_DFU_UTIL }),
    executableSearchPath: environment.PATH ?? '',
  });
  if (input.dfuUtilPath && !isAbsolute(input.dfuUtilPath)) {
    throw new Error('TINYSA_DFU_UTIL must be an absolute executable path');
  }
  const developmentServerUrl = selectDevelopmentServerUrl(input.viteDevelopmentServerUrl, isPackaged);
  return Object.freeze({
    ...(developmentServerUrl ? { developmentServerUrl } : {}),
    ...(input.dfuUtilPath ? { dfuUtilPath: input.dfuUtilPath } : {}),
    executableSearchPath: input.executableSearchPath,
  });
}
