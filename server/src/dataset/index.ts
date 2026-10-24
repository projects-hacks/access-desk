import { platform } from '../config/platform';
import { buildDataset } from './build';
import { validateDataset } from './validate';

export type * from './types';

/** The demo world, built deterministically. Throws if the story doesn't add up. */
export function loadDataset() {
  const ds = buildDataset(platform);
  const problems = validateDataset(ds);
  if (problems.length) throw new Error(`Dataset is inconsistent:\n- ${problems.join('\n- ')}`);
  return ds;
}
