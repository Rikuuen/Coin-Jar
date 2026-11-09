import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { decryptArchive } from './recovery';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
let line = '';
for await (const item of input) { line = item; break; }
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.pause();
const archive = decryptArchive(await readFile('C:/Users/enric/Downloads/coinjar-recovery-drill-60ff086323d5.enc'), Buffer.from(line, 'base64'));
if (!archive.owner.startsWith('synthetic-recovery-')) throw new Error('Only synthetic data is allowed');
console.log('SYNTHETIC_ARCHIVE ' + JSON.stringify(archive));
