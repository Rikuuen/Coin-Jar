import { randomBytes } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error('Provide an absolute path for a new offline recovery key file.');
const parent = await realpath(dirname(destination));
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const target = resolve(parent, destination.split(/[\\/]/).at(-1));
const inside = relative(workspace.toLowerCase(), target.toLowerCase());
if (!inside || (!inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside))) throw new Error('Choose a location outside the CoinJar workspace.');
await writeFile(target, randomBytes(32).toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Recovery key file created. Store it securely offline; anyone with it can decrypt your backups.');
