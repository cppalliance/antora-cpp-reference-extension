/*
    Copyright (c) 2024 Alan de Freitas (alandefreitas@gmail.com)

    Distributed under the Boost Software License, Version 1.0. (See accompanying
    file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)

    Official repository: https://github.com/alandefreitas/antora-cpp-tagfiles-extension
*/

'use strict'

const test = require("node:test");
const {describe, it} = test;
const {ok, strictEqual, deepStrictEqual} = require("node:assert");
const {createHash} = require('node:crypto')

const fs = require('fs');
const {promises: fsp} = fs
const CppReference = require('../lib/extension.js');
const path = require('path');
const yaml = require("js-yaml");
const TAGFILE_REGISTRY_STORE_SYMBOL = Symbol.for('cppReferenceTagfileRegistryStore')

class RegistryConsumerStub {
    constructor(playbook) {
        this.playbook = playbook
        this.tagfiles = []
    }

    load() {
        const store = globalThis[TAGFILE_REGISTRY_STORE_SYMBOL]
        let registry =
            this.playbook?.runtime?.cppReferenceTagfileRegistry ||
            (store && (store.byObject.get(this.playbook) ||
                store.byObject.get(this.playbook.runtime) ||
                store.byDir.get(this.playbook.dir)))
        if (!registry) return
        this.tagfiles = registry.entries.map((entry) => ({
            file: entry.tagfilePath,
            module: entry.module,
            docRootUrl: entry.docRootUrl,
            relativePath: entry.relativePath,
            component: entry.component
        }))
    }
}

class generatorContext {
    constructor() {
        this.attributes = {}
    }

    on(eventName, handler) {
        ok(eventName === 'contentAggregated' || eventName === 'beforeProcess' || eventName === 'contentClassified')
        if (!this.handlers) {
            this.handlers = {}
        }
        if (!this.handlers[eventName]) {
            this.handlers[eventName] = []
        }
        this.handlers[eventName].push(handler)
    }

    once(eventName, Function) {
        ok(eventName === 'contentAggregated')
    }

    getLogger(name) {
        ok(name === 'cpp-reference-extension' || name === 'cpp-tagfile-extension')
        const noop = () => {
        }
        return {trace: noop, debug: noop, info: noop, warn: noop, error: noop}
    }
}

async function withPatchedEnv(vars, fn) {
    const backup = {}
    const keys = Object.keys(vars)
    for (const key of keys) {
        backup[key] = process.env[key]
        const value = vars[key]
        if (value === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = value
        }
    }
    try {
        return await fn()
    } finally {
        for (const key of keys) {
            if (backup[key] === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = backup[key]
            }
        }
    }
}

describe('C++ Reference Extension', () => {
    const fixturesDir = path.join(__dirname, 'fixtures')

    // ============================================================
    // Iterate fixtures and run tests
    // ============================================================
    for (const fixture of fs.readdirSync(fixturesDir)) {
        const fixtureDir = path.join(fixturesDir, fixture)
        if (!fs.statSync(fixtureDir).isDirectory()) {
            continue
        }
        test(fixture, () => {
            const playbookFile = path.join(fixtureDir, 'playbook.yml')
            ok(fs.existsSync(playbookFile), `Fixture ${fixture} is missing playbook.yml`)
            ok(fs.statSync(playbookFile).isFile(), `Fixture ${fixture} has a non-file playbook.yml`)
            const playbookContents = fs.readFileSync(playbookFile, 'utf8')
            const playbook = normalizePlaybook(yaml.load(playbookContents), fixtureDir)
            ok(playbook, `Fixture ${fixture} has an invalid playbook.yml`)
            const config = playbook.antora.extensions.find(extension => extension.require === '@alandefreitas/antora-cpp-reference-extension')
            ok(config, `Fixture ${fixture} is missing the extension @alandefreitas/antora-cpp-reference-extension`)
            const context = new generatorContext();
            const extension = new CppReference(context, {config, playbook})
            ok(extension, `Fixture ${fixture} failed to create the extension`)
            const contentAggregate = {}
            // TODO: extension.onContentAggregated({playbook, siteAsciiDocConfig: {}, siteCatalog: {}, contentAggregate})
        })
    }
});

// Ensures a registry survives repeated ensureTagfileRegistry calls.
test('ensureTagfileRegistry creates persistent registry snapshot', async () => {
    const logger = new generatorContext().getLogger('cpp-reference-extension')
    const playbook = {runtime: {}}
    const registry = CppReference.ensureTagfileRegistry(playbook, logger)
    ok(registry, 'Registry should be created')
    strictEqual(playbook.runtime.cppReferenceTagfileRegistry, registry)
    registry.registerProducer('reference')
    const waitPromise = registry.waitFor('reference')
    registry.finalize('reference')
    await waitPromise
    const reused = CppReference.ensureTagfileRegistry(playbook, logger)
    strictEqual(reused, registry, 'Existing registry should be reused')
})

// Ensures read-only runtime objects fall back to the global registry store.
test('ensureTagfileRegistry stores registry when runtime is not extensible', () => {
    const logger = new generatorContext().getLogger('cpp-reference-extension')
    const playbook = {}
    Object.defineProperty(playbook, 'runtime', {value: {}, writable: false, configurable: false})
    Object.preventExtensions(playbook.runtime)
    const registry = CppReference.ensureTagfileRegistry(playbook, logger)
    ok(registry, 'Registry should exist even when runtime is not extensible')
    const store = globalThis[TAGFILE_REGISTRY_STORE_SYMBOL]
    strictEqual(store.byObject.get(playbook), registry, 'Registry should be stored in the global WeakMap')
})

// Ensures frozen runtime objects also fall back to the global registry store.
test('ensureTagfileRegistry clones frozen runtime objects', () => {
    const logger = new generatorContext().getLogger('cpp-reference-extension')
    const playbook = {runtime: {}}
    Object.freeze(playbook.runtime)
    const registry = CppReference.ensureTagfileRegistry(playbook, logger)
    ok(registry, 'Registry should be created even when runtime is frozen')
    const store = globalThis[TAGFILE_REGISTRY_STORE_SYMBOL]
    strictEqual(store.byObject.get(playbook), registry, 'Frozen runtime should fall back to the global WeakMap')
})

// Ensures registry entries contain the expected metadata defaults.
test('recordTagfileMetadata publishes registry entry with defaults', () => {
    const context = new generatorContext()
    const playbook = {runtime: {}}
    const extension = new CppReference(context, {config: {}, playbook})
    const published = []
    extension.tagfileRegistry = {
        publish(entry) {
            published.push(entry)
        }
    }
    extension.MrDocsVersion = 'v1.2.3'
    extension.recordTagfileMetadata(
        {name: 'sample', version: '1.0.0'},
        'reference',
        {absolutePath: '/tmp/reference/reference.tag.xml', relativePath: 'reference/reference.tag.xml', checksum: 'abc', size: 42}
    )
    strictEqual(published.length, 1, 'Should publish a single entry')
    const entry = published[0]
    strictEqual(entry.component, 'sample')
    strictEqual(entry.module, 'reference')
    strictEqual(entry.docRootUrl, 'xref:reference:')
    strictEqual(entry.mrdocsVersion, 'v1.2.3')
    strictEqual(entry.tagfilePath, '/tmp/reference/reference.tag.xml')
})

test('parseMrDocsVersionFromOutput handles patched MrDocs version strings', () => {
    const patched = 'MrDocs version 0.8.0+45571ab5219b.modified'
    const {raw, tag} = CppReference.parseMrDocsVersionFromOutput(patched)
    strictEqual(raw, '0.8.0+45571ab5219b.modified')
    strictEqual(tag, '0.8.0')

    const unmodified = 'MrDocs version 0.9.1'
    const plain = CppReference.parseMrDocsVersionFromOutput(unmodified)
    strictEqual(plain.raw, '0.9.1')
    strictEqual(plain.tag, '0.9.1')

    const colon = 'version: 1.2.3+abc123.dirty'
    const parsed = CppReference.parseMrDocsVersionFromOutput(colon)
    strictEqual(parsed.raw, '1.2.3+abc123.dirty')
    strictEqual(parsed.tag, '1.2.3')
})

test('resolveReferenceAncestors walks nested index.adoc hierarchy', () => {
    const recorded = new Set(['index.adoc', 'boost/index.adoc', 'boost/url/index.adoc', 'boost/url/url_view.adoc'])
    const ancestors = CppReference.resolveReferenceAncestors('boost/url/url_view.adoc', recorded)
    deepStrictEqual(ancestors, ['index.adoc', 'boost/index.adoc', 'boost/url/index.adoc'])
})

test('resolveReferenceAncestors includes root index for sibling pages', () => {
    const recorded = new Set(['index.adoc', 'distance.adoc'])
    const ancestors = CppReference.resolveReferenceAncestors('distance.adoc', recorded)
    deepStrictEqual(ancestors, ['index.adoc'])
})

test('assignSyntheticBreadcrumbs composes component and ancestor trail', () => {
    const component = {title: 'Reference', url: '/reference/index.html'}
    const makePage = (relative, title, url) => ({
        src: {relative, component: 'reference', module: 'reference'},
        component,
        title,
        pub: {url}
    })
    const recorded = new Set(['index.adoc', 'boost/index.adoc', 'boost/url/index.adoc', 'boost/url/url_view.adoc'])
    const pageMap = new Map([
        ['index.adoc', makePage('index.adoc', 'Reference', '/reference/index.html')],
        ['boost/index.adoc', makePage('boost/index.adoc', 'boost namespace', '/reference/boost/index.html')],
        ['boost/url/index.adoc', makePage('boost/url/index.adoc', 'boost::url overview', '/reference/boost/url/index.html')],
        ['boost/url/url_view.adoc', makePage('boost/url/url_view.adoc', 'url_view', '/reference/boost/url/url_view.html')]
    ])
    CppReference.assignSyntheticBreadcrumbs(recorded, pageMap)
    const target = pageMap.get('boost/url/url_view.adoc')
    deepStrictEqual(target.breadcrumbs, [
        {content: 'Reference', url: '/reference/reference/index.html', urlType: 'internal'},
        {content: 'boost namespace', url: '/reference/reference/boost/index.html', urlType: 'internal'},
        {content: 'boost::url overview', url: '/reference/reference/boost/url/index.html', urlType: 'internal'},
        {content: 'url_view', url: '/reference/reference/boost/url/url_view.html', urlType: 'internal'}
    ])
})

test('removeSymlinks drops every symlink outside .git and keeps files', async () => {
    const os = require('node:os')
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cppref-symlinks-'))
    try {
        await fsp.mkdir(path.join(dir, 'docs', 'partials'), {recursive: true})
        await fsp.mkdir(path.join(dir, '.git'), {recursive: true})
        await fsp.writeFile(path.join(dir, 'docs', 'file.txt'), 'kept')
        await fsp.symlink('../file.txt', path.join(dir, 'docs', 'partials', 'link.json'))
        await fsp.symlink('docs', path.join(dir, 'top-link'))
        await fsp.symlink('nowhere', path.join(dir, '.git', 'keep-link'))

        await CppReference.removeSymlinks(dir)

        const lstatOrNull = (p) => fsp.lstat(p).catch(() => null)
        strictEqual(await lstatOrNull(path.join(dir, 'docs', 'partials', 'link.json')), null)
        strictEqual(await lstatOrNull(path.join(dir, 'top-link')), null)
        ok((await fsp.lstat(path.join(dir, 'docs', 'file.txt'))).isFile())
        ok((await fsp.lstat(path.join(dir, '.git', 'keep-link'))).isSymbolicLink())
        ok((await fsp.lstat(path.join(dir, 'docs'))).isDirectory())
    } finally {
        await fsp.rm(dir, {recursive: true, force: true})
    }
})

test('normalizeReferenceRelativePath strips module prefix', () => {
    strictEqual(
        CppReference.normalizeReferenceRelativePath('modules/reference/pages/boost/url/index.adoc', 'reference'),
        'boost/url/index.adoc'
    )
    strictEqual(
        CppReference.normalizeReferenceRelativePath('modules/api-ref/pages/index.adoc', 'api-ref'),
        'index.adoc'
    )
})

test('resolveAutoBaseUrl prefers verified commit when available', async () => {
    const context = new generatorContext()
    const playbook = {runtime: {}}
    const extension = new CppReference(context, {config: {autoBaseUrl: true}, playbook})
    extension.readGitOutput = async () => null
    extension.fetchGitRemoteRefs = async () => ({
        hashes: new Set(['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']),
        refs: new Set(['refs/heads/main'])
    })
    await withPatchedEnv({
        GITHUB_REPOSITORY: 'owner/project',
        GITHUB_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_EVENT_PATH: undefined
    }, async () => {
        const baseUrl = await extension.resolveAutoBaseUrl({
            origin: {url: 'https://github.com/owner/project.git'},
            worktreeDir: '/tmp/nowhere'
        })
        strictEqual(baseUrl, 'https://github.com/owner/project/blob/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/')
    })
})

test('resolveAutoBaseUrl falls back to verified branch when commit cannot be confirmed', async () => {
    const context = new generatorContext()
    const playbook = {runtime: {}}
    const extension = new CppReference(context, {config: {autoBaseUrl: true}, playbook})
    extension.readGitOutput = async () => null
    extension.fetchGitRemoteRefs = async () => ({
        hashes: new Set(),
        refs: new Set(['refs/heads/develop'])
    })
    await withPatchedEnv({
        GITHUB_REPOSITORY: 'owner/project',
        GITHUB_SHA: 'missing',
        GITHUB_REF_NAME: 'develop',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_EVENT_PATH: undefined
    }, async () => {
        const baseUrl = await extension.resolveAutoBaseUrl({
            origin: {url: 'https://github.com/owner/project.git'},
            worktreeDir: '/tmp/nowhere'
        })
        strictEqual(baseUrl, 'https://github.com/owner/project/blob/develop/')
    })
})

test('generateMrDocsArgs appends base-url when auto detection succeeds', async () => {
    const context = new generatorContext()
    const playbook = {runtime: {}}
    const extension = new CppReference(context, {config: {}, playbook})
    extension.resolveAutoBaseUrl = async () => 'https://github.com/owner/project/blob/main/'
    const args = await extension.generateMrDocsArgs('doc/mrdocs.yml', '/tmp/reference', {
        autoBaseUrlEnabled: true,
        origin: {url: 'https://github.com/owner/project.git'},
        worktreeDir: '/tmp/nowhere'
    })
    ok(args.includes('--base-url=https://github.com/owner/project/blob/main/'))
})

// The integration test emulates an Antora run where the reference extension
// publishes a generated tagfile and a registry consumer reads it back.
test('reference and tagfiles extensions cooperate via registry', async () => {
    const fixtureDir = path.join(__dirname, 'fixtures', 'with-tagfiles')
    const playbookFile = path.join(fixtureDir, 'playbook.yml')
    const playbook = normalizePlaybook(yaml.load(fs.readFileSync(playbookFile, 'utf8')), fixtureDir)
    playbook.runtime.cacheDir = path.join(fixtureDir, '.cache')
    const componentDir = path.join(fixtureDir, 'component')
    const descriptor = yaml.load(fs.readFileSync(path.join(componentDir, 'antora.yml'), 'utf8'))
    const componentVersionBucket = {
        name: descriptor.name,
        version: descriptor.version,
        files: [],
        origins: [{
            descriptor,
            url: componentDir,
            gitdir: componentDir,
            refname: 'main',
            reftype: 'branch',
            remote: 'origin',
            startPath: '.',
            worktree: componentDir
        }]
    }
    const contentAggregate = [componentVersionBucket]
    const context = new generatorContext()
    const config = playbook.antora.extensions.find((extension) => extension.require === '@alandefreitas/antora-cpp-reference-extension')
    config.module = 'api-ref'
    const referenceExtension = new CppReference(context, {config, playbook})
    // Avoid cloning/downloading during tests; fixtures already contain the required files.
    referenceExtension.setupDependencies = async () => {}
    referenceExtension.setupMrDocs = async () => {
        referenceExtension.MrDocsExecutable = 'stub-mrdocs'
        referenceExtension.MrDocsVersion = '0.0.0-test'
    }
    const stubOutputDir = path.join(fixtureDir, 'reference-output')
    referenceExtension.runCommand = async (_cmd, argv) => {
        const outputArg = argv.find((arg) => arg.startsWith('--output='))
        ok(outputArg, 'MrDocs arguments should include --output')
        const outputDir = outputArg.slice('--output='.length)
        await fsp.rm(outputDir, {recursive: true, force: true})
        await fsp.mkdir(outputDir, {recursive: true})
        await fsp.cp(stubOutputDir, outputDir, {recursive: true})
    }
    await referenceExtension.onContentAggregated({playbook, siteAsciiDocConfig: {}, siteCatalog: {}, contentAggregate})
    const registry = playbook.runtime.cppReferenceTagfileRegistry
    ok(registry, 'Registry should exist after reference extension runs')
    const entry = registry.entries.find((it) => it.component === descriptor.name)
    ok(entry, 'Registry should include the demo component')
    strictEqual(entry.module, 'api-ref')
    strictEqual(entry.docRootUrl, 'xref:api-ref:')
    ok(fs.existsSync(entry.tagfilePath), 'Generated tagfile path should exist')

    // Run the tagfiles extension against the same playbook so it reads the registry entry.
    const consumer = new RegistryConsumerStub(playbook)
    consumer.load()
    const generatedTagfile = consumer.tagfiles.find((tf) => tf.file === entry.tagfilePath)
    ok(generatedTagfile, 'Registry consumer should import registry-provided tagfile')
    strictEqual(generatedTagfile.module, 'api-ref')
    strictEqual(generatedTagfile.docRootUrl, 'xref:api-ref:')
})

function normalizePlaybook(playbook, playbookDir) {
    if (!playbook) {
        return playbook
    }

    // Playbook carries its own directory
    playbook.dir = playbookDir

    // Branches
    if (!'content' in playbook) {
        playbook.content = {}
        if (!'branches' in playbook.content) {
            playbook.content.branches = [
                "HEAD",
                "v{0..9}*"
            ]
        }
    }

    // Extensions are objects
    if (!'antora' in playbook) {
        playbook.antora = {}
        if (!'extensions' in playbook.antora) {
            playbook.antora.extensions = []
        }
    }
    playbook.antora.extensions = playbook.antora.extensions.map(extension => {
        if (typeof extension === 'string') {
            return {require: extension}
        }
        return extension
    })


    // Extra fields
    playbook.network = {}
    playbook.runtime = {
        fetch: true,
        quiet: false,
        silent: false,
        log: {
            level: "all",
            levelFormat: "label",
            failureLevel: "fatal",
            format: "pretty"
        }
    }
    playbook.urls = {
        htmlExtensionStyle: "default",
        redirectFacility: "static"
    }
    playbook.output = {
        clean: false
    }

    return playbook
}

// ============================================================
// Skip mode
// ============================================================

// A minimal context the skip-mode code path needs: only the logger
// matters since the skip branch never registers event handlers (it
// just sets state on the extension instance) and the
// onContentAggregated tests below invoke the handler directly.
class SkipModeContext {
    on() {}
    once() {}
    getLogger() {
        const noop = () => {}
        return {trace: noop, debug: noop, info: noop, warn: noop, error: noop}
    }
}

function makeSkipExtension({config = {}, playbook = {}} = {}) {
    return new CppReference(new SkipModeContext(), {config, playbook})
}

test('skip mode: source=playbook when config.skip is true', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: undefined}, () => {
        const extension = makeSkipExtension({config: {skip: true}})
        strictEqual(extension.skipReference, true)
        strictEqual(extension.skipReferenceSource, 'playbook')
    })
})

test('skip mode: source=cli when --attribute skip-cpp-reference is set', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: undefined}, () => {
        const playbook = {asciidoc: {attributes: {'skip-cpp-reference': ''}}}
        const extension = makeSkipExtension({playbook})
        strictEqual(extension.skipReference, true)
        strictEqual(extension.skipReferenceSource, 'cli')
    })
})

test('skip mode: source=cli accepts explicit truthy attribute value', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: undefined}, () => {
        const playbook = {asciidoc: {attributes: {'skip-cpp-reference': 'true'}}}
        const extension = makeSkipExtension({playbook})
        strictEqual(extension.skipReferenceSource, 'cli')
    })
})

test('skip mode: CLI attribute=false does not enable skip', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: undefined}, () => {
        const playbook = {asciidoc: {attributes: {'skip-cpp-reference': 'false'}}}
        const extension = makeSkipExtension({playbook})
        strictEqual(extension.skipReference, false)
        strictEqual(extension.skipReferenceSource, null)
    })
})

test('skip mode: source=env when ANTORA_SKIP_CPP_REFERENCE is truthy', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: '1'}, () => {
        const extension = makeSkipExtension()
        strictEqual(extension.skipReference, true)
        strictEqual(extension.skipReferenceSource, 'env')
    })
})

test('skip mode: env values "0"/"false"/"" do not enable skip', async () => {
    for (const value of ['0', 'false', 'no', 'off', '']) {
        await withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: value}, () => {
            strictEqual(makeSkipExtension().skipReference, false, `value="${value}" should not enable skip`)
        })
    }
})

test('skip mode: playbook config wins over CLI attribute and env', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: '1'}, () => {
        const playbook = {asciidoc: {attributes: {'skip-cpp-reference': '1'}}}
        const extension = makeSkipExtension({config: {skip: true}, playbook})
        strictEqual(extension.skipReferenceSource, 'playbook')
    })
})

test('skip mode: CLI attribute wins over env when config does not request skip', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: '1'}, () => {
        const playbook = {asciidoc: {attributes: {'skip-cpp-reference': '1'}}}
        const extension = makeSkipExtension({playbook})
        strictEqual(extension.skipReferenceSource, 'cli')
    })
})

test('skip mode: no signal leaves skipReference false', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: undefined}, () => {
        const extension = makeSkipExtension()
        strictEqual(extension.skipReference, false)
        strictEqual(extension.skipReferenceSource, null)
    })
})

test('skip mode: onContentAggregated drops modules/reference files and adds placeholder', async () => {
    await withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: '1'}, async () => {
        const extension = makeSkipExtension()
        const bucket = {
            name: 'demo',
            version: '1.0',
            origins: [{type: 'git', refname: 'main'}],
            files: [
                {path: 'modules/ROOT/pages/index.adoc', src: {path: 'modules/ROOT/pages/index.adoc'}},
                {path: 'modules/reference/pages/foo.adoc', src: {path: 'modules/reference/pages/foo.adoc'}},
                {path: 'modules/reference/pages/bar.adoc', src: {path: 'modules/reference/pages/bar.adoc'}},
            ],
        }
        await extension.onContentAggregated({playbook: {}, siteAsciiDocConfig: {}, siteCatalog: {}, contentAggregate: [bucket]})
        strictEqual(bucket.files.length, 2, 'one untouched file plus one placeholder')
        const untouched = bucket.files.find((f) => f.path === 'modules/ROOT/pages/index.adoc')
        ok(untouched, 'unrelated module file should survive')
        const placeholder = bucket.files.find((f) => f.path === 'modules/reference/pages/index.adoc')
        ok(placeholder, 'placeholder index should be added')
        ok(Buffer.isBuffer(placeholder.contents), 'placeholder contents should be a Buffer')
        strictEqual(placeholder.src.scanned, placeholder.path, 'placeholder should populate src.scanned')
        strictEqual(placeholder.src.realpath, placeholder.path, 'placeholder should populate src.realpath')
    })
})

test('skip mode: placeholder body tailors undo instruction to source', () => {
    const playbookFile = CppReference.buildSkipPlaceholderFile({origins: []}, 'playbook')
    const cliFile = CppReference.buildSkipPlaceholderFile({origins: []}, 'cli')
    const envFile = CppReference.buildSkipPlaceholderFile({origins: []}, 'env')
    ok(playbookFile.contents.toString('utf8').includes('Set `skip: false`'))
    ok(cliFile.contents.toString('utf8').includes('--attribute skip-cpp-reference'))
    ok(envFile.contents.toString('utf8').includes('ANTORA_SKIP_CPP_REFERENCE'))
})

test('skip mode: placeholder body enumerates every active source when multiple fire', () => {
    const body = CppReference.buildSkipPlaceholderBody(['playbook', 'cli', 'env'])
    ok(body.includes('Multiple sources'), 'should call out that multiple signals are active')
    ok(body.includes('Set `skip: false`'), 'should mention the playbook undo step')
    ok(body.includes('--attribute skip-cpp-reference'), 'should mention the CLI undo step')
    ok(body.includes('ANTORA_SKIP_CPP_REFERENCE'), 'should mention the env undo step')
})

test('skip mode: extension exposes all active sources on the instance', () => {
    return withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: '1'}, () => {
        const playbook = {asciidoc: {attributes: {'skip-cpp-reference': '1'}}}
        const extension = makeSkipExtension({config: {skip: true}, playbook})
        deepStrictEqual(extension.skipReferenceSources, ['playbook', 'cli', 'env'])
        // Precedence winner kept on the singular field for log compat.
        strictEqual(extension.skipReferenceSource, 'playbook')
    })
})

test('skip mode: honors module override from descriptor and config', async () => {
    await withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: undefined}, async () => {
        // descriptor override wins over config.module
        const extension = makeSkipExtension({config: {skip: true, module: 'cfg-mod'}})
        const bucket = {
            name: 'demo',
            version: '1.0',
            origins: [{descriptor: {ext: {cppReference: {module: 'api-ref'}}}}],
            files: [
                {path: 'modules/api-ref/pages/stale.adoc', src: {path: 'modules/api-ref/pages/stale.adoc'}},
                {path: 'modules/reference/pages/untouched.adoc', src: {path: 'modules/reference/pages/untouched.adoc'}},
            ],
        }
        await extension.onContentAggregated({playbook: {}, siteAsciiDocConfig: {}, siteCatalog: {}, contentAggregate: [bucket]})
        const staleGone = bucket.files.every((f) => f.path !== 'modules/api-ref/pages/stale.adoc')
        ok(staleGone, 'stale page under overridden module should be removed')
        ok(
            bucket.files.find((f) => f.path === 'modules/api-ref/pages/index.adoc'),
            'placeholder should land under the overridden module'
        )
        ok(
            bucket.files.find((f) => f.path === 'modules/reference/pages/untouched.adoc'),
            'pages in the default reference module should be left alone when override is in effect'
        )
    })
})

test('skip mode: falls back to config.module when descriptor has no override', async () => {
    await withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: undefined}, async () => {
        const extension = makeSkipExtension({config: {skip: true, module: 'cfg-mod'}})
        const bucket = {
            name: 'demo',
            version: '1.0',
            origins: [{descriptor: {ext: {}}}],
            files: [],
        }
        await extension.onContentAggregated({playbook: {}, siteAsciiDocConfig: {}, siteCatalog: {}, contentAggregate: [bucket]})
        ok(
            bucket.files.find((f) => f.path === 'modules/cfg-mod/pages/index.adoc'),
            'placeholder should fall back to config.module when descriptor is silent'
        )
    })
})

test('skip mode: finalizes tagfile registry so waitFor resolves', async () => {
    await withPatchedEnv({ANTORA_SKIP_CPP_REFERENCE: '1'}, async () => {
        const extension = makeSkipExtension()
        const playbook = {runtime: {}}
        // A consumer that subscribes BEFORE onContentAggregated runs is
        // the realistic worst case. The registry's waitFor only resolves
        // when finalize is called.
        const registry = CppReference.ensureTagfileRegistry(playbook, extension.logger)
        const pending = registry.waitFor('reference')
        await extension.onContentAggregated({
            playbook,
            siteAsciiDocConfig: {},
            siteCatalog: {},
            contentAggregate: [],
        })
        await pending
        strictEqual(registry.entries.length, 0, 'no entries should be published in skip mode')
    })
})
