import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { listPackage } from '@electron/asar'

const MAX_PACKAGE_FILES = 100_000
const SECRET_FILE_NAMES = new Set([
  'provider-credentials.json',
  'auth.json',
  'credentials.json',
])

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function isEnvironmentFile(path) {
  const name = basename(path).toLowerCase()
  return name === '.env' || name.startsWith('.env.')
}

function isTestFile(path) {
  return /(^|\/)[^/]+\.test\.[^/]+$/i.test(normalizePath(path))
}

export function verifyDesktopPackageFiles(files, {
  platform = process.platform,
  productName = 'BioResearch OS',
  linuxExecutableName = 'bioresearch-os',
  archiveFiles = [],
} = {}) {
  const normalized = files.map(normalizePath).filter(Boolean)
  const normalizedArchive = archiveFiles.map(normalizePath).filter(Boolean)
  const lower = normalized.map((path) => path.toLowerCase())
  const errors = []

  if (!lower.some((path) => path.endsWith('/resources/app.asar') || path === 'resources/app.asar')) {
    errors.push('Packaged application is missing resources/app.asar.')
  }

  const expectedExecutable = platform === 'win32'
    ? `${productName}.exe`.toLowerCase()
    : platform === 'darwin'
      ? `/contents/macos/${productName}`.toLowerCase()
      : linuxExecutableName.toLowerCase()
  const hasExecutable = platform === 'darwin'
    ? lower.some((path) => path.endsWith(expectedExecutable))
    : lower.some((path) => basename(path) === expectedExecutable)
  if (!hasExecutable) errors.push(`Packaged application is missing its ${platform} executable.`)

  const forbidden = [...normalized, ...normalizedArchive].filter((path) => {
    const name = basename(path).toLowerCase()
    return isEnvironmentFile(path) || SECRET_FILE_NAMES.has(name)
  })
  if (forbidden.length) errors.push(`Sensitive local files are present: ${forbidden.join(', ')}`)
  const bundledTests = normalizedArchive.filter(isTestFile)
  if (bundledTests.length) errors.push(`Test files are present in app.asar: ${bundledTests.join(', ')}`)

  if (errors.length) throw new Error(errors.join(' '))
  return Object.freeze({ ok: true, platform, fileCount: normalized.length })
}

async function listPackageFiles(rootDir) {
  const root = resolve(rootDir)
  const rootStats = await stat(root)
  if (!rootStats.isDirectory()) throw new Error('Desktop package path must be a directory.')
  const pending = [root]
  const files = []
  while (pending.length) {
    const current = pending.pop()
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'))
      if (files.length > MAX_PACKAGE_FILES) throw new Error(`Desktop package exceeds ${MAX_PACKAGE_FILES} files.`)
    }
  }
  return files
}

function defaultPackagePath(platform) {
  if (platform === 'win32') return 'release/win-unpacked'
  if (platform === 'darwin') return 'release/mac'
  return 'release/linux-unpacked'
}

export async function verifyDesktopPackage(rootDir = defaultPackagePath(process.platform), options = {}) {
  const files = await listPackageFiles(rootDir)
  const archive = files.find((path) => {
    const normalized = normalizePath(path).toLowerCase()
    return normalized === 'resources/app.asar' || normalized.endsWith('/resources/app.asar')
  })
  const archiveFiles = archive ? listPackage(join(resolve(rootDir), archive)) : []
  return verifyDesktopPackageFiles(files, { ...options, archiveFiles })
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  const rootDir = process.argv[2] || defaultPackagePath(process.platform)
  verifyDesktopPackage(rootDir).then((result) => {
    console.log(`Desktop package verified: ${result.fileCount} files (${result.platform}).`)
  }).catch((error) => {
    console.error(`Desktop package verification failed: ${error.message}`)
    process.exitCode = 1
  })
}
