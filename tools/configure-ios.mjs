// -*- coding: utf-8 -*-
/**
 * configure-ios.mjs
 * iOS Native Host Registration
 * =====================
 * Registers native sources and the compiled runtime in the generated Xcode project.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const xcode = require('xcode');
const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Register native iOS sources and the compiled Rust framework.
 *
 * Args:
 *     None.
 * Returns:
 *     void: The generated Xcode project references the native host and runtime.
 */
export function configureIos() {
  const projectPath = resolve(root, 'ios/App/App.xcodeproj/project.pbxproj');
  const project = xcode.project(projectPath);
  project.parseSync();
  const target = project.getFirstTarget().uuid;
  const appGroup = project.findPBXGroupKey({ path: 'App' });
  // Add each native source once to the actual application target.
  for (const filename of ['CodexRuntimePlugin.swift', 'CodexViewController.swift']) {
    // Preserve existing source registration on repeated native sync operations.
    if (!project.hasFile(filename)) project.addSourceFile(filename, { target }, appGroup);
  }
  // Add platform frameworks required by native TLS and the authorization browser.
  for (const framework of ['Security.framework', 'SystemConfiguration.framework', 'SafariServices.framework']) {
    // Keep repeated project configuration idempotent.
    if (!project.hasFile(framework)) project.addFramework(framework, { target, link: true });
  }
  const runtimePath = 'CodexRuntime.xcframework';
  // Link the actual compiled runtime only after its binary exists.
  if (existsSync(resolve(root, 'ios/App', runtimePath)) && !project.hasFile(runtimePath)) {
    project.addFramework(runtimePath, { target, customFramework: true, embed: false, link: true });
  }
  // Remove undefined optional fields before the project serializer writes them.
  for (const section of Object.values(project.hash.project.objects)) {
    // Inspect serialized project records while preserving their identifiers.
    for (const record of Object.values(section)) {
      // Clean only actual project objects.
      if (!record || typeof record !== 'object') continue;
      // Omit optional properties without a serialized value.
      for (const key of Object.keys(record)) {
        if (record[key] === undefined || record[key] === 'undefined') delete record[key];
      }
    }
  }
  writeFileSync(projectPath, project.writeSync());
  const storyboardPath = resolve(root, 'ios/App/App/Base.lproj/Main.storyboard');
  const storyboard = readFileSync(storyboardPath, 'utf8').replace('customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="CodexViewController" customModule="App"');
  writeFileSync(storyboardPath, storyboard);
}

// Run project registration when this file is invoked as the script entry point.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) configureIos();
