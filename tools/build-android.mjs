// -*- coding: utf-8 -*-
/**
 * build-android.mjs
 * Android Application Build Coordinator
 * =====================
 * Builds the shared interface and packages the embedded upstream Codex runtime.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const timings = [];

/**
 * Execute one build step and record its actual duration.
 *
 * Args:
 *     command (string): Executable path or command name.
 *     args (string[]): Arguments passed without shell interpolation.
 *     env (object): Build environment for the selected toolchain.
 * Returns:
 *     void: The command completes or its actual failure is reported.
 */
function run(command, args, env) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  timings.push({ step: args[0] ?? command, durationMs: Math.round(performance.now() - started) });
  // Stop packaging when a required build step fails.
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited with status ${result.status}`);
}

/**
 * Resolve the Android and Java toolchains with a local build cache.
 *
 * Args:
 *     None.
 * Returns:
 *     object: Environment and cache paths for the Android application build.
 */
function buildEnvironment() {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const inheritedPath = pathKey ? env[pathKey] : '';
  // Normalize the executable search path for Windows process creation.
  if (pathKey) delete env[pathKey];
  env.PATH = inheritedPath;
  const tools = resolve(root, '.tools');
  const java = existsSync(tools) ? readdirSync(tools).find((name) => name.startsWith('jdk-21')) : undefined;
  // Prefer an explicitly selected Java toolchain or the project-local JDK.
  if (!env.JAVA_HOME && java) env.JAVA_HOME = resolve(tools, java);
  // Require the Java toolchain needed by the native container.
  if (!env.JAVA_HOME) throw new Error('Set JAVA_HOME to JDK 21 or newer.');
  env.PATH = [resolve(env.JAVA_HOME, 'bin'), env.PATH].join(delimiter);
  env.ANDROID_HOME = env.ANDROID_SDK_ROOT ?? env.ANDROID_HOME ?? resolve(tools, 'android-sdk');
  // Require an actual SDK installation before launching Gradle.
  if (!existsSync(env.ANDROID_HOME)) throw new Error('Set ANDROID_SDK_ROOT to an installed Android SDK.');
  const cacheRoot = resolve(process.platform === 'win32' ? env.LOCALAPPDATA ?? homedir() : resolve(homedir(), '.cache'), 'codex-mobile-build');
  env.GRADLE_USER_HOME = env.GRADLE_USER_HOME ?? resolve(cacheRoot, 'gradle');
  const proxyValue = env.HTTPS_PROXY ?? env.HTTP_PROXY;
  // Honor the existing development proxy when it uses an HTTP transport.
  if (proxyValue) {
    const proxy = new URL(proxyValue);
    // Supply standard Java proxy settings for the user's configured HTTP proxy.
    if (['http:', 'https:'].includes(proxy.protocol)) {
      const port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
      env.JAVA_TOOL_OPTIONS = [env.JAVA_TOOL_OPTIONS ?? '', `-Dhttps.proxyHost=${proxy.hostname}`, `-Dhttps.proxyPort=${port}`, `-Dhttp.proxyHost=${proxy.hostname}`, `-Dhttp.proxyPort=${port}`].join(' ').trim();
    }
  }
  return { env, cacheRoot };
}

/**
 * Build a complete Android package with the original embedded Codex engine.
 *
 * Args:
 *     None.
 * Returns:
 *     void: The APK is generated and build stage durations are reported.
 */
function main() {
  const started = performance.now();
  const { env, cacheRoot } = buildEnvironment();
  // Build the ARM64 engine before packaging an executable mobile application.
  if (!process.argv.includes('--reuse-runtime')) run(process.execPath, ['tools/build-native.mjs', 'android', 'dev-mobile'], { ...env, MAKEFLAGS: '-j8' });
  // Require both actual native binaries even when the runtime build is reused.
  for (const name of ['libcodex_mobile_runtime.so', 'libcodex_mobile_exec_host.so']) {
    if (!existsSync(resolve(root, 'android/app/src/main/jniLibs/arm64-v8a', name))) throw new Error(`Build the native runtime before packaging: ${name}`);
  }
  const npmCli = process.env.npm_execpath;
  // Compile and sync the actual shared interface through the current npm installation.
  if (!npmCli) throw new Error('Run this coordinator with npm run build:android.');
  run(process.execPath, [npmCli, 'run', 'native:sync'], env);
  // Run the Gradle wrapper directly through Java for portable Windows argument handling.
  const java = resolve(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  run(java, ['-classpath', resolve(root, 'android/gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', '-p', 'android', '--project-cache-dir', resolve(cacheRoot, 'android-project'), ':app:assembleDebug', '--console=plain', '--no-daemon'], env);
  process.stdout.write(JSON.stringify({ apk: 'android/app/build/outputs/apk/debug/app-debug.apk', totalMs: Math.round(performance.now() - started), stages: timings }, null, 2) + '\n');
}

main();
