import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const path = join(dshHome, 'model-pk/v1/control/compatibility-report.json')
const report = JSON.parse(await readFile(path, 'utf8'))
console.log(JSON.stringify(report, null, 2))
if (report?.report?.executionEnabled !== true) process.exitCode = 2
