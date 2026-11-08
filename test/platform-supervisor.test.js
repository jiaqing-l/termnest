'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { platformRuntimeInfo } = require('../lib/platform-supervisor');
const ROOT = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-platform-')));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const psPath = () => path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
function ps(program, input = '') {
  program = `[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);` + program;
  return execFileSync(psPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
    { input, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).replace(/^\ufeff/, '').trim();
}
function windowsDry(args, app = ROOT, env = process.env) {
  return execFileSync(psPath(), ['-NoProfile', '-NonInteractive', '-File', path.join(app, 'scripts/install-supervisor.ps1'), '-DryRun', ...args],
    { env, encoding: 'utf8', timeout: 15000, windowsHide: true }).replace(/^\ufeff/, '').trim();
}
function macDry(dir, args = [], app = ROOT) {
  return execFileSync('/bin/bash', [path.join(app, 'scripts/install-supervisor-macos.sh'), '--dry-run', ...args],
    { cwd: ROOT, env: { ...process.env, HOME: path.join(dir, 'absent home & Việt') }, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function appFixture(dir, name) {
  const app = path.join(dir, name);
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(app, 'lib'));
  for (const script of ['install-supervisor.ps1', 'install-supervisor-macos.sh']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', script), path.join(app, 'scripts', script));
  }
  fs.copyFileSync(path.join(ROOT, 'lib/service-runtime.js'), path.join(app, 'lib/service-runtime.js'));
  return app;
}

function machoSlice(cpu, platform = 1) {
  const b = Buffer.alloc(56);
  [0xfeedfacf, cpu, 0, 2, 1, 24, 0, 0, 50, 24, platform, 0, 0, 0].forEach((v, i) => b.writeUInt32LE(v, i * 4));
  return b;
}
function universalMacho(slices, { little = false, wide = false, align = 8 } = {}) {
  const step = 2 ** align, entry = wide ? 32 : 20;
  let end = Math.ceil((8 + slices.length * entry) / step) * step;
  const offsets = slices.map(({ bytes }) => { const offset = end; end = Math.ceil((end + bytes.length) / step) * step; return offset; });
  const b = Buffer.alloc(end), word = (p, value) => b[little ? 'writeUInt32LE' : 'writeUInt32BE'](value, p);
  word(0, wide ? 0xcafebabf : 0xcafebabe); word(4, slices.length);
  slices.forEach(({ cpu, bytes }, i) => {
    const p = 8 + i * entry;
    word(p, cpu); word(p + 4, bytes.readUInt32LE(8));
    if (wide) {
      b[little ? 'writeBigUInt64LE' : 'writeBigUInt64BE'](BigInt(offsets[i]), p + 8);
      b[little ? 'writeBigUInt64LE' : 'writeBigUInt64BE'](BigInt(bytes.length), p + 16);
    } else { word(p + 8, offsets[i]); word(p + 12, bytes.length); }
    word(p + (wide ? 24 : 16), align);
    bytes.copy(b, offsets[i]);
  });
  return b;
}

// Mock Darwin only for binary parsing; stop before executing ANY synthetic Mach-O.
function macBinaryFixture(t) {
  const dir = fixture(t), app = appFixture(dir, 'Termnest Việt.app/Contents/Resources/app & spaces');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  const installer = path.join(app, 'scripts/install-supervisor-macos.sh');
  const seam = '# Linux dry-run is a generation-only development fixture.';
  const source = fs.readFileSync(installer, 'utf8'); assert.ok(source.includes(seam));
  const arch = path.join(bin, 'arch-probe');
  fs.writeFileSync(installer, source.replaceAll('/usr/bin/arch', '"' + arch + '"')
    .replace(seam, 'printf \'%s\\n\' "$node_bin"; exit 0\n' + seam));
  const node = path.join(bin, 'node');
  const put = (file, bytes) => { fs.writeFileSync(file, bytes, { mode: 0o700 }); fs.chmodSync(file, 0o700); };
  const run = (cpu, args = [], translated = false) => {
    put(path.join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -m) echo ${cpu} ;; *) echo Darwin ;; esac\n`);
    put(arch, `#!/bin/sh\nprintf '%s\\n' "$1" >> "$HOME.arch-probes"\nexit ${translated ? 0 : 1}\n`);
    return spawnSync('/bin/bash', [installer, '--dry-run', ...args],
      { env: { ...process.env, HOME: path.join(dir, 'absent'), PATH: bin }, encoding: 'utf8', timeout: 10000 });
  };
  return { dir, app, node, put, run };
}

test('mock universal Mach-O accepts bounded FAT32/FAT64 tables in both byte orders for PATH, override and bundle',
  { skip: process.platform === 'win32' ? 'POSIX binary parser fixtures; no synthetic executable runs' : false }, t => {
    const { dir, app, node, put, run } = macBinaryFixture(t);
    for (const little of [false, true]) for (const wide of [false, true]) {
      const fat = universalMacho([{ cpu: 0x1000007, bytes: machoSlice(0x1000007) }, { cpu: 0x100000c, bytes: machoSlice(0x100000c) }], { little, wide });
      put(node, fat);
      for (const [arch, suffix] of [['arm64', 'arm64'], ['x86_64', 'x64']]) {
        let r = run(arch); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), node);
        const override = path.join(dir, 'universal Node Việt & space'); put(override, fat);
        r = run(arch, ['--node-path', override]); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), override);
        const bundled = path.join(app, 'node-' + suffix); put(bundled, fat);
        r = run(arch); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), bundled);
        fs.unlinkSync(bundled);
      }
    }
    assert.equal(fs.existsSync(path.join(dir, 'absent')), false);
    assert.equal(fs.existsSync(path.join(dir, 'absent.arch-probes')), false);
  });

test('mock universal Mach-O refuses corrupt tables, CPU mismatches, foreign platforms and out-of-slice commands before execution',
  { skip: process.platform === 'win32' ? 'POSIX binary parser fixtures; no synthetic executable runs' : false }, t => {
    const { dir, node, put, run } = macBinaryFixture(t);
    const valid = options => universalMacho([{ cpu: 0x1000007, bytes: machoSlice(0x1000007) }, { cpu: 0x100000c, bytes: machoSlice(0x100000c) }], options);
    // All numeric corruption is relative to the actual on-disk byte order and record width.
    for (const little of [false, true]) for (const wide of [false, true]) {
      const write = (b, p, v) => b[little ? 'writeUInt32LE' : 'writeUInt32BE'](v, p);
      const read = (b, p) => b[little ? 'readUInt32LE' : 'readUInt32BE'](p);
      const entry = wide ? 32 : 20, offsetWord = 16 + (wide && !little ? 4 : 0);
      const sizeWord = wide ? 24 + (!little ? 4 : 0) : 20, alignmentWord = wide ? 32 : 24;
      const good = valid({ little, wide }), start = read(good, offsetWord), second = read(good, offsetWord + entry);
      const corruptions = {
        'zero entries': b => write(b, 4, 0),
        'excessive entries': b => write(b, 4, 65),
        'offset into table': b => write(b, offsetWord, 8),
        'offset past EOF': b => write(b, offsetWord, 0xfffffff0),
        'size past EOF': b => write(b, sizeWord, good.length),
        'truncated slice': b => write(b, sizeWord, 40),
        'overlapping slices': b => write(b, offsetWord + entry, start),
        'misaligned offset': b => write(b, offsetWord, start + 1),
        'unbounded alignment': b => write(b, alignmentWord, 31),
        'duplicate CPU': b => write(b, 8 + entry, 0x1000007),
        'wrong CPU': b => write(b, 8, 7),
        'slice CPU mismatch': b => b.writeUInt32LE(0x100000c, start + 4),
        'slice subtype mismatch': b => b.writeUInt32LE(3, start + 8),
        'wrong Mach-O endian': b => b.writeUInt32BE(0xfeedfacf, start),
        'ELF slice': b => b.writeUInt32BE(0x7f454c46, start),
        'PE slice': b => b.writeUInt32LE(0x5a4d, start),
        'dylib slice': b => b.writeUInt32LE(6, start + 12),
        'missing command': b => b.writeUInt32LE(2, start + 16),
        'unbounded commands': b => b.writeUInt32LE(257, start + 16),
        'unbounded load area': b => b.writeUInt32LE(1048584, start + 20),
        'unaligned command': b => b.writeUInt32LE(23, start + 36),
        'command past slice': b => b.writeUInt32LE(32, start + 36),
        'no platform command': b => b.writeUInt32LE(1, start + 32),
        'build tools past command': b => b.writeUInt32LE(1, start + 52),
        'iOS preferred slice': b => b.writeUInt32LE(2, second + 40),
        'iOS alternate slice': b => b.writeUInt32LE(2, start + 40),
        'iOS legacy command': b => b.writeUInt32LE(37, start + 32),
      };
      if (wide) {
        corruptions['64-bit offset overflow'] = b => write(b, 16 + (little ? 4 : 0), 1);
        corruptions['64-bit size overflow'] = b => write(b, 24 + (little ? 4 : 0), 1);
        corruptions['nonzero reserved'] = b => write(b, 36, 1);
      }
      for (const [name, corrupt] of Object.entries(corruptions)) {
        const b = Buffer.from(good); corrupt(b); put(node, b);
        const r = run('arm64'); assert.equal(r.status, 2, `${name} ${little}/${wide}: ${r.stderr}`);
        assert.match(r.stderr, /RUNTIME_NODE_INCOMPATIBLE/, name);
      }
      put(node, good.subarray(0, 12));
      assert.equal(run('arm64').status, 2, 'truncated architecture table');
    }
    assert.equal(fs.existsSync(path.join(dir, 'absent')), false);
    assert.equal(fs.existsSync(path.join(dir, 'absent.arch-probes')), false);
  });

test('mock source Node architecture translation requires the native loader; incompatible bundled Node never falls back',
  { skip: process.platform === 'win32' ? 'POSIX binary and loader fixtures' : false }, t => {
    const { dir, app, node, put, run } = macBinaryFixture(t);
    for (const universal of [false, true]) for (const [context, other, cpu] of [['arm64', 'x64', 0x1000007], ['x86_64', 'arm64', 0x100000c]]) {
      const bytes = machoSlice(cpu);
      const candidate = universal ? universalMacho([{ cpu, bytes }]) : bytes;
      put(node, candidate);
      let r = run(context, [], false); assert.equal(r.status, 2); assert.match(r.stderr, /RUNTIME_NODE_INCOMPATIBLE/);
      r = run(context, [], true); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), node);
      const bundle = path.join(app, 'node-' + (context === 'arm64' ? 'arm64' : 'x64')); put(bundle, candidate);
      r = run(context, [], true); assert.equal(r.status, 2); assert.match(r.stderr, /RUNTIME_NODE_INCOMPATIBLE/);
      // An explicit compatible source override still precedes an incompatible adjacent payload.
      r = run(context, ['--node-path', node], true); assert.equal(r.status, 0, r.stderr);
      fs.unlinkSync(bundle);
      assert.match(fs.readFileSync(path.join(dir, 'absent.arch-probes'), 'utf8'), other === 'x64' ? /-x86_64/ : /-arm64/);
    }
    assert.equal(fs.existsSync(path.join(dir, 'absent')), false);
  });

test('source macOS adapter accepts an explicit runtime with spaces and Unicode and never invokes PATH node',
  { skip: process.platform === 'win32' ? 'POSIX adapter; native Windows equivalent below' : false }, t => {
    const dir = fixture(t), app = appFixture(dir, 'source app & Việt'), bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
    const override = path.join(dir, 'explicit node Việt');
    fs.copyFileSync(process.execPath, override); fs.chmodSync(override, 0o700);
    const run = args => execFileSync('/bin/bash', [path.join(app, 'scripts/install-supervisor-macos.sh'), '--dry-run', ...args],
      { env: { ...process.env, HOME: path.join(dir, 'absent'), PATH: bin + path.delimiter + process.env.PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const text = run(['--node-path', override]);
    assert.ok(text.includes(`<array><string>${override}</string>`));
    assert.equal(fs.existsSync(path.join(dir, 'absent')), false);
    // Without an override or bundled runtime the failing PATH dependency is visible, before any mutation.
    assert.throws(() => run([]), e => e.status === 2);
    assert.throws(() => run(['--node-path', path.join(dir, 'missing')]), e => e.status === 2 && e.stderr.includes('RUNTIME_NODE_REQUIRED'));
  });

test('mock macOS binary fixtures select the matching packaged architecture and reject wrong OS/CPU before execution',
  { skip: process.platform === 'win32' ? 'POSIX binary-header fixtures' : false }, t => {
    const dir = fixture(t), app = appFixture(dir, 'Termnest Việt.app/Contents/Resources/app & spaces');
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
    // Stop only after real selection/header validation; synthetic Mach-O fixtures must NEVER execute.
    const installer = path.join(app, 'scripts/install-supervisor-macos.sh');
    const source = fs.readFileSync(installer, 'utf8');
    const seam = '# Linux dry-run is a generation-only development fixture.';
    assert.ok(source.includes(seam));
    fs.writeFileSync(installer, source.replace(seam, 'printf \'%s\\n\' "$node_bin"; exit 0\n' + seam));
    function macho(file, cpu, platform = 1) {
      const b = Buffer.alloc(56);
      [0xfeedfacf, cpu, 0, 2, 1, 24, 0, 0, 50, 24, platform, 0, 0, 0].forEach((v, i) => b.writeUInt32LE(v, i * 4));
      fs.writeFileSync(file, b, { mode: 0o700 }); fs.chmodSync(file, 0o700);
    }
    const run = (arch, args = []) => {
      fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -m) echo ${arch} ;; *) echo Darwin ;; esac\n`, { mode: 0o700 });
      return spawnSync('/bin/bash', [installer, '--dry-run', ...args],
        { env: { ...process.env, HOME: path.join(dir, 'absent'), PATH: bin }, encoding: 'utf8' });
    };
    macho(path.join(app, 'node-x64'), 0x1000007);
    macho(path.join(app, 'node-arm64'), 0x100000c);
    for (const [arch, name, cpu, wrongCpu] of [['arm64', 'arm64', 0x100000c, 0x1000007], ['x86_64', 'x64', 0x1000007, 0x100000c]]) {
      const bundled = path.join(app, `node-${name}`);
      macho(bundled, cpu);
      let result = run(arch); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), bundled);
      const override = path.join(dir, 'override & Việt'); macho(override, cpu);
      result = run(arch, ['--node-path', override]); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), override);
      for (const bad of ['cpu', 'ios', 'elf', 'truncated']) {
        if (bad === 'cpu') macho(bundled, wrongCpu);
        if (bad === 'ios') macho(bundled, cpu, 2);
        if (bad === 'elf') fs.writeFileSync(bundled, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]));
        if (bad === 'truncated') fs.writeFileSync(bundled, Buffer.from([0xcf, 0xfa]));
        result = run(arch); assert.equal(result.status, 2, bad); assert.match(result.stderr, /RUNTIME_NODE_INCOMPATIBLE/, bad);
      }
      fs.unlinkSync(bundled);
      result = run(arch); assert.equal(result.status, 2); assert.match(result.stderr, /RUNTIME_NODE_REQUIRED/);
    }
    assert.equal(fs.existsSync(path.join(dir, 'absent')), false);
  });

test('native macOS packaged installer runs its adjacent Node without global Node and honors explicit override',
  { skip: process.platform !== 'darwin' ? 'requires real macOS Node Mach-O execution; Linux fixtures are generation only' : false }, t => {
    const dir = fixture(t), app = appFixture(dir, 'Termnest Việt & spaces.app/Contents/Resources/app');
    const bundled = path.join(app, `node-${process.arch}`), override = path.join(dir, 'override node Việt');
    for (const file of [bundled, override]) { fs.copyFileSync(process.execPath, file); fs.chmodSync(file, 0o700); }
    const run = args => execFileSync('/bin/bash', [path.join(app, 'scripts/install-supervisor-macos.sh'), '--dry-run', ...args],
      { env: { ...process.env, HOME: path.join(dir, 'absent'), PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    for (const [args, expected] of [[[], bundled], [['--node-path', override], override]]) {
      const text = run(args);
      const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: text, encoding: 'utf8' }));
      assert.equal(plist.ProgramArguments[0], fs.realpathSync(expected));
      assert.equal(plist.ProgramArguments[1], path.join(app, 'server.js'));
      assert.equal(plist.EnvironmentVariables.TW_DATA, path.join(dir, 'absent/Library/Application Support/Termnest'));
    }
    assert.equal(fs.existsSync(path.join(dir, 'absent')), false);
  });

test('native macOS source installer executes a real universal PATH Node and explicit universal override without mutations',
  { skip: process.platform !== 'darwin' ? 'requires real macOS FAT loader; synthetic parser tests never execute fixtures' : false }, t => {
    const dir = fixture(t), app = appFixture(dir, 'source app Việt & spaces'), bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const bytes = fs.readFileSync(process.execPath);
    // Wrap the actual selected Node in a conventional single-slice FAT32 container.
    // An already universal process.execPath is retained verbatim, including its valid signatures.
    const universal = bytes.readUInt32LE(0) === 0xfeedfacf
      ? universalMacho([{ cpu: bytes.readUInt32LE(4), bytes }], { align: 14 }) : bytes;
    assert.ok([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(universal.readUInt32BE(0)));
    const node = path.join(bin, 'node'); fs.writeFileSync(node, universal, { mode: 0o700 });
    const run = (args, context) => {
      const script = [path.join(app, 'scripts/install-supervisor-macos.sh'), '--dry-run', ...args];
      return execFileSync(context ? '/usr/bin/arch' : '/bin/bash', context ? [context, '/bin/bash', ...script] : script,
        { env: { ...process.env, HOME: path.join(dir, 'absent'), PATH: bin + ':/usr/bin:/bin' }, encoding: 'utf8', timeout: 15000 });
    };
    // A real kernel execution and own-identity probe, not a mocked Darwin header result.
    for (const args of [[], ['--node-path', node]]) {
      const text = run(args);
      const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: text, encoding: 'utf8' }));
      assert.equal(plist.ProgramArguments[0], fs.realpathSync(node));
      assert.equal(plist.ProgramArguments[1], path.join(app, 'server.js'));
    }
    for (const context of ['-arm64', '-x86_64']) {
      const probe = spawnSync('/usr/bin/arch', [context, '/usr/bin/true'], { timeout: 3000 });
      if (probe.status !== 0) { t.diagnostic(`${context} execution context unavailable on this runner; no translation validation claimed`); continue; }
      // Exercises a different valid PATH Node CPU under Rosetta when available.
      // The context is an execution capability and does not identify physical hardware.
      assert.match(run([], context), /<key>ProgramArguments<\/key>/);
    }
    assert.equal(fs.existsSync(path.join(dir, 'absent')), false);
  });

test('native Windows packaged runtime works without PATH Node, honors overrides and rejects incompatible PE before execution',
  { skip: process.platform !== 'win32' ? 'requires real Windows PE loader and PowerShell' : false }, t => {
    const dir = fixture(t), app = appFixture(dir, 'installed Termnest Việt & spaces/app');
    const bundled = path.join(app, 'node.exe'), override = path.join(dir, 'override node Việt.exe');
    for (const file of [bundled, override]) fs.copyFileSync(process.execPath, file);
    const env = { ...process.env, PATH: path.join(dir, 'absent-bin') };
    const defaultData = path.join(ps("[Environment]::GetFolderPath('ApplicationData')"), 'Termnest');
    for (const [args, expected] of [[[], bundled], [['-NodePath', override], override]]) {
      const text = windowsDry(args, app, env);
      const command = text.match(/<Command>(.*?)<\/Command>/)[1].replaceAll('&amp;', '&');
      assert.equal(command, fs.realpathSync(expected));
      const js = Buffer.from(text.match(/Buffer.from\(&apos;([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf8');
      const context = { process: { env: {} }, require: server => assert.equal(server, path.join(app, 'server.js')) };
      require('node:vm').runInNewContext(js, context);
      assert.equal(context.process.env.TW_DATA, defaultData);
    }
    // Corrupt a copy only: incompatible payloads must fail rather than falling back to PATH.
    const pe = fs.readFileSync(bundled), offset = pe.readUInt32LE(60);
    pe.writeUInt16LE(process.arch === 'x64' ? 0xaa64 : 0x8664, offset + 4); fs.writeFileSync(bundled, pe);
    assert.throws(() => windowsDry([], app, env), e => e.status === 2 && e.stderr.includes('RUNTIME_NODE_INCOMPATIBLE'));
    fs.writeFileSync(bundled, '#!/bin/sh\nexit 91\n');
    assert.throws(() => windowsDry([], app, env), e => e.status === 2 && e.stderr.includes('RUNTIME_NODE_INCOMPATIBLE'));
    fs.unlinkSync(bundled);
    assert.throws(() => windowsDry([], app, env), e => e.status === 2 && e.stderr.includes('RUNTIME_NODE_REQUIRED'));
    assert.equal(fs.existsSync(path.join(dir, 'absent-bin')), false);
  });

test('pure readiness provider returns stable primitives and never turns configuration into runtime health', () => {
  const unknown = platformRuntimeInfo({ platform: 'win32' });
  assert.equal(unknown.manager, 'task_scheduler'); assert.equal(unknown.startupCode, 'STARTUP_NOT_CONFIGURED');
  assert.equal(unknown.localTeams, 'unknown'); assert.equal(unknown.remoteLinuxTeamsOverSsh, true);
  for (const p of ['win32', 'darwin', 'linux', 'unsupported']) {
    const result = platformRuntimeInfo({ platform: p, startupConfigured: true, startupVerified: true, managerAvailable: true,
      startupMode: p === 'linux' ? 'user_manager' : 'login_session', nodeAvailable: true, tmuxAvailable: true });
    assert.ok(Object.values(result).every(v => ['boolean', 'string', 'number'].includes(typeof v)));
    assert.equal(result.unattendedBoot, false); assert.equal(result.unlocked, 'unknown');
    assert.equal(result.observationsFresh, 'unknown'); assert.equal(result.auditValidated, 'unknown');
    assert.equal(result.runsDuringSleep, false); assert.equal(result.runsWhilePoweredOff, false);
  }
});

test('mock platform readiness distinguishes login-session managers, systemd linger and missing WSL dependencies', () => {
  for (const platform of ['win32', 'darwin']) {
    const r = platformRuntimeInfo({ platform, startupConfigured: true, startupMode: 'login_session', startupVerified: true, managerAvailable: true });
    assert.equal(r.startupVerified, true); assert.equal(r.requiresLogin, true); assert.equal(r.survivesLogout, false);
  }
  const options = { platform: 'linux', startupConfigured: true, startupMode: 'user_manager', startupVerified: true, managerAvailable: true };
  assert.equal(platformRuntimeInfo(options).startupCode, 'STARTUP_LINGER_REQUIRED');
  assert.equal(platformRuntimeInfo({ ...options, linger: true }).unattendedBoot, true);
  assert.equal(platformRuntimeInfo({ ...options, managerAvailable: false }).startupCode, 'STARTUP_MANAGER_UNAVAILABLE');
  assert.equal(platformRuntimeInfo({ ...options, managerAvailable: undefined }).startupCode, 'STARTUP_UNVERIFIED');
  assert.equal(platformRuntimeInfo({ ...options, startupMode: 'system_service' }).startupConfigured, false);
  for (const missing of ['wslAvailable', 'wslNodeAvailable', 'wslTmuxAvailable']) {
    const r = platformRuntimeInfo({ platform: 'win32', wslAvailable: true, wslNodeAvailable: true, wslTmuxAvailable: true, [missing]: false });
    assert.equal(r.localTeams, 'unavailable'); assert.equal(r.localTeamsCode, 'WSL_NODE_TMUX_REQUIRED');
    assert.equal(r.remoteLinuxTeamsOverSsh, true); assert.equal(r.nativeShell, 'powershell'); assert.equal(r.nativeShellPersistent, false);
  }
});

test('macOS plist dry-run escapes paths, preserves workers and creates no files or secret values',
  { skip: process.platform === 'win32' ? 'POSIX adapter; native Windows generation covered separately' : false }, t => {
    const dir = fixture(t), data = path.join(dir, 'absent & <data> " Việt $ ` %');
    const args = ['--data-dir', data, '--password-file', path.join(dir, 'absent secret'), '--port', '8765'];
    const a = macDry(dir, args), b = macDry(dir, args);
    assert.equal(a, b); assert.match(a, /&amp; &lt;data&gt; &quot; Việt/);
    assert.match(a, /<key>AbandonProcessGroup<\/key><true\/>/);
    assert.match(a, /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
    assert.match(a, /<key>SuccessfulExit<\/key><false\/>/);
    assert.match(a, /<key>Umask<\/key><integer>63<\/integer>/);
    assert.match(a, /TW_PASSWORD_FILE/); assert.doesNotMatch(a, /TW_PASSWORD<|LaunchDaemon|StandardOutPath/);
    assert.deepEqual(fs.readdirSync(dir), []);
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/plutil', ['-lint', '-'], { input: a });
      const json = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: a, encoding: 'utf8' }));
      assert.equal(json.EnvironmentVariables.TW_DATA, data);
      // The source fallback uses PATH, which may be a universal or translated Node
      // different from the bundled thin Node running this test suite.
      const selected = execFileSync('/bin/bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim();
      assert.deepEqual(json.ProgramArguments, [fs.realpathSync(selected), path.join(ROOT, 'server.js')]);
    }
    assert.match(macDry(dir, ['--status']), /RUNTIME_DRY_RUN_STATUS/);
    assert.match(macDry(dir, ['--uninstall']), /RUNTIME_DRY_RUN_UNINSTALL/);
  });

test('macOS dry-run resolves special application path and refuses unmanaged/symlinked registration',
  { skip: process.platform === 'win32' ? 'POSIX path/security checks' : false }, t => {
    const dir = fixture(t), app = path.join(dir, 'app & < > " \' Việt $ %');
    fs.mkdirSync(path.join(app, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(app, 'lib'));
    fs.copyFileSync(path.join(ROOT, 'scripts/install-supervisor-macos.sh'), path.join(app, 'scripts/install-supervisor-macos.sh'));
    fs.copyFileSync(path.join(ROOT, 'lib/service-runtime.js'), path.join(app, 'lib/service-runtime.js'));
    assert.match(macDry(dir, [], app), /app &amp; &lt; &gt; &quot; &apos; Việt/);
    const agent = path.join(dir, 'absent home & Việt/Library/LaunchAgents/io.termnest.supervisor.plist');
    fs.mkdirSync(path.dirname(agent), { recursive: true }); fs.writeFileSync(agent, '<plist>unmanaged</plist>', { mode: 0o600 });
    assert.throws(() => macDry(dir), e => e.stderr.includes('RUNTIME_EXISTING_AGENT_UNMANAGED'));
    fs.unlinkSync(agent); fs.symlinkSync(path.join(dir, 'absent'), agent);
    assert.throws(() => macDry(dir), e => e.stderr.includes('RUNTIME_EXISTING_AGENT_UNMANAGED'));
    assert.equal(fs.lstatSync(agent).isSymbolicLink(), true);
  });

test('macOS adapter rejects unsupported native host before modifying state', { skip: process.platform !== 'linux' ? 'Linux unsupported-host guard' : false }, t => {
  const dir = fixture(t), home = path.join(dir, 'home');
  const r = spawnSync('/bin/bash', [path.join(ROOT, 'scripts/install-supervisor-macos.sh')], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /RUNTIME_MACOS_REQUIRED/); assert.equal(fs.existsSync(home), false);
});

test('native Windows task XML handles non-ASCII/metacharacters and uses current-user InteractiveToken without credentials',
  { skip: process.platform !== 'win32' ? 'requires actual Windows PowerShell and Task Scheduler schema' : false }, t => {
    const dir = fixture(t), data = path.join(dir, 'absent data & Việt $ ` % \' (x)'), secret = path.join(data, 'password');
    const args = ['-DataDir', data, '-PasswordFile', secret, '-Port', '8765'];
    const a = windowsDry(args); assert.equal(a, windowsDry(args));
    assert.match(a, /<LogonType>InteractiveToken<\/LogonType>/); assert.match(a, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(a, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/); assert.match(a, /<AllowHardTerminate>false/);
    assert.doesNotMatch(a, /<Password>|TW_PASSWORD['"=:]|<BootTrigger>|HighestAvailable/);
    // Parse through the actual native task definition, WITHOUT registering/starting a task.
    const parsed = JSON.parse(ps(`$ErrorActionPreference='Stop';$text=[Console]::In.ReadToEnd();
$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$d=$s.NewTask(0);$d.XmlText=$text;
[xml]$x=$text;@{command=[string]$x.Task.Actions.Exec.Command;arguments=[string]$x.Task.Actions.Exec.Arguments;sid=[string]$x.Task.Principals.Principal.UserId} | ConvertTo-Json -Compress`, a));
    assert.equal(path.resolve(parsed.command), path.resolve(process.execPath));
    const base64 = parsed.arguments.match(/Buffer\.from\('([A-Za-z0-9+/=]+)'/)[1];
    const js = Buffer.from(base64, 'base64').toString('utf8');
    const context = { process: { env: {} }, require: server => { assert.equal(server, path.join(ROOT, 'server.js')); } };
    require('node:vm').runInNewContext(js, context);
    assert.equal(context.process.env.TW_DATA, data); assert.equal(context.process.env.TW_PASSWORD_FILE, secret);
    assert.equal(context.process.env.TW_PORT, '8765'); assert.deepEqual(fs.readdirSync(dir), []);
    assert.match(windowsDry(['-Status']), /RUNTIME_DRY_RUN_STATUS/);
    assert.match(windowsDry(['-Uninstall']), /RUNTIME_DRY_RUN_UNINSTALL/);
  });

test('adapter source contracts forbid process-tree termination, secret arguments and production startup during dry-run', () => {
  const win = fs.readFileSync(path.join(ROOT, 'scripts/install-supervisor.ps1'), 'utf8');
  const mac = fs.readFileSync(path.join(ROOT, 'scripts/install-supervisor-macos.sh'), 'utf8');
  assert.doesNotMatch(win, /^\s*(Stop-ScheduledTask|Stop-Process|taskkill|schtasks)/mi);
  assert.doesNotMatch(mac, /^\s*(kill|pkill|sudo|launchctl kickstart)/m);
  assert.ok(win.indexOf('if ($DryRun)') < win.indexOf("New-Object -ComObject 'Schedule.Service'"));
  assert.ok(mac.indexOf("if (dry === '1')") < mac.indexOf("assertPrivatePath(data"));
  assert.match(win, /FileMode\]::CreateNew/); assert.match(win, /SecureStringToBSTR/); assert.match(win, /ZeroFreeBSTR/);
});

test('native verify workflow covers four OS targets without publishing or credential artifacts', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/verify.yml'), 'utf8');
  for (const os of ['windows-2022', 'macos-15', 'macos-15-intel', 'ubuntu-24.04']) assert.ok(yaml.includes('os: ' + os));
  for (const command of ['npm ci', 'npm test', 'cargo test --locked', 'packaging/check-payload.js', 'packaging/desktop-smoke.js']) assert.ok(yaml.includes(command));
  assert.match(yaml, /node-version: '22\.14\.0'/); assert.match(yaml, /RUSTUP_TOOLCHAIN: '1\.98\.0'/);
  assert.match(yaml, /fail-fast: false/); assert.match(yaml, /CARGO_BUILD_JOBS: '2'/);
  assert.match(yaml, /pull_request:/); assert.match(yaml, /validation\/\*\*/);
  assert.doesNotMatch(yaml, /contents: write|secrets\.|gh release|tags:|path:.*(?:home|vault|password)/);
});

test('mock launchd lifecycle installs idempotently, preserves protected files, reports state and uninstalls only owned registration',
  { skip: process.platform === 'win32' ? 'POSIX fixture manager; native Windows mock manager covered separately' : false }, t => {
    const dir = fixture(t), app = path.join(dir, 'app & Việt'), scripts = path.join(app, 'scripts');
    const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), data = path.join(dir, 'DATA');
    fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(path.join(app, 'lib')); fs.mkdirSync(bin); fs.mkdirSync(data, { mode: 0o700 });
    const vault = path.join(data, 'vault.json'), secret = path.join(data, 'password');
    fs.writeFileSync(vault, 'encrypted-fixture', { mode: 0o600 }); fs.writeFileSync(secret, 'synthetic-fixture-password\n', { mode: 0o600 });
    fs.copyFileSync(path.join(ROOT, 'lib/service-runtime.js'), path.join(app, 'lib/service-runtime.js'));
    const manager = path.join(bin, 'launchctl'), plutil = path.join(bin, 'plutil');
    fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -m) echo ${process.arch === 'arm64' ? 'arm64' : 'x86_64'} ;; *) echo ${process.platform === 'darwin' ? 'Darwin' : 'Linux'} ;; esac\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 12345\n', { mode: 0o700 });
    fs.writeFileSync(plutil, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o700 });
    fs.writeFileSync(manager, `#!/bin/sh
printf '%s\\n' "$1" >> "$HOME/manager.log"
case "$1" in
print) test -f "$HOME/loaded" ;;
bootstrap) touch "$HOME/loaded" ;;
bootout) rm "$HOME/loaded" ;;
*) exit 9 ;;
esac
`, { mode: 0o700 });
    // Use fixture managers only; the Linux copy also changes the host guard. No real launchctl can be reached.
    const source = fs.readFileSync(path.join(ROOT, 'scripts/install-supervisor-macos.sh'), 'utf8')
      .replaceAll('/bin/launchctl', manager).replaceAll('/usr/bin/plutil', plutil)
      .replace('[[ "$runtime_os" = Darwin ]] || { echo RUNTIME_MACOS_REQUIRED', `[[ "$runtime_os" = ${process.platform === 'darwin' ? 'Darwin' : 'Linux'} ]] || { echo RUNTIME_MACOS_REQUIRED`);
    const installer = path.join(scripts, 'install-supervisor-macos.sh'); fs.writeFileSync(installer, source, { mode: 0o700 });
    const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH };
    const run = (...args) => execFileSync('/bin/bash', [installer, '--data-dir', data, '--password-file', secret, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(run(), /LOGIN_SESSION_ONLY/);
    const agent = path.join(home, 'Library/LaunchAgents/io.termnest.supervisor.plist');
    const before = fs.readFileSync(agent, 'utf8'), time = fs.statSync(agent).mtimeMs;
    assert.match(run(), /LOGIN_SESSION_ONLY/); assert.equal(fs.readFileSync(agent, 'utf8'), before); assert.equal(fs.statSync(agent).mtimeMs, time);
    assert.equal(fs.readFileSync(vault, 'utf8'), 'encrypted-fixture'); assert.equal(fs.readFileSync(secret, 'utf8'), 'synthetic-fixture-password\n');
    const log = fs.readFileSync(path.join(home, 'manager.log'), 'utf8');
    assert.equal(log.split('\n').filter(s => s === 'bootstrap').length, 1); assert.doesNotMatch(log, /kill|kickstart|bootout/);
    assert.match(run('--status'), /RUNTIME_AGENT_LOADED_LOGIN_SESSION_ONLY/);
    assert.match(run('--uninstall'), /RUNTIME_AGENT_UNINSTALLED/); assert.equal(fs.existsSync(agent), false);
    assert.equal(fs.existsSync(vault), true); assert.equal(fs.existsSync(secret), true);
    fs.writeFileSync(agent, '<plist>unrelated-owner</plist>', { mode: 0o600 });
    assert.throws(() => run('--uninstall'), e => e.stderr.includes('RUNTIME_EXISTING_AGENT_UNMANAGED'));
    assert.equal(fs.readFileSync(agent, 'utf8'), '<plist>unrelated-owner</plist>');
    fs.unlinkSync(agent); fs.chmodSync(secret, 0o644);
    assert.throws(() => run(), e => e.stderr.includes('RUNTIME_INSTALL_FAILED'));
    assert.equal(fs.existsSync(agent), false);
  });

test('native Windows with mock Task Scheduler installs/reruns/status/unregisters without overwriting vault or stopping workers',
  { skip: process.platform !== 'win32' ? 'Windows-only fixture uses actual ACL APIs and unregistered native task definitions' : false }, t => {
    const dir = fixture(t);
    const result = JSON.parse(ps(`
$ErrorActionPreference='Stop'
$c=[Console]::In.ReadToEnd() | ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
 $rule=New-Object Security.AccessControl.FileSystemAccessRule(([Security.Principal.SecurityIdentifier]$id),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $c.dir -AclObject $acl
$data=Join-Path $c.dir 'private data & Việt'
$null=New-Item -ItemType Directory -Path $data
$vault=Join-Path $data 'vault.json';$secret=Join-Path $data 'password'
[IO.File]::WriteAllText($vault,'encrypted-fixture')
[IO.File]::WriteAllText($secret,[string]$c.password)
# Native parser only: no task is registered through this actual COM object.
$script:native=New-Object -ComObject 'Schedule.Service';$script:native.Connect()
$script:state=@{task=$null;register=0;run=0;delete=0}
$script:folder=[pscustomobject]@{}
$script:folder | Add-Member ScriptMethod GetTask {
 param($name)
 if(-not $script:state.task){throw [IO.FileNotFoundException]::new()}
 return $script:state.task
}
$script:folder | Add-Member ScriptMethod RegisterTaskDefinition {
 param($name,$definition,$flags,$user,$password,$logon,$sddl)
 if($password -or $logon -ne 3 -or $user -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'unexpected credentials'}
 $script:state.register++
 # Mimic metadata the real manager may add; rerun must still be semantically idempotent.
 $definition.RegistrationInfo.Date='2000-01-01T00:00:00'
 $definition.RegistrationInfo.URI='\\Native-added-uri'
 $script:state.task=[pscustomobject]@{Definition=$definition;State=3;LastTaskResult=0}
 $script:state.task | Add-Member ScriptMethod Run {param($args) $script:state.run++;$this.State=4}
 return $script:state.task
}
$script:folder | Add-Member ScriptMethod DeleteTask {param($name,$flags) $script:state.delete++;$script:state.task=$null}
$script:scheduler=[pscustomobject]@{}
$script:scheduler | Add-Member ScriptMethod Connect {}
$script:scheduler | Add-Member ScriptMethod GetFolder {param($name) return $script:folder}
$script:scheduler | Add-Member ScriptMethod NewTask {param($flags) return $script:native.NewTask(0)}
function New-Object {
 [CmdletBinding(DefaultParameterSetName='Net')]
 param([Parameter(Position=0,ParameterSetName='Net')][string]$TypeName,
       [Parameter(Position=1,ParameterSetName='Net')][object[]]$ArgumentList,
       [Parameter(ParameterSetName='Com')][string]$ComObject)
 if($ComObject){if($ComObject -ne 'Schedule.Service'){throw 'unexpected COM'};return $script:scheduler}
 return Microsoft.PowerShell.Utility\\New-Object @PSBoundParameters
}
$installer=Join-Path $c.root 'scripts/install-supervisor.ps1'
$first=& $installer -DataDir $data -PasswordFile $secret -NodePath $c.node
$second=& $installer -DataDir $data -PasswordFile $secret -NodePath $c.node
$status=& $installer -Status -NodePath $c.node
$uninstall=& $installer -Uninstall -NodePath $c.node
@{register=$script:state.register;run=$script:state.run;delete=$script:state.delete;configured=($null -ne $script:state.task);
first=$first;second=$second;status=$status;uninstall=$uninstall;
vaultIntact=([IO.File]::ReadAllText($vault) -eq 'encrypted-fixture');secretIntact=([IO.File]::ReadAllText($secret) -eq $c.password)} | ConvertTo-Json -Compress
`, JSON.stringify({ dir, root: ROOT, node: process.execPath, password: 'synthetic-fixture-password' })));
    assert.equal(result.register, 1); assert.equal(result.run, 1); assert.equal(result.delete, 1);
    assert.equal(result.configured, false); assert.equal(result.vaultIntact, true); assert.equal(result.secretIntact, true);
    assert.match(result.first, /LOGIN_SESSION_ONLY/); assert.match(result.second, /LOGIN_SESSION_ONLY/);
    assert.equal(JSON.parse(result.status).mode, 'login_session'); assert.match(result.uninstall, /workers were not stopped/);
  });

test('mock missing Node dependency fails before macOS dry-run mutations', { skip: process.platform === 'win32' ? 'POSIX PATH fixture' : false }, t => {
  const dir = fixture(t), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  // dirname is needed to resolve the script's own absolute application path; no node exists in this fixture PATH.
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  fs.symlinkSync('/usr/bin/uname', path.join(bin, 'uname'));
  const home = path.join(dir, 'absent home');
  const result = spawnSync('/bin/bash', [path.join(ROOT, 'scripts/install-supervisor-macos.sh'), '--dry-run'],
    { env: { ...process.env, HOME: home, PATH: bin }, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /RUNTIME_NODE_REQUIRED/); assert.equal(fs.existsSync(home), false);
});
