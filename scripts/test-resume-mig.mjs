// Old v1.1 journal reuse is deliberately forbidden; covered by archive.test.mjs.
import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['--test','--test-name-pattern=Legacy journals','tests/archive.test.mjs'],{stdio:'inherit'});
process.exit(result.status??1);
