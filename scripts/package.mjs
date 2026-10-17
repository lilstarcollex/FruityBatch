import {spawn} from 'node:child_process';
import path from 'node:path';
// Portable uses LZMA level 9 by default. Level 3 avoids a long build and improves
// unpacking time while retaining a compressed, self-contained executable.
const child=spawn(process.execPath,[path.resolve('node_modules/electron-builder/out/cli/cli.js'),'--win','portable'],{stdio:'inherit',windowsHide:true,env:{...process.env,ELECTRON_BUILDER_COMPRESSION_LEVEL:'3'}});
child.on('exit',code=>process.exit(code??1));child.on('error',error=>{console.error(error);process.exit(1);});
