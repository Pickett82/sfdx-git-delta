'use strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import GitAdapter from '../../src/adapter/GitAdapter'
import sgd from '../../src/main'
import type { ConfigInput } from '../../src/types/config'
import { IgnoreHelper } from '../../src/utils/ignoreHelper'
import { createTempDir, runGit, runGitText } from '../__utils__/gitTestHarness'

const LABELS = 'force-app/main/default/labels/CustomLabels.labels-meta.xml'
const DECOMPOSED = 'force-app/main/default/labels/Decomposed.label-meta.xml'
const WORKFLOW = 'force-app/main/default/workflows/Account.workflow-meta.xml'
const labels = (names: string[], value = 'original') =>
  `<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">${names
    .map(
      name =>
        `<labels><fullName>${name}</fullName><language>en_US</language><protected>false</protected><shortDescription>${name}</shortDescription><value>${value}</value></labels>`
    )
    .join('')}</CustomLabels>`
const workflow = (names: string[]) =>
  `<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">${names
    .map(
      name =>
        `<alerts><fullName>${name}</fullName><description>${name}</description><protected>false</protected><template>unfiled$public/Test</template></alerts>`
    )
    .join('')}</Workflow>`

let repo: string
let from: string
let to: string
let runNumber: number
const put = async (path: string, content: string) => {
  await mkdir(dirname(join(repo, path)), { recursive: true })
  await writeFile(join(repo, path), content)
}
const commit = (message: string) => {
  runGit(['add', '.'], { cwd: repo })
  runGit(['commit', '-qm', message], { cwd: repo })
  return runGitText(['rev-parse', 'HEAD'], { cwd: repo })
}
const reset = async () => {
  await GitAdapter.closeAll()
  IgnoreHelper.resetIgnoreInstance()
  IgnoreHelper.resetIncludeInstance()
}
const run = async (overrides: Partial<ConfigInput> = {}) => {
  await reset()
  const output = join(repo, `output-${runNumber++}`)
  const work = await sgd({
    repo,
    from,
    to,
    output,
    source: ['force-app'],
    apiVersion: 67,
    mergeBase: false,
    ignoreWhitespace: false,
    generateDelta: true,
    ...overrides,
  })
  expect(work.warnings).toEqual([])
  return {
    work,
    output,
    packageXml: await readFile(join(output, 'package/package.xml'), 'utf8'),
    destructiveXml: await readFile(
      join(output, 'destructiveChanges/destructiveChanges.xml'),
      'utf8'
    ),
  }
}

beforeEach(async () => {
  repo = await createTempDir('sgd-infile-ignore-')
  runNumber = 0
  runGit(['init', '-q'], { cwd: repo })
  await put(LABELS, labels(['KeepMe', 'DeleteMe']))
  await put(
    DECOMPOSED,
    '<CustomLabel xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Decomposed</fullName><value>original</value></CustomLabel>'
  )
  await put(WORKFLOW, workflow(['OldAlert']))
  from = commit('baseline')
  await put(LABELS, labels(['KeepMe', 'AddedMe'], 'changed'))
  await rm(join(repo, DECOMPOSED))
  await put(WORKFLOW, workflow(['NewAlert']))
  to = commit('add, modify and delete children')
}, 30_000)

afterEach(async () => {
  await reset()
  await rm(repo, { recursive: true, force: true })
})

describe('in-file destructive ignore', () => {
  it.each([false, true])(
    'suppresses label deletions and retains additions/modifications with generateDelta=%s',
    async generateDelta => {
      await put('.destructiveignore', LABELS)
      expect(
        runGitText(['diff', '--name-status', from, to, '--', LABELS], {
          cwd: repo,
        })
      ).toBe(`M\t${LABELS}`)
      const result = await run({
        ignoreDestructive: join(repo, '.destructiveignore'),
        generateDelta,
        changesManifest: join(repo, 'changes.json'),
      })
      expect(result.packageXml).toContain('<members>AddedMe</members>')
      expect(result.packageXml).toContain('<members>KeepMe</members>')
      expect(result.destructiveXml).not.toContain('<members>DeleteMe</members>')
      expect(result.destructiveXml).toContain('<members>Decomposed</members>')
      expect(result.destructiveXml).toContain(
        '<members>Account.OldAlert</members>'
      )
      const changes = JSON.parse(
        await readFile(join(repo, 'changes.json'), 'utf8')
      )
      expect(changes.add.CustomLabel).toContain('AddedMe')
      expect(changes.modify.CustomLabel).toContain('KeepMe')
      expect(changes.delete.CustomLabel).toEqual(['Decomposed'])
      const deltaPath = join(result.output, LABELS)
      expect(existsSync(deltaPath)).toBe(generateDelta)
      if (generateDelta) {
        const delta = await readFile(deltaPath, 'utf8')
        expect(delta).toContain('<fullName>AddedMe</fullName>')
        expect(delta).toContain('<fullName>KeepMe</fullName>')
        expect(delta).not.toContain('DeleteMe')
      }
    }
  )

  it('retains child deletions for an unrelated destructive pattern', async () => {
    await put('.destructiveignore', 'force-app/main/default/classes/**')
    const result = await run({
      ignoreDestructive: join(repo, '.destructiveignore'),
    })
    expect(result.destructiveXml).toContain('<members>DeleteMe</members>')
  })

  it('global ignore suppresses all changes from the aggregate file', async () => {
    await put('.ignore', LABELS)
    const result = await run({ ignore: join(repo, '.ignore') })
    expect(result.packageXml).not.toContain('AddedMe')
    expect(result.packageXml).not.toContain('KeepMe')
    expect(result.destructiveXml).not.toContain('DeleteMe')
    expect(existsSync(join(result.output, LABELS))).toBe(false)
  })

  it('preserves decomposed deletion filtering and applies the same rule to Workflow children', async () => {
    await put('.destructiveignore', `${DECOMPOSED}\n${WORKFLOW}`)
    const result = await run({
      ignoreDestructive: join(repo, '.destructiveignore'),
    })
    expect(result.destructiveXml).not.toContain('Decomposed')
    expect(result.destructiveXml).not.toContain('Account.OldAlert')
    expect(result.destructiveXml).toContain('DeleteMe')
    expect(result.packageXml).toContain('<members>Account.NewAlert</members>')
    expect(result.packageXml).toContain('<name>Workflow</name>')
    expect(await readFile(join(result.output, WORKFLOW), 'utf8')).toContain(
      '<fullName>NewAlert</fullName>'
    )
  })

  it('retains additions when both ignore files and an include file are supplied', async () => {
    await put('.ignore', 'force-app/main/default/classes/**')
    await put('.destructiveignore', LABELS)
    await put('.include', WORKFLOW)
    const result = await run({
      ignore: join(repo, '.ignore'),
      ignoreDestructive: join(repo, '.destructiveignore'),
      include: join(repo, '.include'),
    })
    expect(result.packageXml).toContain('AddedMe')
    expect(result.packageXml).toContain('KeepMe')
    expect(result.destructiveXml).not.toContain('DeleteMe')
  })

  it('suppresses delete-only label changes without emitting package content or delta source', async () => {
    await put(LABELS, labels(['KeepMe']))
    to = commit('delete only')
    await put('.destructiveignore', LABELS)
    const result = await run({
      ignoreDestructive: join(repo, '.destructiveignore'),
    })
    expect(result.packageXml).not.toContain('<name>CustomLabel</name>')
    expect(result.destructiveXml).not.toContain('DeleteMe')
    expect(existsSync(join(result.output, LABELS))).toBe(false)
  })
})
