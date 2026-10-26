// -*- coding: utf-8 -*-
//! workspace.rs
//! Mobile Filesystem Path Validation
//! =====================
//! Validates actual filesystem paths for requests made by the mobile directory tool.

use std::io;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// Validate the paths in a directory-scoped filesystem request.
///
/// Args:
///     root (Path): Existing directory selected by the native host.
///     request (Value): Original app-server filesystem request.
/// Returns:
///     Result<(), String>: Success when every path resolves inside the directory.
fn validate_request_paths(root: &Path, request: &Value) -> Result<(), String> {
    // Select the path fields used by the original filesystem method.
    let fields: &[&str] = match request["method"].as_str() {
        Some("fs/copy") => &["sourcePath", "destinationPath"],
        Some(
            "fs/readDirectory" | "fs/getMetadata" | "fs/readFile" | "fs/writeFile"
            | "fs/createDirectory" | "fs/remove",
        ) => &["path"],
        _ => return Err("A mobile directory scope requires a filesystem request".to_owned()),
    };
    // Validate both source and destination before dispatching a copy request.
    for field in fields {
        let path = request["params"][*field]
            .as_str()
            .ok_or_else(|| format!("A filesystem {field} is required"))?;
        let path = Path::new(path);
        // Require absolute paths with explicit components before filesystem resolution.
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err(
                "Mobile file paths must be absolute and contain no parent traversal".to_owned(),
            );
        }
        let method = request["method"].as_str().unwrap_or_default();
        let source_link = method == "fs/copy"
            && request["params"]["sourcePath"]
                .as_str()
                .and_then(|source| std::fs::symlink_metadata(source).ok())
                .is_some_and(|metadata| metadata.file_type().is_symlink());
        let entry_only = (method == "fs/remove"
            && std::fs::symlink_metadata(path)
                .is_ok_and(|metadata| metadata.file_type().is_symlink()))
            || (method == "fs/copy" && source_link);
        let resolved = resolve_entry(path, entry_only).map_err(|error| error.to_string())?;
        // Compare actual paths so links and junctions retain the selected directory boundary.
        if !resolved.starts_with(root) {
            return Err("The mobile file path resolves outside the selected directory".to_owned());
        }
    }
    // Validate mapped descendants before a recursive copy follows existing destination links.
    if request["method"] == "fs/copy" && request["params"]["recursive"] == true {
        let source = Path::new(request["params"]["sourcePath"].as_str().unwrap_or_default());
        let destination = Path::new(
            request["params"]["destinationPath"]
                .as_str()
                .unwrap_or_default(),
        );
        if std::fs::symlink_metadata(source).is_ok_and(|metadata| metadata.file_type().is_dir()) {
            validate_copy_tree(root, source, destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Resolve a path according to whether the operation acts on a link entry itself.
///
/// Args:
///     path (Path): Absolute operation path.
///     entry_only (bool): Whether the original operation copies or removes the link itself.
/// Returns:
///     io::Result<PathBuf>: Actual target or the actual parent followed by the link entry.
fn resolve_entry(path: &Path, entry_only: bool) -> io::Result<PathBuf> {
    // Follow actual data targets for reads, writes, and directory operations.
    if !entry_only {
        return resolve_path(path);
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("A link parent is required"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("A link entry is required"))?;
    Ok(resolve_path(parent)?.join(name))
}

/// Validate every mapped destination of an original recursive directory copy.
///
/// Args:
///     root (Path): Actual selected directory.
///     source (Path): Source directory whose links retain their original copy semantics.
///     destination (Path): Directory receiving the original recursive copy.
/// Returns:
///     io::Result<()>: Success when mapped writes remain inside the selected directory.
fn validate_copy_tree(root: &Path, source: &Path, destination: &Path) -> io::Result<()> {
    // Inspect mapped write paths while preserving the original source link handling.
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if !resolve_entry(&target, kind.is_symlink())?.starts_with(root) {
            return Err(io::Error::other(
                "A recursive copy destination resolves outside the selected directory",
            ));
        }
        // Inspect nested directories that the original copy operation will traverse.
        if kind.is_dir() {
            validate_copy_tree(root, &entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Resolve an existing path or its nearest existing ancestor.
///
/// Args:
///     path (Path): Absolute filesystem path that may include new descendants.
/// Returns:
///     io::Result<PathBuf>: Actual ancestor path followed by the new path components.
fn resolve_path(path: &Path) -> io::Result<PathBuf> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    // Walk new descendants while retaining filesystem errors and existing links.
    loop {
        // Inspect links themselves so a dangling link remains a validation error.
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = ancestor.file_name().ok_or(error)?;
                suffix.push(name.to_os_string());
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| io::Error::other("A filesystem ancestor is required"))?;
            }
            Err(error) => return Err(error),
        }
    }
    let mut resolved = std::fs::canonicalize(ancestor)?;
    // Append new descendants only after resolving the existing ancestor and its links.
    for name in suffix.iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// Enforce the existing directory-tool boundary before upstream dispatch.
///
/// Args:
///     root (str): Absolute selected directory path.
///     request (Value): Original filesystem request without native envelope fields.
/// Returns:
///     Result<(), String>: Success when the directory and requested paths are valid.
pub(super) fn validate(root: &str, request: &Value) -> Result<(), String> {
    let root = Path::new(root);
    // Resolve the selected directory itself before checking any requested descendants.
    if !root.is_absolute() {
        return Err("An absolute mobile directory is required".to_owned());
    }
    let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    // Require an accessible directory as the tool's current root.
    if !root.is_dir() {
        return Err("The selected mobile path must be a directory".to_owned());
    }
    validate_request_paths(&root, request)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    /**
     * Verify access to existing files and new descendants inside the selected directory.
     *
     * Args:
     *     None.
     * Returns:
     *     (): Assertions verify valid paths for reading and creating files.
     */
    #[test]
    fn permits_existing_files_and_new_descendants() {
        let fixture = tempfile::tempdir().expect("isolated path fixture");
        let root = fixture.path().join("workspace");
        // Create an actual selected directory and a readable fixture file.
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("input.txt"), "fixture").unwrap();
        // Exercise existing and new paths through the same native validation entry point.
        for path in [root.join("input.txt"), root.join("new/nested/output.txt")] {
            assert!(
                super::validate(
                    root.to_str().unwrap(),
                    &json!({
                        "method": "fs/writeFile", "params": {"path": path}
                    })
                )
                .is_ok()
            );
        }
    }

    /**
     * Verify rejection of traversal and copy endpoints outside the selected directory.
     *
     * Args:
     *     None.
     * Returns:
     *     (): Assertions verify validation of both original copy parameters.
     */
    #[test]
    fn rejects_traversal_and_external_copy_endpoints() {
        let fixture = tempfile::tempdir().expect("isolated path fixture");
        let root = fixture.path().join("workspace");
        // Keep every test path inside the isolated fixture while separating the tool root.
        std::fs::create_dir(&root).unwrap();
        let input = root.join("input.txt");
        let outside = fixture.path().join("outside.txt");
        std::fs::write(&input, "inside").unwrap();
        std::fs::write(&outside, "outside").unwrap();
        // Reject a path containing explicit traversal even when its target exists.
        assert!(
            super::validate(
                root.to_str().unwrap(),
                &json!({
                    "method": "fs/readFile", "params": {"path": root.join("../outside.txt")}
                })
            )
            .is_err()
        );
        // Validate source and destination independently for original copy requests.
        for (source, destination) in [(&input, &outside), (&outside, &input)] {
            assert!(super::validate(root.to_str().unwrap(), &json!({
                "method": "fs/copy", "params": {"sourcePath": source, "destinationPath": destination}
            })).is_err());
        }
    }

    /**
     * Create a directory link using the current platform's supported fixture mechanism.
     *
     * Args:
     *     target (Path): Existing directory inside the isolated fixture.
     *     link (Path): New link path inside the isolated fixture.
     * Returns:
     *     (): A symbolic link or Windows junction has been created.
     */
    fn link_directory(target: &Path, link: &Path) {
        // Use a standard directory symlink on Unix platforms.
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        // Use a junction so Windows verification also works without symlink privileges.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;

            let result = std::process::Command::new("cmd.exe")
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .creation_flags(0x08000000) // Keep the fixture helper window hidden.
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }

    /**
     * Verify link boundaries for existing files and newly created descendants.
     *
     * Args:
     *     None.
     * Returns:
     *     (): External links are rejected and a selected linked root remains usable.
     */
    #[test]
    fn rejects_links_to_external_files_and_missing_descendants() {
        let fixture = tempfile::tempdir().expect("isolated link fixture");
        let root = fixture.path().join("workspace");
        let outside = fixture.path().join("external");
        // Create two independent directories inside the isolated fixture.
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("input.txt"), "external").unwrap();
        let link = root.join("linked");
        link_directory(&outside, &link);
        // Reject both existing targets and new files below an external link.
        for path in [link.join("input.txt"), link.join("new/output.txt")] {
            assert!(
                super::validate(
                    root.to_str().unwrap(),
                    &json!({
                        "method": "fs/writeFile", "params": {"path": path}
                    })
                )
                .is_err()
            );
        }
        // Resolve a directory selected through its own valid filesystem alias.
        assert!(
            super::validate(
                link.to_str().unwrap(),
                &json!({
                    "method": "fs/readFile", "params": {"path": link.join("input.txt")}
                })
            )
            .is_ok()
        );
        // Preserve safe original operations that copy or remove the link entry itself.
        assert!(
            super::validate(
                root.to_str().unwrap(),
                &json!({
                    "method": "fs/remove", "params": {"path": link, "recursive": true}
                })
            )
            .is_ok()
        );
        assert!(super::validate(root.to_str().unwrap(), &json!({
            "method": "fs/copy", "params": {"sourcePath": link, "destinationPath": root.join("copied-link"), "recursive": true}
        })).is_ok());
    }

    /// Verify destination-link boundaries before a recursive directory copy performs writes.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): An external mapped destination is rejected before original copy dispatch.
    #[test]
    fn rejects_external_links_in_mapped_copy_destinations() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("workspace");
        let source = root.join("source");
        let destination = root.join("destination");
        let outside = fixture.path().join("external");
        // Create an isolated source tree and an existing destination with a directory link.
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::create_dir(&destination).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(source.join("nested/input.txt"), "fixture").unwrap();
        link_directory(&outside, &destination.join("nested"));
        assert!(super::validate(root.to_str().unwrap(), &json!({
            "method": "fs/copy", "params": {"sourcePath": source, "destinationPath": destination, "recursive": true}
        })).is_err());
    }
}
