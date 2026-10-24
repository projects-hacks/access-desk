import { env } from '../lib/env';

/** Platform identity. Rename the platform via PLATFORM_NAME / PLATFORM_LEGAL_NAME. */
export const platform = {
  name: env.PLATFORM_NAME,
  legalName: env.PLATFORM_LEGAL_NAME,
};
