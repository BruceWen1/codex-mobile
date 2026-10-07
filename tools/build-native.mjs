// -*- coding: utf-8 -*-
/**
 * build-native.mjs
 * Embedded Codex Mobile Build Coordinator
 * =====================
 * Compiles the original Codex host for Android or iOS and packages its native library.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { configureIos } from './configure-ios.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = resolve(root, 'native/runtime/Cargo.toml');
const timings = [];
const profile = process.argv[3] ?? 'release';

/**
 * Run a native build command and measure its duration.
 *
 * Args:
 *     command (string): Executable name or dynamically resolved executable path.
 *     args (string[]): Command arguments passed without shell interpolation.
 *     env (object): Process environment with target-specific build settings.
 * Returns:
 *     void: The command completes successfully or exposes its actual failure.
 */
function run(command, args, env = process.env) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  timings.push({ command, durationMs: Math.round(performance.now() - started) });
  // Surface a failed native build before packaging a runtime library.
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited with status ${result.status}`);
}

/**
 * Resolve the installed Rust toolchain without changing global configuration.
 *
 * Args:
 *     None.
 * Returns:
 *     object: Build environment using a project-local toolchain when available.
 */
function rustEnvironment() {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const inheritedPath = pathKey ? env[pathKey] : '';
  // Normalize Windows environment-key casing before extending the executable search path.
  if (pathKey) delete env[pathKey];
  env.PATH = inheritedPath;
  const localCargo = resolve(root, '.tools/cargo');
  // Prefer a project-local toolchain when this checkout contains one.
  if (existsSync(localCargo)) {
    env.CARGO_HOME = localCargo;
    env.RUSTUP_HOME = resolve(root, '.tools/rustup');
    env.PATH = resolve(localCargo, 'bin') + (process.platform === 'win32' ? ';' : ':') + env.PATH;
  }
  const localPerl = resolve(root, '.tools/perl');
  // Supply the Unix Perl interpreter and native build utilities needed by Android OpenSSL.
  if (process.platform === 'win32' && existsSync(resolve(localPerl, 'perl/bin/perl.exe'))) {
    const lookup = spawnSync('where.exe', ['git'], { encoding: 'utf8', env });
    // Require an actual Git installation before resolving its Unix build utilities.
    if (lookup.error || lookup.status !== 0) throw new Error('Install Git for Windows to supply Unix build utilities.');
    const git = lookup.stdout.trim().split(/\r?\n/)[0];
    const unixBin = resolve(dirname(git), '../usr/bin');
    // Require a Unix-compatible Perl implementation for Android's Unix build target.
    if (!existsSync(resolve(unixBin, 'perl.exe'))) throw new Error('Install a Unix Perl interpreter for Android cross-compilation.');
    const buildBin = resolve(root, '.tools/build-bin');
    mkdirSync(buildBin, { recursive: true });
    copyFileSync(resolve(localPerl, 'c/bin/gmake.exe'), resolve(buildBin, 'make.exe'));
    const bundled = resolve(root, '.tools/perl-extra/bundled/lib/Pod');
    // Complete the lightweight Git Perl installation with portable documentation modules.
    if (!existsSync(bundled)) cpSync(resolve(localPerl, 'perl/lib/Pod'), bundled, { recursive: true });
    const moduleRoot = resolve(root, '.tools/perl-extra');
    const modules = readdirSync(moduleRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => resolve(moduleRoot, entry.name, 'lib'));
    const converted = modules.map((path) => spawnSync(resolve(unixBin, 'cygpath.exe'), ['-au', path], { encoding: 'utf8', env }).stdout.trim());
    env.PERL = 'perl';
    env.OPENSSL_SRC_PERL = 'perl';
    env.MAKEFLAGS = env.MAKEFLAGS ?? '-j8';
    env.PERL5LIB = converted.join(':');
    env.MSYS2_ENV_CONV_EXCL = [env.MSYS2_ENV_CONV_EXCL, 'PERL5LIB'].filter(Boolean).join(';');
    env.PATH = [buildBin, unixBin, resolve(localPerl, 'c/bin'), env.PATH].join(delimiter);
  }
  return env;
}

/**
 * Compile and package the Android ARM64 native runtime.
 *
 * Args:
 *     env (object): Build environment containing the Rust toolchain.
 * Returns:
 *     void: The actual shared library is copied into Android's ARM64 package directory.
 */
function buildAndroid(env) {
  const localNdk = resolve(root, '.tools/android-ndk-r30');
  const sdk = env.ANDROID_SDK_ROOT ?? env.ANDROID_HOME;
  let ndk = env.ANDROID_NDK_HOME ?? (existsSync(localNdk) ? localNdk : undefined);
  // Discover an SDK-managed NDK when no explicit NDK path is configured.
  if (!ndk && sdk && existsSync(resolve(sdk, 'ndk'))) ndk = resolve(sdk, 'ndk', readdirSync(resolve(sdk, 'ndk')).sort().at(-1));
  // Require a real Android compiler before starting cross-compilation.
  if (!ndk) throw new Error('Set ANDROID_NDK_HOME to an installed Android NDK.');
  const host = { win32: 'windows-x86_64', darwin: 'darwin-x86_64', linux: 'linux-x86_64' }[process.platform];
  const bin = resolve(ndk, 'toolchains/llvm/prebuilt', host, 'bin');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const target = 'aarch64-linux-android';
  const cachedSsl = resolve(root, '.tools/android-openssl');
  // Reuse the project-local ARM64 OpenSSL libraries when their headers and archives exist.
  if (!env.OPENSSL_DIR && existsSync(resolve(cachedSsl, 'include/openssl/ssl.h')) && existsSync(resolve(cachedSsl, 'lib/libcrypto.a')) && existsSync(resolve(cachedSsl, 'lib/libssl.a'))) {
    env.OPENSSL_DIR = cachedSsl;
    env.OPENSSL_NO_VENDOR = '1';
    env.OPENSSL_STATIC = '1';
  }
  const targetEnv = {
    ...env,
    CC_aarch64_linux_android: resolve(bin, `clang${suffix}`).replaceAll('\\', '/'),
    CXX_aarch64_linux_android: resolve(bin, `clang++${suffix}`).replaceAll('\\', '/'),
    AR_aarch64_linux_android: resolve(bin, `llvm-ar${suffix}`).replaceAll('\\', '/'),
    RANLIB_aarch64_linux_android: resolve(bin, `llvm-ranlib${suffix}`).replaceAll('\\', '/'),
    CFLAGS_aarch64_linux_android: '--target=aarch64-linux-android26',
    CXXFLAGS_aarch64_linux_android: '--target=aarch64-linux-android26',
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: resolve(bin, `clang${suffix}`),
    CARGO_ENCODED_RUSTFLAGS: ['-C', 'link-arg=--target=aarch64-linux-android26'].join('\x1f'),
  };
  run(process.platform === 'win32' ? 'rustup.exe' : 'rustup', ['target', 'add', target], env);
  run(process.platform === 'win32' ? 'cargo.exe' : 'cargo', ['build', '--manifest-path', manifest, '--profile', profile, '--target', target, '--locked'], targetEnv);
  const destination = resolve(root, 'android/app/src/main/jniLibs/arm64-v8a');
  mkdirSync(destination, { recursive: true });
  copyFileSync(resolve(root, `native/runtime/target/${target}/${profile}/libcodex_mobile_runtime.so`), resolve(destination, 'libcodex_mobile_runtime.so'));
  copyFileSync(resolve(root, `native/runtime/target/${target}/${profile}/codex-mobile-exec-host`), resolve(destination, 'libcodex_mobile_exec_host.so'));
}

/**
 * Compile the iOS device and simulator runtimes and package their XCFramework.
 *
 * Args:
 *     env (object): Build environment containing the Rust toolchain.
 * Returns:
 *     void: The actual static libraries form an XCFramework linked into the iOS project.
 */
function buildIos(env) {
  // Require Apple's actual build tools before claiming an iOS binary can be produced.
  if (process.platform !== 'darwin') throw new Error('iOS native builds require macOS and Xcode.');
  const targets = ['aarch64-apple-ios', 'aarch64-apple-ios-sim'];
  run('rustup', ['target', 'add', ...targets], env);
  // Build both device and simulator variants using the original embedded Codex crate.
  for (const target of targets) run('cargo', ['build', '--manifest-path', manifest, '--lib', '--release', '--target', target, '--locked'], env);
  const output = resolve(root, 'ios/App/CodexRuntime.xcframework');
  // Preserve existing compiled artifacts until the caller explicitly replaces them.
  if (existsSync(output)) throw new Error('CodexRuntime.xcframework already exists; move it aside before rebuilding.');
  run('xcodebuild', ['-create-xcframework', ...targets.flatMap((target) => ['-library', resolve(root, `native/runtime/target/${target}/release/libcodex_mobile_runtime.a`), '-headers', resolve(root, 'native/runtime/include')]), '-output', output], env);
  configureIos();
}

/**
 * Coordinate the selected native build and report stage timings.
 *
 * Args:
 *     None.
 * Returns:
 *     void: The selected mobile runtime is built and its total duration is reported.
 */
function main() {
  const started = performance.now();
  const platform = process.argv[2];
  const env = rustEnvironment();
  // Accept only the maintained native build profiles.
  if (!['release', 'dev-mobile'].includes(profile)) throw new Error('Use the release or dev-mobile build profile.');
  // Dispatch only a supported native target.
  if (platform === 'android') buildAndroid(env);
  else if (platform === 'ios') buildIos(env);
  else throw new Error('Usage: node tools/build-native.mjs android|ios');
  process.stdout.write(JSON.stringify({ platform, totalMs: Math.round(performance.now() - started), stages: timings }, null, 2) + '\n');
}

main();
