use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_HANDLE_EOF,
    ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};
use windows_sys::Win32::Storage::FileSystem::{
    FileAllocationInfo, FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard,
    GetFileInformationByHandle, MoveFileExW, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, FILE_ALLOCATION_INFO, FILE_ATTRIBUTE_DEVICE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING,
    MOVEFILE_WRITE_THROUGH, WIN32_FIND_STREAM_DATA,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTUPINFOEXW,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const SLOT_HEADER_BYTES: usize = 64;
const SLOT_MAGIC: &[u8; 8] = b"MPKSLOT1";
const FILE_READ_ATTRIBUTES_ACCESS: &str = "(RX)";
const FILE_MODIFY_ACCESS_INHERITED: &str = "(OI)(CI)M";

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "kebab-case")]
enum Request {
    Version,
    Reserve {
        path: String,
        byte_length: u64,
    },
    Scan {
        root: String,
        max_bytes: u64,
        max_files: u64,
    },
    Snapshot {
        source_root: String,
        object_root: String,
        max_bytes: u64,
        max_files: u64,
    },
    ScanTo {
        root: String,
        manifest_path: String,
        max_bytes: u64,
        max_files: u64,
    },
    SnapshotTo {
        source_root: String,
        object_root: String,
        manifest_path: String,
        max_bytes: u64,
        max_files: u64,
    },
    Materialize {
        manifest_path: String,
        object_root: String,
        destination_root: String,
    },
    Read {
        root: String,
        path: String,
        max_bytes: u64,
    },
    Write {
        root: String,
        path: String,
        bytes_base64: String,
        executable: Option<bool>,
        lease_path: String,
        fencing_token: String,
    },
    Replace {
        root: String,
        path: String,
        old: String,
        new: String,
        all: Option<bool>,
        lease_path: String,
        fencing_token: String,
    },
    SlotWrite {
        path: String,
        generation: u64,
        payload_base64: String,
    },
    SlotRead {
        path: String,
    },
    SandboxPrepare {
        attempt_root: String,
        writable_roots: Vec<String>,
    },
    SandboxRun {
        attempt_root: String,
        workspace: String,
        home: String,
        temp: String,
        command_text: String,
        timeout_ms: u64,
        output_limit: usize,
    },
    SandboxCleanup {
        attempt_root: String,
    },
}

#[derive(Debug, Serialize)]
struct Response<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HelperError>,
}

#[derive(Debug, Serialize)]
struct HelperError {
    code: String,
    message: String,
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: String,
}

type Result<T> = std::result::Result<T, Failure>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    path: String,
    kind: EntryKind,
    byte_length: u64,
    mode: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreeManifest {
    schema_version: u32,
    root_device: u64,
    byte_length: u64,
    file_count: u64,
    directory_count: u64,
    entries: Vec<ManifestEntry>,
    tree_hash: String,
}

#[derive(Debug)]
struct ScanLimits {
    max_bytes: u64,
    max_files: u64,
    bytes: u64,
    files: u64,
    directories: u64,
}

#[derive(Clone, Copy, Debug)]
struct FileIdentity {
    attributes: u32,
    volume: u32,
    index: u64,
    links: u32,
    size: u64,
    last_write: u64,
}

struct CheckedRoot {
    path: PathBuf,
    final_path: PathBuf,
    identity: FileIdentity,
    _handle: File,
}

struct CheckedParent {
    path: PathBuf,
    _handles: Vec<File>,
}

fn main() {
    let response = match run() {
        Ok(value) => Response {
            ok: true,
            value: Some(value),
            error: None,
        },
        Err(error) => Response::<Value> {
            ok: false,
            value: None,
            error: Some(HelperError {
                code: error.code.to_owned(),
                message: error.message,
            }),
        },
    };
    match serde_json::to_string(&response) {
        Ok(output) => println!("{output}"),
        Err(_) => println!(
            "{{\"ok\":false,\"error\":{{\"code\":\"SERIALIZE_FAILED\",\"message\":\"response serialization failed\"}}}}"
        ),
    }
}

fn run() -> Result<Value> {
    let mut input = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES as u64)
        .read_to_end(&mut input)
        .map_err(|error| failure("STDIN_FAILED", error))?;
    let request: Request =
        serde_json::from_slice(&input).map_err(|error| failure("INVALID_REQUEST", error))?;
    match request {
        Request::Version => Ok(json!({
            "version": VERSION,
            "protocolVersion": 1,
            "platform": "win32",
            "arch": architecture_name(),
            "features": [
                "windows-handles",
                "nofollow",
                "tree-snapshot",
                "capacity-slot",
                "file-allocation",
                "alternate-stream-rejection",
                "appcontainer",
                "job-object"
            ]
        })),
        Request::Reserve { path, byte_length } => reserve(Path::new(&path), byte_length),
        Request::Scan {
            root,
            max_bytes,
            max_files,
        } => serde_json::to_value(scan_tree(Path::new(&root), max_bytes, max_files, None)?)
            .map_err(|error| failure("SERIALIZE_FAILED", error)),
        Request::Snapshot {
            source_root,
            object_root,
            max_bytes,
            max_files,
        } => {
            create_plain_directory(Path::new(&object_root))?;
            serde_json::to_value(scan_tree(
                Path::new(&source_root),
                max_bytes,
                max_files,
                Some(Path::new(&object_root)),
            )?)
            .map_err(|error| failure("SERIALIZE_FAILED", error))
        }
        Request::ScanTo {
            root,
            manifest_path,
            max_bytes,
            max_files,
        } => {
            let manifest = scan_tree(Path::new(&root), max_bytes, max_files, None)?;
            write_manifest(Path::new(&manifest_path), &manifest)?;
            Ok(manifest_summary(&manifest, &manifest_path))
        }
        Request::SnapshotTo {
            source_root,
            object_root,
            manifest_path,
            max_bytes,
            max_files,
        } => {
            create_plain_directory(Path::new(&object_root))?;
            let manifest = scan_tree(
                Path::new(&source_root),
                max_bytes,
                max_files,
                Some(Path::new(&object_root)),
            )?;
            write_manifest(Path::new(&manifest_path), &manifest)?;
            Ok(manifest_summary(&manifest, &manifest_path))
        }
        Request::Materialize {
            manifest_path,
            object_root,
            destination_root,
        } => materialize(
            Path::new(&manifest_path),
            Path::new(&object_root),
            Path::new(&destination_root),
        ),
        Request::Read {
            root,
            path,
            max_bytes,
        } => safe_read(Path::new(&root), &path, max_bytes),
        Request::Write {
            root,
            path,
            bytes_base64,
            executable,
            lease_path,
            fencing_token,
        } => safe_write(
            Path::new(&root),
            &path,
            &bytes_base64,
            executable.unwrap_or(false),
            Path::new(&lease_path),
            &fencing_token,
        ),
        Request::Replace {
            root,
            path,
            old,
            new,
            all,
            lease_path,
            fencing_token,
        } => safe_replace(
            Path::new(&root),
            &path,
            &old,
            &new,
            all.unwrap_or(false),
            Path::new(&lease_path),
            &fencing_token,
        ),
        Request::SlotWrite {
            path,
            generation,
            payload_base64,
        } => slot_write(Path::new(&path), generation, &payload_base64),
        Request::SlotRead { path } => slot_read(Path::new(&path)),
        Request::SandboxPrepare {
            attempt_root,
            writable_roots,
        } => sandbox_prepare(Path::new(&attempt_root), &writable_roots),
        Request::SandboxRun {
            attempt_root,
            workspace,
            home,
            temp,
            command_text,
            timeout_ms,
            output_limit,
        } => sandbox_run(
            Path::new(&attempt_root),
            Path::new(&workspace),
            Path::new(&home),
            Path::new(&temp),
            &command_text,
            timeout_ms,
            output_limit,
        ),
        Request::SandboxCleanup { attempt_root } => sandbox_cleanup(Path::new(&attempt_root)),
    }
}

fn reserve(path: &Path, byte_length: u64) -> Result<Value> {
    if byte_length < 2 * SLOT_HEADER_BYTES as u64 + 2 || byte_length > i64::MAX as u64 {
        return Err(Failure {
            code: "INVALID_RESERVATION",
            message: "reservation size is invalid".to_owned(),
        });
    }
    if let Some(parent) = path.parent() {
        create_plain_directory(parent)?;
    }
    reject_reparse_if_present(path)?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| failure("RESERVE_OPEN_FAILED", error))?;
    let allocation = FILE_ALLOCATION_INFO {
        AllocationSize: byte_length as i64,
    };
    let allocated = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileAllocationInfo,
            &allocation as *const _ as *const c_void,
            std::mem::size_of::<FILE_ALLOCATION_INFO>() as u32,
        )
    };
    if allocated == 0 {
        return Err(failure(
            "FILE_ALLOCATION_FAILED",
            io::Error::last_os_error(),
        ));
    }
    file.set_len(byte_length)
        .map_err(|error| failure("RESERVE_TRUNCATE_FAILED", error))?;
    file.sync_all()
        .map_err(|error| failure("RESERVE_FSYNC_FAILED", error))?;
    Ok(json!({ "path": path, "byteLength": byte_length }))
}

fn scan_tree(
    root: &Path,
    max_bytes: u64,
    max_files: u64,
    object_root: Option<&Path>,
) -> Result<TreeManifest> {
    let checked_root = checked_root(root)?;
    reject_named_streams(&checked_root.final_path)?;
    let mut limits = ScanLimits {
        max_bytes,
        max_files,
        bytes: 0,
        files: 0,
        directories: 1,
    };
    let mut entries = vec![ManifestEntry {
        path: ".".to_owned(),
        kind: EntryKind::Directory,
        byte_length: 0,
        mode: 0o755,
        hash: None,
    }];
    walk_directory(
        &checked_root,
        &checked_root.path,
        "",
        &mut limits,
        &mut entries,
        object_root,
    )?;
    entries.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    let entries_value =
        serde_json::to_value(&entries).map_err(|error| failure("SERIALIZE_FAILED", error))?;
    let canonical = canonical_json(&entries_value)?.into_bytes();
    let tree_hash = format!("sha256:{}", hex::encode(Sha256::digest(canonical)));
    let manifest = TreeManifest {
        schema_version: 1,
        root_device: checked_root.identity.volume as u64,
        byte_length: limits.bytes,
        file_count: limits.files,
        directory_count: limits.directories,
        entries,
        tree_hash,
    };
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn walk_directory(
    root: &CheckedRoot,
    directory_path: &Path,
    relative: &str,
    limits: &mut ScanLimits,
    entries: &mut Vec<ManifestEntry>,
    object_root: Option<&Path>,
) -> Result<()> {
    let mut children = fs::read_dir(directory_path)
        .map_err(|error| failure("READDIR_FAILED", error))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| failure("READDIR_FAILED", error))?;
    children.sort_by(|left, right| {
        left.file_name()
            .to_string_lossy()
            .as_bytes()
            .cmp(right.file_name().to_string_lossy().as_bytes())
    });
    for entry in children {
        let name = entry.file_name().into_string().map_err(|_| Failure {
            code: "NON_UTF8_PATH",
            message: format!("path is not Unicode: {}", entry.path().display()),
        })?;
        let child_manifest = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let child_path = directory_path.join(&name);
        let (mut file, before) = open_checked(&child_path, None, Some(&root.final_path))?;
        reject_named_streams(&child_path)?;
        if before.volume != root.identity.volume {
            return Err(Failure {
                code: "MOUNT_POINT_REJECTED",
                message: format!("volume boundary at {child_manifest}"),
            });
        }
        if before.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            limits.directories = checked_increment(limits.directories, "directory count overflow")?;
            entries.push(ManifestEntry {
                path: child_manifest.clone(),
                kind: EntryKind::Directory,
                byte_length: 0,
                mode: 0o755,
                hash: None,
            });
            walk_directory(
                root,
                &child_path,
                &child_manifest,
                limits,
                entries,
                object_root,
            )?;
        } else {
            if before.links != 1 {
                return Err(Failure {
                    code: "HARD_LINK_REJECTED",
                    message: format!("hard link at {child_manifest}"),
                });
            }
            limits.files = checked_increment(limits.files, "file count overflow")?;
            limits.bytes = limits
                .bytes
                .checked_add(before.size)
                .ok_or_else(|| Failure {
                    code: "LIMIT_EXCEEDED",
                    message: "byte count overflow".to_owned(),
                })?;
            if limits.files > limits.max_files {
                return Err(Failure {
                    code: "FILE_LIMIT_EXCEEDED",
                    message: format!("file count exceeds {}", limits.max_files),
                });
            }
            if limits.bytes > limits.max_bytes {
                return Err(Failure {
                    code: "BYTE_LIMIT_EXCEEDED",
                    message: format!("tree bytes exceed {}", limits.max_bytes),
                });
            }
            let (digest, bytes_read) = hash_and_snapshot_file(&mut file, object_root)?;
            let after = file_identity(&file)?;
            ensure_unchanged_file(before, after, bytes_read, &child_manifest)?;
            entries.push(ManifestEntry {
                path: child_manifest,
                kind: EntryKind::File,
                byte_length: before.size,
                mode: mode_for_path(&child_path),
                hash: Some(format!("sha256:{digest}")),
            });
        }
    }
    Ok(())
}

fn materialize(manifest_path: &Path, object_root: &Path, destination_root: &Path) -> Result<Value> {
    let bytes =
        read_plain_absolute_file(manifest_path, 64 * 1024 * 1024).map_err(|error| Failure {
            code: "MANIFEST_READ_FAILED",
            message: error.message,
        })?;
    let manifest: TreeManifest =
        serde_json::from_slice(&bytes).map_err(|error| failure("MANIFEST_INVALID", error))?;
    validate_manifest(&manifest)?;
    create_plain_directory(destination_root)?;
    let root = checked_root(destination_root)?;
    for entry in &manifest.entries {
        if entry.path == "." {
            continue;
        }
        let components = validated_relative_components(&entry.path)?;
        match entry.kind {
            EntryKind::Directory => {
                let _ = checked_parent(&root, &components, true)?;
            }
            EntryKind::File => {
                let hash = entry.hash.as_deref().ok_or_else(|| Failure {
                    code: "MANIFEST_INVALID",
                    message: format!("file has no hash: {}", entry.path),
                })?;
                let digest = hash.strip_prefix("sha256:").ok_or_else(|| Failure {
                    code: "MANIFEST_INVALID",
                    message: format!("invalid hash: {hash}"),
                })?;
                let object_path = object_path(object_root, digest)?;
                let object_bytes = read_plain_absolute_file(&object_path, entry.byte_length)?;
                let actual = hex::encode(Sha256::digest(&object_bytes));
                if actual != digest || object_bytes.len() as u64 != entry.byte_length {
                    return Err(Failure {
                        code: "OBJECT_HASH_MISMATCH",
                        message: format!("object mismatch: {digest}"),
                    });
                }
                write_relative_file(&root, &components, &object_bytes)?;
            }
        }
    }
    Ok(json!({
        "treeHash": manifest.tree_hash,
        "fileCount": manifest.file_count,
        "byteLength": manifest.byte_length
    }))
}

fn safe_read(root: &Path, relative: &str, max_bytes: u64) -> Result<Value> {
    let components = validated_relative_components(relative)?;
    let checked = checked_root(root)?;
    let (mut file, identity) = open_relative_read(&checked, &components)?;
    if identity.size > max_bytes {
        return Err(Failure {
            code: "READ_LIMIT_EXCEEDED",
            message: format!("file is {} bytes", identity.size),
        });
    }
    let mut bytes = Vec::with_capacity(identity.size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| failure("FILE_READ_FAILED", error))?;
    let after = file_identity(&file)?;
    ensure_unchanged_file(identity, after, bytes.len() as u64, relative)?;
    Ok(json!({
        "byteLength": bytes.len(),
        "hash": format!("sha256:{}", hex::encode(Sha256::digest(&bytes))),
        "bytesBase64": BASE64.encode(bytes)
    }))
}

fn safe_write(
    root: &Path,
    relative: &str,
    encoded: &str,
    _executable: bool,
    lease_path: &Path,
    fencing_token: &str,
) -> Result<Value> {
    assert_lease(lease_path, fencing_token)?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| failure("BASE64_INVALID", error))?;
    let components = validated_relative_components(relative)?;
    let checked = checked_root(root)?;
    write_relative_file(&checked, &components, &bytes)?;
    assert_lease(lease_path, fencing_token)?;
    Ok(json!({
        "byteLength": bytes.len(),
        "hash": format!("sha256:{}", hex::encode(Sha256::digest(&bytes)))
    }))
}

fn safe_replace(
    root: &Path,
    relative: &str,
    old: &str,
    new: &str,
    replace_all: bool,
    lease_path: &Path,
    fencing_token: &str,
) -> Result<Value> {
    assert_lease(lease_path, fencing_token)?;
    if old.is_empty() {
        return Err(Failure {
            code: "INVALID_REPLACE",
            message: "old text is empty".to_owned(),
        });
    }
    let components = validated_relative_components(relative)?;
    let checked = checked_root(root)?;
    let (mut file, identity) = open_relative_read(&checked, &components)?;
    if identity.size > MAX_REQUEST_BYTES as u64 {
        return Err(Failure {
            code: "READ_LIMIT_EXCEEDED",
            message: format!("file is {} bytes", identity.size),
        });
    }
    let mut bytes = Vec::with_capacity(identity.size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| failure("FILE_READ_FAILED", error))?;
    ensure_unchanged_file(
        identity,
        file_identity(&file)?,
        bytes.len() as u64,
        relative,
    )?;
    drop(file);
    let content = String::from_utf8(bytes).map_err(|error| failure("FILE_NOT_UTF8", error))?;
    let matches = content.match_indices(old).count();
    if matches == 0 {
        return Err(Failure {
            code: "OLD_TEXT_NOT_FOUND",
            message: "old text not found".to_owned(),
        });
    }
    if !replace_all && matches != 1 {
        return Err(Failure {
            code: "OLD_TEXT_AMBIGUOUS",
            message: format!("old text occurs {matches} times"),
        });
    }
    let replaced = if replace_all {
        content.replace(old, new)
    } else {
        content.replacen(old, new, 1)
    };
    assert_lease(lease_path, fencing_token)?;
    write_relative_file(&checked, &components, replaced.as_bytes())?;
    assert_lease(lease_path, fencing_token)?;
    Ok(json!({
        "replacements": if replace_all { matches } else { 1 },
        "byteLength": replaced.len(),
        "hash": format!("sha256:{}", hex::encode(Sha256::digest(replaced.as_bytes())))
    }))
}

fn slot_write(path: &Path, generation: u64, encoded: &str) -> Result<Value> {
    reject_reparse_if_present(path)?;
    let payload = BASE64
        .decode(encoded)
        .map_err(|error| failure("BASE64_INVALID", error))?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| failure("SLOT_OPEN_FAILED", error))?;
    let length = file
        .metadata()
        .map_err(|error| failure("SLOT_STAT_FAILED", error))?
        .len() as usize;
    let region_size = length / 2;
    if region_size <= SLOT_HEADER_BYTES || payload.len() > region_size - SLOT_HEADER_BYTES {
        return Err(Failure {
            code: "SLOT_PAYLOAD_TOO_LARGE",
            message: format!(
                "payload={} capacity={}",
                payload.len(),
                region_size.saturating_sub(SLOT_HEADER_BYTES)
            ),
        });
    }
    let region = generation as usize % 2;
    let offset = region * region_size;
    let digest = Sha256::digest(&payload);
    let mut header = [0u8; SLOT_HEADER_BYTES];
    header[0..8].copy_from_slice(SLOT_MAGIC);
    header[8..16].copy_from_slice(&generation.to_le_bytes());
    header[16..24].copy_from_slice(&(payload.len() as u64).to_le_bytes());
    header[24..56].copy_from_slice(&digest);
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(|error| failure("SLOT_SEEK_FAILED", error))?;
    file.write_all(&header)
        .map_err(|error| failure("SLOT_WRITE_FAILED", error))?;
    file.write_all(&payload)
        .map_err(|error| failure("SLOT_WRITE_FAILED", error))?;
    file.sync_all()
        .map_err(|error| failure("SLOT_FSYNC_FAILED", error))?;
    Ok(json!({
        "generation": generation,
        "checksum": format!("sha256:{}", hex::encode(digest))
    }))
}

fn slot_read(path: &Path) -> Result<Value> {
    reject_reparse_if_present(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| failure("SLOT_OPEN_FAILED", error))?;
    let length = file
        .metadata()
        .map_err(|error| failure("SLOT_STAT_FAILED", error))?
        .len() as usize;
    let region_size = length / 2;
    let mut candidates: Vec<(u64, Vec<u8>, String)> = Vec::new();
    for region in 0..2 {
        file.seek(SeekFrom::Start((region * region_size) as u64))
            .map_err(|error| failure("SLOT_SEEK_FAILED", error))?;
        let mut header = [0u8; SLOT_HEADER_BYTES];
        if file.read_exact(&mut header).is_err() || &header[0..8] != SLOT_MAGIC {
            continue;
        }
        let generation = u64::from_le_bytes(header[8..16].try_into().unwrap());
        let payload_length = u64::from_le_bytes(header[16..24].try_into().unwrap()) as usize;
        if payload_length > region_size.saturating_sub(SLOT_HEADER_BYTES) {
            continue;
        }
        let mut payload = vec![0u8; payload_length];
        if file.read_exact(&mut payload).is_err() {
            continue;
        }
        let digest = Sha256::digest(&payload);
        if digest.as_slice() != &header[24..56] {
            continue;
        }
        candidates.push((
            generation,
            payload,
            format!("sha256:{}", hex::encode(digest)),
        ));
    }
    let (generation, payload, checksum) = candidates
        .into_iter()
        .max_by_key(|item| item.0)
        .ok_or_else(|| Failure {
            code: "SLOT_EMPTY",
            message: "no valid slot generation".to_owned(),
        })?;
    Ok(json!({
        "generation": generation,
        "checksum": checksum,
        "payloadBase64": BASE64.encode(payload)
    }))
}

fn sandbox_prepare(attempt_root: &Path, writable_roots: &[String]) -> Result<Value> {
    let root = checked_root(attempt_root)?;
    let profile_name = sandbox_profile_name(&root.final_path);
    let profile = AppContainerProfile::ensure(&profile_name)?;
    grant_acl(
        attempt_root,
        &profile.sid_string,
        FILE_READ_ATTRIBUTES_ACCESS,
        false,
    )?;
    for path in writable_roots {
        let writable = Path::new(path);
        let (handle, identity) = open_checked(writable, Some(true), Some(&root.final_path))?;
        drop(handle);
        if identity.attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(Failure {
                code: "SANDBOX_PATH_INVALID",
                message: format!("writable root is not a directory: {}", writable.display()),
            });
        }
        grant_acl(
            writable,
            &profile.sid_string,
            FILE_MODIFY_ACCESS_INHERITED,
            true,
        )?;
    }
    Ok(json!({
        "engine": "windows-appcontainer",
        "profile": profile_name
    }))
}

fn sandbox_cleanup(attempt_root: &Path) -> Result<Value> {
    let final_root = fs::canonicalize(attempt_root).unwrap_or_else(|_| attempt_root.to_path_buf());
    let profile_name = sandbox_profile_name(&final_root);
    let revoke_result = if attempt_root.exists() {
        AppContainerProfile::open(&profile_name)
            .and_then(|profile| revoke_acl(attempt_root, &profile.sid_string))
    } else {
        Ok(())
    };
    let wide = wide_string(OsStr::new(&profile_name));
    let result = unsafe { DeleteAppContainerProfile(wide.as_ptr()) };
    if result < 0 {
        return Err(Failure {
            code: "SANDBOX_CLEANUP_FAILED",
            message: format!("DeleteAppContainerProfile failed: 0x{:08x}", result as u32),
        });
    }
    revoke_result?;
    Ok(json!({ "cleaned": true }))
}

fn sandbox_run(
    attempt_root: &Path,
    workspace: &Path,
    home: &Path,
    temp: &Path,
    command_text: &str,
    timeout_ms: u64,
    output_limit: usize,
) -> Result<Value> {
    if output_limit == 0 || output_limit > 16 * 1024 * 1024 {
        return Err(Failure {
            code: "SANDBOX_OUTPUT_LIMIT_INVALID",
            message: format!("invalid output limit: {output_limit}"),
        });
    }
    let root = checked_root(attempt_root)?;
    for path in [workspace, home, temp] {
        let (handle, _) = open_checked(path, Some(true), Some(&root.final_path))?;
        drop(handle);
    }
    let profile_name = sandbox_profile_name(&root.final_path);
    let profile = AppContainerProfile::open(&profile_name)?;
    let nonce = nonce();
    let script_path = temp.join(format!("sandbox-{nonce}-command.ps1"));
    let stdout_path = temp.join(format!("sandbox-{nonce}-stdout.txt"));
    let stderr_path = temp.join(format!("sandbox-{nonce}-stderr.txt"));
    let outcome = (|| -> Result<Value> {
        write_power_shell_script(&script_path, command_text, &stdout_path, &stderr_path)?;
        let result = launch_appcontainer_power_shell(
            &profile,
            workspace,
            home,
            temp,
            &script_path,
            timeout_ms,
        );
        let stdout = read_shell_output(&stdout_path, output_limit)?;
        let stderr = read_shell_output(&stderr_path, output_limit)?;
        let (exit_code, timed_out) = result?;
        Ok(json!({
            "exitCode": exit_code,
            "signal": Value::Null,
            "stdout": stdout.text,
            "stderr": stderr.text,
            "timedOut": timed_out,
            "truncated": stdout.truncated || stderr.truncated
        }))
    })();
    let _ = fs::remove_file(script_path);
    let _ = fs::remove_file(stdout_path);
    let _ = fs::remove_file(stderr_path);
    outcome
}

struct ShellOutput {
    text: String,
    truncated: bool,
}

fn read_shell_output(path: &Path, limit: usize) -> Result<ShellOutput> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ShellOutput {
                text: String::new(),
                truncated: false,
            })
        }
        Err(error) => return Err(failure("SANDBOX_OUTPUT_READ_FAILED", error)),
    };
    let identity = file_identity(&file)?;
    if identity.attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
        || identity.links != 1
    {
        return Err(Failure {
            code: "SANDBOX_OUTPUT_INVALID",
            message: format!("sandbox output is not a plain file: {}", path.display()),
        });
    }
    let length = file
        .metadata()
        .map_err(|error| failure("SANDBOX_OUTPUT_STAT_FAILED", error))?
        .len() as usize;
    let mut bytes = Vec::with_capacity(length.min(limit));
    (&mut file)
        .take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| failure("SANDBOX_OUTPUT_READ_FAILED", error))?;
    Ok(ShellOutput {
        text: decode_shell_text(&bytes),
        truncated: length > limit,
    })
}

fn decode_shell_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&words);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&words);
    }
    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .to_owned()
}

fn write_power_shell_script(
    path: &Path,
    command_text: &str,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<()> {
    let encoded_user_command = BASE64.encode(command_text.as_bytes());
    let wrapper = format!(
        "$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue';\
         [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;\
         $command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'));\
         $exitCode=0;try{{& ([ScriptBlock]::Create($command)) 1> {} 2> {};\
         if($null -ne $LASTEXITCODE){{$exitCode=[int]$LASTEXITCODE}}elseif(-not $?){{$exitCode=1}}}}\
         catch{{$_|Out-String|Out-File -LiteralPath {} -Encoding utf8 -Append;$exitCode=1}};exit $exitCode",
        encoded_user_command,
        powershell_literal(stdout_path),
        powershell_literal(stderr_path),
        powershell_literal(stderr_path),
    );
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| failure("SANDBOX_SCRIPT_CREATE_FAILED", error))?;
    file.write_all(&[0xef, 0xbb, 0xbf])
        .and_then(|()| file.write_all(wrapper.as_bytes()))
        .map_err(|error| failure("SANDBOX_SCRIPT_WRITE_FAILED", error))?;
    file.sync_all()
        .map_err(|error| failure("SANDBOX_SCRIPT_FSYNC_FAILED", error))?;
    Ok(())
}

fn launch_appcontainer_power_shell(
    profile: &AppContainerProfile,
    workspace: &Path,
    home: &Path,
    temp: &Path,
    script_path: &Path,
    timeout_ms: u64,
) -> Result<(Option<u32>, bool)> {
    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| Failure {
        code: "SANDBOX_ENVIRONMENT_INVALID",
        message: "SystemRoot is unavailable".to_owned(),
    })?;
    let powershell = PathBuf::from(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let command_line = format!(
        "{} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {}",
        quote_windows_argument(&powershell.as_os_str().to_string_lossy()),
        quote_windows_argument(&script_path.as_os_str().to_string_lossy())
    );
    let env = environment_block(&[
        ("SystemRoot", Path::new(&system_root)),
        ("windir", Path::new(&system_root)),
        (
            "ComSpec",
            &PathBuf::from(&system_root).join("System32").join("cmd.exe"),
        ),
        ("PATH", &PathBuf::from(&system_root).join("System32")),
        ("HOME", home),
        ("USERPROFILE", home),
        ("APPDATA", &home.join("AppData").join("Roaming")),
        ("LOCALAPPDATA", &home.join("AppData").join("Local")),
        ("TEMP", temp),
        ("TMP", temp),
        ("MODEL_PK_WORKSPACE", Path::new("/workspace")),
    ]);
    let mut command_line_w = wide_string(OsStr::new(&command_line));
    let powershell_w = wide_string(powershell.as_os_str());
    let cwd_w = wide_string(workspace.as_os_str());

    let mut security_capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let mut attribute_size = 0usize;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
    }
    if attribute_size == 0 {
        return Err(failure(
            "SANDBOX_ATTRIBUTE_INIT_FAILED",
            io::Error::last_os_error(),
        ));
    }
    let words = attribute_size.div_ceil(std::mem::size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0
    {
        return Err(failure(
            "SANDBOX_ATTRIBUTE_INIT_FAILED",
            io::Error::last_os_error(),
        ));
    }
    let updated = unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &mut security_capabilities as *mut _ as *const c_void,
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            null_mut(),
            null(),
        )
    };
    if updated == 0 {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(failure(
            "SANDBOX_ATTRIBUTE_UPDATE_FAILED",
            io::Error::last_os_error(),
        ));
    }

    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(failure(
            "SANDBOX_JOB_CREATE_FAILED",
            io::Error::last_os_error(),
        ));
    }
    let mut job_info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    job_info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let job_configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &job_info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if job_configured == 0 {
        unsafe {
            CloseHandle(job);
            DeleteProcThreadAttributeList(attribute_list);
        }
        return Err(failure(
            "SANDBOX_JOB_CONFIGURE_FAILED",
            io::Error::last_os_error(),
        ));
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;
    let mut process = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            powershell_w.as_ptr(),
            command_line_w.as_mut_ptr(),
            null(),
            null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_SUSPENDED
                | CREATE_NO_WINDOW,
            env.as_ptr() as *const c_void,
            cwd_w.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        unsafe { CloseHandle(job) };
        return Err(failure(
            "SANDBOX_PROCESS_CREATE_FAILED",
            io::Error::last_os_error(),
        ));
    }
    if unsafe { AssignProcessToJobObject(job, process.hProcess) } == 0 {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
        }
        return Err(failure(
            "SANDBOX_JOB_ASSIGN_FAILED",
            io::Error::last_os_error(),
        ));
    }
    if unsafe { ResumeThread(process.hThread) } == u32::MAX {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
        }
        return Err(failure(
            "SANDBOX_PROCESS_RESUME_FAILED",
            io::Error::last_os_error(),
        ));
    }
    unsafe { CloseHandle(process.hThread) };
    let timeout = timeout_ms.min(u32::MAX as u64) as u32;
    let wait = unsafe { WaitForSingleObject(process.hProcess, timeout) };
    let mut exit_code = 0u32;
    let timed_out = wait == WAIT_TIMEOUT;
    let outcome = if wait == WAIT_OBJECT_0 {
        if unsafe { GetExitCodeProcess(process.hProcess, &mut exit_code) } == 0 {
            Err(failure(
                "SANDBOX_EXIT_CODE_FAILED",
                io::Error::last_os_error(),
            ))
        } else {
            Ok((Some(exit_code), false))
        }
    } else if timed_out {
        Ok((None, true))
    } else {
        Err(failure("SANDBOX_WAIT_FAILED", io::Error::last_os_error()))
    };
    unsafe {
        TerminateJobObject(job, 1);
        WaitForSingleObject(process.hProcess, 5_000);
        CloseHandle(process.hProcess);
        CloseHandle(job);
    }
    outcome
}

struct AppContainerProfile {
    sid: PSID,
    sid_string: String,
}

impl AppContainerProfile {
    fn ensure(name: &str) -> Result<Self> {
        let name_w = wide_string(OsStr::new(name));
        let display_w = wide_string(OsStr::new("Model PK isolated attempt"));
        let description_w = wide_string(OsStr::new("Model PK Windows execution boundary"));
        let mut sid: PSID = null_mut();
        let created = unsafe {
            CreateAppContainerProfile(
                name_w.as_ptr(),
                display_w.as_ptr(),
                description_w.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if created < 0 && created != hresult_from_win32(ERROR_ALREADY_EXISTS) {
            return Err(Failure {
                code: "SANDBOX_PROFILE_CREATE_FAILED",
                message: format!("CreateAppContainerProfile failed: 0x{:08x}", created as u32),
            });
        }
        if created < 0 {
            let derived =
                unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
            if derived < 0 {
                return Err(Failure {
                    code: "SANDBOX_PROFILE_OPEN_FAILED",
                    message: format!(
                        "DeriveAppContainerSidFromAppContainerName failed: 0x{:08x}",
                        derived as u32
                    ),
                });
            }
        }
        Self::from_sid(name, sid)
    }

    fn open(name: &str) -> Result<Self> {
        let name_w = wide_string(OsStr::new(name));
        let mut sid: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
        if derived < 0 {
            return Err(Failure {
                code: "SANDBOX_NOT_PREPARED",
                message: format!(
                    "AppContainer profile is unavailable: 0x{:08x}",
                    derived as u32
                ),
            });
        }
        Self::from_sid(name, sid)
    }

    fn from_sid(_name: &str, sid: PSID) -> Result<Self> {
        if sid.is_null() {
            return Err(Failure {
                code: "SANDBOX_PROFILE_INVALID",
                message: "AppContainer returned a null SID".to_owned(),
            });
        }
        let mut text = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            unsafe { FreeSid(sid) };
            return Err(failure(
                "SANDBOX_SID_CONVERT_FAILED",
                io::Error::last_os_error(),
            ));
        }
        let sid_string = unsafe { string_from_wide_ptr(text) };
        unsafe { LocalFree(text as *mut c_void) };
        Ok(Self { sid, sid_string })
    }
}

impl Drop for AppContainerProfile {
    fn drop(&mut self) {
        if !self.sid.is_null() {
            unsafe { FreeSid(self.sid) };
            self.sid = null_mut();
        }
    }
}

fn grant_acl(path: &Path, sid: &str, access: &str, recursive: bool) -> Result<()> {
    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| Failure {
        code: "SANDBOX_ENVIRONMENT_INVALID",
        message: "SystemRoot is unavailable".to_owned(),
    })?;
    let executable = PathBuf::from(system_root)
        .join("System32")
        .join("icacls.exe");
    let mut command = Command::new(executable);
    command
        .arg(path)
        .arg("/grant:r")
        .arg(format!("*{sid}:{access}"))
        .arg("/C")
        .arg("/Q")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    if recursive {
        command.arg("/T");
    }
    let status = command
        .status()
        .map_err(|error| failure("SANDBOX_ACL_LAUNCH_FAILED", error))?;
    if !status.success() {
        return Err(Failure {
            code: "SANDBOX_ACL_GRANT_FAILED",
            message: format!("icacls exited {:?} for {}", status.code(), path.display()),
        });
    }
    Ok(())
}

fn revoke_acl(path: &Path, sid: &str) -> Result<()> {
    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| Failure {
        code: "SANDBOX_ENVIRONMENT_INVALID",
        message: "SystemRoot is unavailable".to_owned(),
    })?;
    let executable = PathBuf::from(system_root)
        .join("System32")
        .join("icacls.exe");
    let status = Command::new(executable)
        .arg(path)
        .arg("/remove:g")
        .arg(format!("*{sid}"))
        .arg("/T")
        .arg("/C")
        .arg("/Q")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| failure("SANDBOX_ACL_LAUNCH_FAILED", error))?;
    if !status.success() {
        return Err(Failure {
            code: "SANDBOX_ACL_REVOKE_FAILED",
            message: format!("icacls exited {:?} for {}", status.code(), path.display()),
        });
    }
    Ok(())
}

fn checked_root(path: &Path) -> Result<CheckedRoot> {
    if !path.is_absolute() {
        return Err(Failure {
            code: "PATH_NOT_ABSOLUTE",
            message: format!("path is not absolute: {}", path.display()),
        });
    }
    let (handle, identity) = open_checked(path, Some(true), None)?;
    let final_path =
        fs::canonicalize(path).map_err(|error| failure("ROOT_CANONICALIZE_FAILED", error))?;
    Ok(CheckedRoot {
        path: final_path.clone(),
        final_path,
        identity,
        _handle: handle,
    })
}

fn open_checked(
    path: &Path,
    expect_directory: Option<bool>,
    boundary: Option<&Path>,
) -> Result<(File, FileIdentity)> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    let file = options
        .open(path)
        .map_err(|error| failure("PATH_OPEN_FAILED", error))?;
    let identity = file_identity(&file)?;
    if identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Failure {
            code: "SYMLINK_REJECTED",
            message: format!("reparse point at {}", path.display()),
        });
    }
    if identity.attributes & FILE_ATTRIBUTE_DEVICE != 0 {
        return Err(Failure {
            code: "SPECIAL_FILE_REJECTED",
            message: format!("device at {}", path.display()),
        });
    }
    let is_directory = identity.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if let Some(expected) = expect_directory {
        if expected != is_directory {
            return Err(Failure {
                code: "SPECIAL_FILE_REJECTED",
                message: format!("unexpected file type at {}", path.display()),
            });
        }
    }
    if let Some(root) = boundary {
        let actual =
            fs::canonicalize(path).map_err(|error| failure("PATH_CANONICALIZE_FAILED", error))?;
        if !path_is_within(root, &actual) {
            return Err(Failure {
                code: "PATH_ESCAPE",
                message: format!("resolved path is outside root: {}", actual.display()),
            });
        }
    }
    Ok((file, identity))
}

fn file_identity(file: &File) -> Result<FileIdentity> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info) } == 0 {
        return Err(failure(
            "FILE_INFORMATION_FAILED",
            io::Error::last_os_error(),
        ));
    }
    Ok(FileIdentity {
        attributes: info.dwFileAttributes,
        volume: info.dwVolumeSerialNumber,
        index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        links: info.nNumberOfLinks,
        size: ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64,
        last_write: ((info.ftLastWriteTime.dwHighDateTime as u64) << 32)
            | info.ftLastWriteTime.dwLowDateTime as u64,
    })
}

fn open_relative_read(root: &CheckedRoot, components: &[OsString]) -> Result<(File, FileIdentity)> {
    let (parents, leaf) = split_leaf(components)?;
    let parent = checked_parent(root, parents, false)?;
    let path = parent.path.join(leaf);
    let (file, identity) = open_checked(&path, Some(false), Some(&root.final_path))?;
    if identity.links != 1 {
        return Err(Failure {
            code: "HARD_LINK_REJECTED",
            message: format!("hard link at {}", path.display()),
        });
    }
    Ok((file, identity))
}

fn checked_parent(
    root: &CheckedRoot,
    components: &[OsString],
    create: bool,
) -> Result<CheckedParent> {
    let mut path = root.path.clone();
    let mut handles = Vec::with_capacity(components.len());
    for component in components {
        path.push(component);
        if create {
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(failure("DIRECTORY_CREATE_FAILED", error)),
            }
        }
        let (handle, _) = open_checked(&path, Some(true), Some(&root.final_path))?;
        handles.push(handle);
    }
    Ok(CheckedParent {
        path,
        _handles: handles,
    })
}

fn write_relative_file(root: &CheckedRoot, components: &[OsString], bytes: &[u8]) -> Result<()> {
    let (parents, leaf) = split_leaf(components)?;
    let parent = checked_parent(root, parents, true)?;
    let destination = parent.path.join(leaf);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            let (existing, identity) =
                open_checked(&destination, Some(false), Some(&root.final_path))?;
            if identity.links != 1 {
                return Err(Failure {
                    code: "HARD_LINK_REJECTED",
                    message: format!("hard link at {}", destination.display()),
                });
            }
            drop(existing);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(failure("PATH_STAT_FAILED", error)),
    }
    let temporary = parent
        .path
        .join(format!(".model-pk-tmp-{}-{}", std::process::id(), nonce()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&temporary)
            .map_err(|error| failure("TEMP_CREATE_FAILED", error))?;
        file.write_all(bytes)
            .map_err(|error| failure("FILE_WRITE_FAILED", error))?;
        file.sync_all()
            .map_err(|error| failure("FILE_FSYNC_FAILED", error))?;
        drop(file);
        move_replace(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn hash_and_snapshot_file(file: &mut File, object_root: Option<&Path>) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut bytes_read = 0u64;
    let temp_path = object_root.map(|root| {
        root.join(format!(
            ".model-pk-object-{}-{}",
            std::process::id(),
            nonce()
        ))
    });
    let mut output = match &temp_path {
        Some(path) => Some(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .map_err(|error| failure("OBJECT_TEMP_CREATE_FAILED", error))?,
        ),
        None => None,
    };
    let result = (|| -> Result<(String, u64)> {
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|error| failure("FILE_READ_FAILED", error))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            bytes_read = bytes_read
                .checked_add(count as u64)
                .ok_or_else(|| Failure {
                    code: "LIMIT_EXCEEDED",
                    message: "read byte count overflow".to_owned(),
                })?;
            if let Some(target) = output.as_mut() {
                target
                    .write_all(&buffer[..count])
                    .map_err(|error| failure("OBJECT_WRITE_FAILED", error))?;
            }
        }
        let digest = hex::encode(hasher.finalize());
        if let Some(target) = output.as_mut() {
            target
                .sync_all()
                .map_err(|error| failure("OBJECT_FSYNC_FAILED", error))?;
        }
        drop(output.take());
        if let (Some(path), Some(root)) = (temp_path.as_deref(), object_root) {
            publish_temp_object(path, root, &digest, bytes_read)?;
        }
        Ok((digest, bytes_read))
    })();
    if let Some(path) = temp_path {
        let _ = fs::remove_file(path);
    }
    result
}

fn publish_temp_object(
    temp_path: &Path,
    root: &Path,
    digest: &str,
    byte_length: u64,
) -> Result<()> {
    let path = object_path(root, digest)?;
    if let Some(parent) = path.parent() {
        create_plain_directory(parent)?;
    }
    match fs::hard_link(temp_path, &path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let existing = read_plain_absolute_file(&path, byte_length)?;
            if existing.len() as u64 != byte_length
                || hex::encode(Sha256::digest(&existing)) != digest
            {
                return Err(Failure {
                    code: "OBJECT_HASH_MISMATCH",
                    message: format!("existing object mismatch: {digest}"),
                });
            }
            Ok(())
        }
        Err(error) => Err(failure("OBJECT_CREATE_FAILED", error)),
    }
}

fn read_plain_absolute_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>> {
    reject_reparse_if_present(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| failure("FILE_OPEN_FAILED", error))?;
    let before = file_identity(&file)?;
    if before.attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(Failure {
            code: "SYMLINK_REJECTED",
            message: format!("invalid file at {}", path.display()),
        });
    }
    if before.links != 1 {
        return Err(Failure {
            code: "HARD_LINK_REJECTED",
            message: format!("hard link at {}", path.display()),
        });
    }
    if before.size > max_bytes {
        return Err(Failure {
            code: "READ_LIMIT_EXCEEDED",
            message: format!("file is {} bytes", before.size),
        });
    }
    let mut bytes = Vec::with_capacity(before.size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| failure("FILE_READ_FAILED", error))?;
    ensure_unchanged_file(
        before,
        file_identity(&file)?,
        bytes.len() as u64,
        &path.display().to_string(),
    )?;
    Ok(bytes)
}

fn ensure_unchanged_file(
    before: FileIdentity,
    after: FileIdentity,
    bytes_read: u64,
    path: &str,
) -> Result<()> {
    if before.volume != after.volume
        || before.index != after.index
        || before.attributes != after.attributes
        || before.size != after.size
        || after.size != bytes_read
        || before.last_write != after.last_write
    {
        return Err(Failure {
            code: "FILE_CHANGED_DURING_SCAN",
            message: format!("file changed while scanning {path}"),
        });
    }
    Ok(())
}

fn write_manifest(path: &Path, manifest: &TreeManifest) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_plain_directory(parent)?;
    }
    reject_reparse_if_present(path)?;
    let bytes = serde_json::to_vec(manifest).map_err(|error| failure("SERIALIZE_FAILED", error))?;
    let temporary = path.with_extension(format!("tmp-{}-{}", std::process::id(), nonce()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&temporary)
            .map_err(|error| failure("MANIFEST_CREATE_FAILED", error))?;
        file.write_all(&bytes)
            .map_err(|error| failure("MANIFEST_WRITE_FAILED", error))?;
        file.sync_all()
            .map_err(|error| failure("MANIFEST_FSYNC_FAILED", error))?;
        drop(file);
        move_replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn move_replace(source: &Path, destination: &Path) -> Result<()> {
    let source_w = wide_path(source);
    let destination_w = wide_path(destination);
    if unsafe {
        MoveFileExW(
            source_w.as_ptr(),
            destination_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(failure("FILE_RENAME_FAILED", io::Error::last_os_error()));
    }
    Ok(())
}

fn create_plain_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|error| failure("DIRECTORY_CREATE_FAILED", error))?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| failure("DIRECTORY_STAT_FAILED", error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Failure {
            code: "SYMLINK_REJECTED",
            message: format!("directory is a reparse point: {}", path.display()),
        });
    }
    let (handle, _) = open_checked(path, Some(true), None)?;
    drop(handle);
    Ok(())
}

fn reject_reparse_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(Failure {
                    code: "SYMLINK_REJECTED",
                    message: format!("reparse point at {}", path.display()),
                });
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failure("PATH_STAT_FAILED", error)),
    }
}

fn reject_named_streams(path: &Path) -> Result<()> {
    let wide = wide_path(path);
    let mut data = WIN32_FIND_STREAM_DATA::default();
    let handle = unsafe {
        FindFirstStreamW(
            wide.as_ptr(),
            FindStreamInfoStandard,
            &mut data as *mut _ as *mut c_void,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() };
        if error == ERROR_HANDLE_EOF
            || error == ERROR_NO_MORE_FILES
            || error == ERROR_INVALID_PARAMETER
        {
            return Ok(());
        }
        return Err(Failure {
            code: "STREAM_ENUMERATION_FAILED",
            message: format!("stream enumeration failed for {}: {error}", path.display()),
        });
    }
    let result = (|| -> Result<()> {
        loop {
            let length = data
                .cStreamName
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(data.cStreamName.len());
            let name = String::from_utf16_lossy(&data.cStreamName[..length]);
            if name != "::$DATA" {
                return Err(Failure {
                    code: "ALTERNATE_STREAM_REJECTED",
                    message: format!("alternate stream {name} at {}", path.display()),
                });
            }
            if unsafe { FindNextStreamW(handle, &mut data as *mut _ as *mut c_void) } != 0 {
                continue;
            }
            let error = unsafe { GetLastError() };
            if error == ERROR_HANDLE_EOF || error == ERROR_NO_MORE_FILES {
                return Ok(());
            }
            return Err(Failure {
                code: "STREAM_ENUMERATION_FAILED",
                message: format!("stream enumeration failed for {}: {error}", path.display()),
            });
        }
    })();
    unsafe { FindClose(handle) };
    result
}

fn validate_manifest(manifest: &TreeManifest) -> Result<()> {
    if manifest.schema_version != 1 {
        return Err(Failure {
            code: "MANIFEST_INVALID",
            message: "unsupported manifest version".to_owned(),
        });
    }
    let mut folded = HashSet::new();
    for entry in &manifest.entries {
        if entry.path == "." {
            continue;
        }
        validated_relative_components(&entry.path)?;
        if !folded.insert(entry.path.to_lowercase()) {
            return Err(Failure {
                code: "MANIFEST_CASE_COLLISION",
                message: format!("case-insensitive path collision at {}", entry.path),
            });
        }
    }
    Ok(())
}

fn validated_relative_components(value: &str) -> Result<Vec<OsString>> {
    if value.is_empty() || value == "." {
        return Err(Failure {
            code: "INVALID_PATH",
            message: "path must name a child".to_owned(),
        });
    }
    if value.contains('\\') || value.contains('\0') {
        return Err(Failure {
            code: "PATH_ESCAPE",
            message: format!("invalid separator in {value}"),
        });
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(Failure {
            code: "PATH_ESCAPE",
            message: "absolute path rejected".to_owned(),
        });
    }
    let mut components = Vec::new();
    for component in value.split('/') {
        validate_windows_component(component)?;
        components.push(OsString::from(component));
    }
    if components.is_empty() {
        return Err(Failure {
            code: "INVALID_PATH",
            message: "path has no components".to_owned(),
        });
    }
    Ok(components)
}

fn validate_windows_component(value: &str) -> Result<()> {
    if value.is_empty()
        || value.encode_utf16().count() > 255
        || value == "."
        || value == ".."
        || value.ends_with([' ', '.'])
        || value.chars().any(|character| {
            character < '\u{20}'
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(Failure {
            code: "PATH_ESCAPE",
            message: format!("invalid Windows path component: {value}"),
        });
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    if reserved {
        return Err(Failure {
            code: "PATH_ESCAPE",
            message: format!("reserved Windows path component: {value}"),
        });
    }
    Ok(())
}

fn split_leaf(components: &[OsString]) -> Result<(&[OsString], &OsString)> {
    components
        .split_last()
        .map(|(leaf, parents)| (parents, leaf))
        .ok_or_else(|| Failure {
            code: "INVALID_PATH",
            message: "path has no leaf".to_owned(),
        })
}

fn path_is_within(parent: &Path, child: &Path) -> bool {
    let parent_components = parent.components().collect::<Vec<_>>();
    let child_components = child.components().collect::<Vec<_>>();
    child_components.len() >= parent_components.len()
        && parent_components
            .iter()
            .zip(child_components.iter())
            .all(|(left, right)| component_equal(*left, *right))
}

fn component_equal(left: Component<'_>, right: Component<'_>) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

fn object_path(root: &Path, digest: &str) -> Result<PathBuf> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(Failure {
            code: "INVALID_HASH",
            message: format!("invalid object digest: {digest}"),
        });
    }
    Ok(root.join(&digest[..2]).join(&digest[2..]))
}

fn mode_for_path(path: &Path) -> u32 {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("exe" | "cmd" | "bat" | "com") => 0o755,
        _ => 0o644,
    }
}

fn assert_lease(path: &Path, expected: &str) -> Result<()> {
    let actual = fs::read_to_string(path).map_err(|error| failure("LEASE_UNAVAILABLE", error))?;
    if actual.trim_end() != expected {
        return Err(Failure {
            code: "FENCING_TOKEN_REVOKED",
            message: "fencing token no longer owns the lease".to_owned(),
        });
    }
    Ok(())
}

fn manifest_summary(manifest: &TreeManifest, manifest_path: &str) -> Value {
    json!({
        "schemaVersion": manifest.schema_version,
        "rootDevice": manifest.root_device,
        "byteLength": manifest.byte_length,
        "fileCount": manifest.file_count,
        "directoryCount": manifest.directory_count,
        "treeHash": manifest.tree_hash,
        "manifestPath": manifest_path
    })
}

fn canonical_json(value: &Value) -> Result<String> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(if *value { "true" } else { "false" }.to_owned()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => {
            serde_json::to_string(value).map_err(|error| failure("SERIALIZE_FAILED", error))
        }
        Value::Array(values) => {
            let serialized = values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("[{}]", serialized.join(",")))
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut serialized = Vec::with_capacity(keys.len());
            for key in keys {
                let encoded_key = serde_json::to_string(key)
                    .map_err(|error| failure("SERIALIZE_FAILED", error))?;
                serialized.push(format!("{encoded_key}:{}", canonical_json(&values[key])?));
            }
            Ok(format!("{{{}}}", serialized.join(",")))
        }
    }
}

fn environment_block(entries: &[(&str, &Path)]) -> Vec<u16> {
    let mut values = entries
        .iter()
        .map(|(key, value)| (key.to_string(), value.as_os_str().to_os_string()))
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left.0
            .to_ascii_lowercase()
            .cmp(&right.0.to_ascii_lowercase())
    });
    let mut block = Vec::new();
    for (key, value) in values {
        block.extend(OsStr::new(&key).encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn powershell_literal(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

fn quote_windows_argument(value: &str) -> String {
    if !value
        .chars()
        .any(|character| character.is_whitespace() || character == '"')
    {
        return value.to_owned();
    }
    let mut result = String::from("\"");
    let mut backslashes = 0usize;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            result.push_str(&"\\".repeat(backslashes * 2 + 1));
            result.push('"');
            backslashes = 0;
        } else {
            result.push_str(&"\\".repeat(backslashes));
            backslashes = 0;
            result.push(character);
        }
    }
    result.push_str(&"\\".repeat(backslashes * 2));
    result.push('"');
    result
}

fn sandbox_profile_name(path: &Path) -> String {
    let normalized = path.to_string_lossy().to_lowercase();
    let digest = hex::encode(Sha256::digest(normalized.as_bytes()));
    format!("model-pk-{}", &digest[..48])
}

fn wide_string(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_path(value: &Path) -> Vec<u16> {
    let units = value.as_os_str().encode_wide().collect::<Vec<_>>();
    let mut extended = extended_windows_path_units(&units);
    extended.push(0);
    extended
}

unsafe fn string_from_wide_ptr(value: *const u16) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut length = 0usize;
    while unsafe { *value.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) })
}

fn hresult_from_win32(error: u32) -> i32 {
    if error == 0 {
        0
    } else {
        (0x8007_0000u32 | (error & 0xffff)) as i32
    }
}

fn nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos()
}

fn checked_increment(value: u64, message: &'static str) -> Result<u64> {
    value.checked_add(1).ok_or_else(|| Failure {
        code: "LIMIT_EXCEEDED",
        message: message.to_owned(),
    })
}

fn failure(code: &'static str, error: impl std::fmt::Display) -> Failure {
    Failure {
        code,
        message: error.to_string(),
    }
}

fn architecture_name() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "x86") {
        "ia32"
    } else {
        std::env::consts::ARCH
    }
}
