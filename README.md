# Codex Mobile

Codex Mobile embeds the original Rust Codex app-server inside a native Android or iOS application. The shared mobile interface presents conversations, model selection, task input, execution events, approvals, and authentication. Inference uses the original Codex transport and the user's existing authentication method.

## Project structure

| Path | Responsibility |
| --- | --- |
| `upstream/codex/` | Pinned original Codex source, including authentication, agent execution, history, and protocol definitions |
| `native/runtime/` | In-process Rust host, C interface, Android JNI bridge, and original execution-helper entry point |
| `src/` | Shared mobile interface and original app-server protocol client |
| `android/` | Android application, platform certificate configuration, storage grants, and native runtime registration |
| `ios/` | iOS application, native runtime registration, authorization browser, and security-scoped folder access |
| `tools/` | Native compilation, application packaging, and Xcode registration |
| `tests/` | Conversation-event, directory-boundary, and mobile-interface verification |
| `artifacts/ui/` | Rendered mobile-interface previews |

The source checkout pins Codex to commit `a9abdeaff1773ec6e867253ae59b19128077676f`. Rust dependencies use `native/runtime/Cargo.lock`; JavaScript dependencies use `package-lock.json`.

## Runtime behavior

The native host creates a private Codex state directory and starts the upstream in-process app-server. Requests and events retain the original protocol names and payloads. ChatGPT login uses the original device-code authorization flow. API Key login uses `account/login/start` with the original `apiKey` authentication type. The upstream engine owns token refresh, account state, conversations, and model requests.

Android packages an ARM64 Rust runtime and an upstream execution helper. The helper is installed in the application's native code directory and supplies the original subprocess helper modes. Command execution runs with the application's operating-system permissions. The selected directory supplies the default working location; shell access follows the operating-system grants. Shared-storage access is granted through Android's file-access permission interface.

Android retains user-initiated turns through a foreground service. Its notification rejoins the original conversation and offers interruption of active native turns. A bounded, renewable CPU wake lock supports execution while the screen is locked and is released during user-input waits and after completion. Native task status controls service lifetime. Operating-system process termination ends in-flight execution; saved conversations remain available for explicit continuation.

iOS uses a static Rust framework inside the application process. Selected directories retain their operating-system security scopes through native bookmarks. The iOS adapter provides filesystem operations inside those grants. Native subprocess execution requires platform support and remains outside the iOS execution adapter's current capabilities.

The native filesystem adapter maps listing, metadata inspection, reading, writing, directory creation, copying, moving, and deletion to the original `fs/*` protocol methods. The original thread API supplies each tool's working directory, including requests from child agents. Read-only requests execute in the native host; mutating requests present a confirmation surface and retain their original arguments and identifiers. A move performs a successful copy before removing its source. Existing copy and overwrite semantics follow the original filesystem implementation.

File-tool paths are relative to the original thread directory. Native validation checks resolved targets and mapped recursive-copy destinations, while link copying and removal operate on the link entries. Pending interactions survive interface recreation. Bounded native event delivery retains interactive requests and reports notification gaps for authoritative history recovery. The packaged interface verifies its native bridge version before enabling submission.

The browser preview renders the interface and identifies itself as an interface preview. Device operations use the packaged native application.

## Prerequisites

- Node.js 22 or newer.
- Rust 1.95.0 and the selected target standard library.
- Android: JDK 21 or newer, Android SDK platform 36, build tools 36.0.0, and an Android NDK with ARM64 support. The current package targets Android 8.0 or newer on ARM64 devices.
- Android cross-compilation on Windows: Unix-compatible Perl with its standard modules, GNU make, and an Android NDK compiler. Git for Windows supplies a lightweight Unix Perl interpreter; the build coordinator can supplement its modules from project-local build tools.
- iOS: macOS, Xcode, and the ARM64 device and simulator Rust targets. Device installation uses the developer's signing configuration.

Tool locations are discovered from environment variables or the project-local `.tools/` directory. Gradle caches and replaceable application build outputs use a dynamically resolved system-local cache directory. The coordinator copies the completed APK into the project artifact location after successful packaging. `CODEX_MOBILE_ANDROID_BUILD_DIR` selects an explicit build-output cache when needed.

## Setup and interface preview

Run these commands from the project root:

```shell
git submodule update --init --recursive
npm ci
npm run dev
```

The development interface is served on port 5173. Build the production interface with:

```shell
npm run build
```

## Android package

Set `JAVA_HOME`, `ANDROID_SDK_ROOT`, and `ANDROID_NDK_HOME` for an existing toolchain, or provide compatible project-local tools. Then run:

```shell
npm run build:android
```

The coordinator builds the actual native runtime and helper, compiles the shared interface, synchronizes the native projects, and generates `android/app/build/outputs/apk/debug/app-debug.apk`.

For an existing compiled runtime:

```shell
npm run build:android -- --reuse-runtime
```

The `--reuse-runtime` mode verifies that both native binaries exist before packaging. Native libraries are generated artifacts and remain outside version control.

## iOS framework and application

On macOS with Xcode, run:

```shell
npm run native:sync
npm run native:ios
npm run ios
```

The native build creates `ios/App/CodexRuntime.xcframework` from the device and simulator static libraries and registers it with the application target. Configure signing and run the application in Xcode.

## Verification

```shell
npm test
npm run test:ui
cargo test --manifest-path native/runtime/Cargo.toml --lib
```

The Rust integration fixture uses an isolated native state directory. It verifies the original account protocol, API Key storage state, ChatGPT device-code request schema, and actual filesystem reads, writes, directory creation, copying, and deletion. Mobile UI verification checks portrait layouts, task input, session navigation, and both authentication choices.

Real-account authorization, model inference, background behavior, and operating-system grants require device verification. iOS framework compilation and application signing require a macOS build environment.

## Current build artifacts

The Android ARM64 prototype is available at `artifacts/android/codex-mobile-0.1.0-arm64.apk`. Its build metadata and integrity hash are recorded in `artifacts/android/build-report.json`.

The current build has passed native Android cross-compilation, Android Java compilation, APK packaging and signature verification, 17 frontend unit checks, 11 mobile-interface and bridge checks, and seven native runtime checks including the original-core integration fixture. The packaged native library hashes match the current compiled binaries. The native libraries use 16 KiB ELF segment alignment. Device authorization, notification handling, lock-screen execution, and operating-system grants remain subject to device verification.

The prototype uses the `dev-mobile` build profile and includes both the original agent runtime and its execution helper. Its APK size is approximately 157 MiB. The maintained `release` profile provides optimized native builds.
