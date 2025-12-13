'use strict';

// This repo is "type": "module", so r2g loads this file as ESM.
// Keep it dependency-free (built-in modules only) and avoid CommonJS `require`.

import * as path from 'node:path';

const searchRoot = path.resolve(process.env.MY_DOCKER_R2G_SEARCH_ROOT || process.env.HOME || process.cwd());

export default {
  searchRoot,
  tests: '',
  packages: {}
};
