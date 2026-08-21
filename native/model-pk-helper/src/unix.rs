use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const SLOT_HEADER_BYTES: usize = 64;
const SLOT_MAGIC: &[u8; 8] = b"MPKSLOT1";

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
        Err(_) => println!("{}", r#"{"ok":false,"error":{"code":"SERIALIZE_FAILED","message":"response serialization failed"}}"#),
    }
}

fn run() -> Result<Value> {
    let mut input = Vec::new();
    io::stdin()
        .take(MAX_RESPONSE_BYTES as u64)
        .read_to_end(&mut input)
        .map_err(|error| failure("STDIN_FAILED", error))?;
    let request: Request = serde_json::from_slice(&input)
        .map_err(|error| failure("INVALID_REQUEST", error))?;
    match request {
        Request::Version => Ok(json!({
            "version": VERSION,
            "protocolVersion": 1,
            "platform": platform_name(),
            "arch": architecture_name(),
            "features": ["openat", "nofollow", "tree-snapshot", "capacity-slot", "f-preallocate"]
        })),
        Request::Reserve { path, byte_length } => reserve(&path, byte_length),
        Request::Scan { root, max_bytes, max_files } => {
            let manifest = scan_tree(Path::new(&root), max_bytes, max_files, None)?;
            serde_json::to_value(manifest).map_err(|error| failure("SERIALIZE_FAILED", error))
        }
        Request::Snapshot { source_root, object_root, max_bytes, max_files } => {
            fs::create_dir_all(&object_root).map_err(|error| failure("OBJECT_ROOT_CREATE_FAILED", error))?;
            set_mode(Path::new(&object_root), 0o700)?;
            let manifest = scan_tree(
                Path::new(&source_root),
                max_bytes,
                max_files,
                Some(Path::new(&object_root)),
            )?;
            serde_json::to_value(manifest).map_err(|error| failure("SERIALIZE_FAILED", error))
        }
        Request::ScanTo { root, manifest_path, max_bytes, max_files } => {
            let manifest = scan_tree(Path::new(&root), max_bytes, max_files, None)?;
            write_manifest(Path::new(&manifest_path), &manifest)?;
            Ok(manifest_summary(&manifest, &manifest_path))
        }
        Request::SnapshotTo { source_root, object_root, manifest_path, max_bytes, max_files } => {
            fs::create_dir_all(&object_root).map_err(|error| failure("OBJECT_ROOT_CREATE_FAILED", error))?;
            set_mode(Path::new(&object_root), 0o700)?;
            let manifest = scan_tree(
                Path::new(&source_root),
                max_bytes,
                max_files,
                Some(Path::new(&object_root)),
            )?;
            write_manifest(Path::new(&manifest_path), &manifest)?;
            Ok(manifest_summary(&manifest, &manifest_path))
        }
        Request::Materialize { manifest_path, object_root, destination_root } => {
            materialize(Path::new(&manifest_path), Path::new(&object_root), Path::new(&destination_root))
        }
        Request::Read { root, path, max_bytes } => safe_read(Path::new(&root), &path, max_bytes),
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
        Request::Replace { root, path, old, new, all, lease_path, fencing_token } => {
            safe_replace(
                Path::new(&root),
                &path,
                &old,
                &new,
                all.unwrap_or(false),
                Path::new(&lease_path),
                &fencing_token,
            )
        }
        Request::SlotWrite { path, generation, payload_base64 } => {
            slot_write(Path::new(&path), generation, &payload_base64)
        }
        Request::SlotRead { path } => slot_read(Path::new(&path)),
    }
}

fn reserve(path: &str, byte_length: u64) -> Result<Value> {
    if byte_length < 2 * SLOT_HEADER_BYTES as u64 + 2 {
        return Err(Failure { code: "INVALID_RESERVATION", message: "reservation is too small".to_owned() });
    }
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| failure("RESERVE_CREATE_FAILED", error))?;
        set_mode(parent, 0o700)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|error| failure("RESERVE_OPEN_FAILED", error))?;
    preallocate(&file, byte_length)?;
    file.set_len(byte_length).map_err(|error| failure("RESERVE_TRUNCATE_FAILED", error))?;
    file.sync_all().map_err(|error| failure("RESERVE_FSYNC_FAILED", error))?;
    set_mode(path, 0o600)?;
    Ok(json!({ "path": path, "byteLength": byte_length }))
}

#[cfg(target_os = "macos")]
fn preallocate(file: &File, byte_length: u64) -> Result<()> {
    let mut store = libc::fstore_t {
        fst_flags: libc::F_ALLOCATECONTIG,
        fst_posmode: libc::F_PEOFPOSMODE,
        fst_offset: 0,
        fst_length: byte_length as i64,
        fst_bytesalloc: 0,
    };
    let mut result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_PREALLOCATE, &mut store) };
    if result == -1 {
        store.fst_flags = libc::F_ALLOCATEALL;
        result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_PREALLOCATE, &mut store) };
    }
    if result == -1 {
        return Err(failure("F_PREALLOCATE_FAILED", io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn preallocate(file: &File, byte_length: u64) -> Result<()> {
    let result = unsafe { libc::posix_fallocate(file.as_raw_fd(), 0, byte_length as i64) };
    if result != 0 {
        return Err(failure("PREALLOCATE_FAILED", io::Error::from_raw_os_error(result)));
    }
    Ok(())
}

fn scan_tree(root: &Path, max_bytes: u64, max_files: u64, object_root: Option<&Path>) -> Result<TreeManifest> {
    let root_fd = open_absolute_directory(root)?;
    let root_stat = fstat(root_fd.as_raw_fd())?;
    let mut limits = ScanLimits { max_bytes, max_files, bytes: 0, files: 0, directories: 1 };
    let mut entries = vec![ManifestEntry {
        path: ".".to_owned(),
        kind: EntryKind::Directory,
        byte_length: 0,
        mode: 0o755,
        hash: None,
    }];
    walk_directory(
        root_fd.as_raw_fd(),
        Path::new(""),
        root_stat.st_dev as u64,
        &mut limits,
        &mut entries,
        object_root,
    )?;
    entries.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    let entries_value = serde_json::to_value(&entries).map_err(|error| failure("SERIALIZE_FAILED", error))?;
    let canonical = canonical_json(&entries_value)?.into_bytes();
    let tree_hash = format!("sha256:{}", hex::encode(Sha256::digest(canonical)));
    Ok(TreeManifest {
        schema_version: 1,
        root_device: root_stat.st_dev as u64,
        byte_length: limits.bytes,
        file_count: limits.files,
        directory_count: limits.directories,
        entries,
        tree_hash,
    })
}

fn walk_directory(
    directory_fd: RawFd,
    relative: &Path,
    root_device: u64,
    limits: &mut ScanLimits,
    entries: &mut Vec<ManifestEntry>,
    object_root: Option<&Path>,
) -> Result<()> {
    for name in directory_names(directory_fd)? {
        let name_c = cstring_os(&name)?;
        let stat = fstatat_nofollow(directory_fd, &name_c)?;
        let mode = stat.st_mode as libc::mode_t;
        let child_relative = relative.join(&name);
        let child_path = path_to_manifest(&child_relative)?;
        if stat.st_dev as u64 != root_device {
            return Err(Failure { code: "MOUNT_POINT_REJECTED", message: format!("mount/device boundary at {child_path}") });
        }
        match mode & libc::S_IFMT {
            libc::S_IFDIR => {
                let child_fd = openat_directory(directory_fd, &name_c)?;
                let opened = fstat(child_fd.as_raw_fd())?;
                ensure_same_object(&stat, &opened, &child_path)?;
                limits.directories = checked_increment(limits.directories, "directory count overflow")?;
                entries.push(ManifestEntry {
                    path: child_path,
                    kind: EntryKind::Directory,
                    byte_length: 0,
                    mode: 0o755,
                    hash: None,
                });
                walk_directory(
                    child_fd.as_raw_fd(),
                    &child_relative,
                    root_device,
                    limits,
                    entries,
                    object_root,
                )?;
            }
            libc::S_IFREG => {
                if stat.st_nlink != 1 {
                    return Err(Failure { code: "HARD_LINK_REJECTED", message: format!("hard link at {child_path}") });
                }
                if stat.st_size < 0 {
                    return Err(Failure { code: "INVALID_FILE_SIZE", message: format!("negative file size at {child_path}") });
                }
                let byte_length = stat.st_size as u64;
                limits.files = checked_increment(limits.files, "file count overflow")?;
                limits.bytes = limits.bytes.checked_add(byte_length)
                    .ok_or_else(|| Failure { code: "LIMIT_EXCEEDED", message: "byte count overflow".to_owned() })?;
                if limits.files > limits.max_files {
                    return Err(Failure { code: "FILE_LIMIT_EXCEEDED", message: format!("file count exceeds {}", limits.max_files) });
                }
                if limits.bytes > limits.max_bytes {
                    return Err(Failure { code: "BYTE_LIMIT_EXCEEDED", message: format!("tree bytes exceed {}", limits.max_bytes) });
                }
                let mut file = openat_file_read(directory_fd, &name_c)?;
                let opened = fstat(file.as_raw_fd())?;
                ensure_same_object(&stat, &opened, &child_path)?;
                let (digest, bytes_read) = hash_and_snapshot_file(&mut file, object_root)?;
                let after = fstat(file.as_raw_fd())?;
                ensure_unchanged_file(&stat, &after, bytes_read, &child_path)?;
                entries.push(ManifestEntry {
                    path: child_path,
                    kind: EntryKind::File,
                    byte_length,
                    mode: if mode & 0o111 != 0 { 0o755 } else { 0o644 },
                    hash: Some(format!("sha256:{digest}")),
                });
            }
            libc::S_IFLNK => {
                return Err(Failure { code: "SYMLINK_REJECTED", message: format!("symlink at {child_path}") });
            }
            _ => {
                return Err(Failure { code: "SPECIAL_FILE_REJECTED", message: format!("special file at {child_path}") });
            }
        }
    }
    Ok(())
}

fn materialize(manifest_path: &Path, object_root: &Path, destination_root: &Path) -> Result<Value> {
    let bytes = fs::read(manifest_path).map_err(|error| failure("MANIFEST_READ_FAILED", error))?;
    let manifest: TreeManifest = serde_json::from_slice(&bytes)
        .map_err(|error| failure("MANIFEST_INVALID", error))?;
    if manifest.schema_version != 1 {
        return Err(Failure { code: "MANIFEST_INVALID", message: "unsupported manifest version".to_owned() });
    }
    fs::create_dir(destination_root).or_else(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists { Ok(()) } else { Err(error) }
    }).map_err(|error| failure("DESTINATION_CREATE_FAILED", error))?;
    set_mode(destination_root, 0o700)?;
    let root_fd = open_absolute_directory(destination_root)?;
    for entry in &manifest.entries {
        if entry.path == "." { continue; }
        let components = validated_relative_components(&entry.path)?;
        match entry.kind {
            EntryKind::Directory => {
                create_directory_chain(root_fd.as_raw_fd(), &components, entry.mode)?;
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
                let object_bytes = fs::read(&object_path).map_err(|error| failure("OBJECT_READ_FAILED", error))?;
                let actual = hex::encode(Sha256::digest(&object_bytes));
                if actual != digest || object_bytes.len() as u64 != entry.byte_length {
                    return Err(Failure { code: "OBJECT_HASH_MISMATCH", message: format!("object mismatch: {digest}") });
                }
                write_relative_file(root_fd.as_raw_fd(), &components, &object_bytes, entry.mode)?;
            }
        }
    }
    sync_fd(root_fd.as_raw_fd())?;
    Ok(json!({
        "treeHash": manifest.tree_hash,
        "fileCount": manifest.file_count,
        "byteLength": manifest.byte_length
    }))
}

fn safe_read(root: &Path, relative: &str, max_bytes: u64) -> Result<Value> {
    let components = validated_relative_components(relative)?;
    let root_fd = open_absolute_directory(root)?;
    let mut file = open_relative_read(root_fd.as_raw_fd(), &components)?;
    let metadata = file.metadata().map_err(|error| failure("READ_STAT_FAILED", error))?;
    if metadata.len() > max_bytes {
        return Err(Failure { code: "READ_LIMIT_EXCEEDED", message: format!("file is {} bytes", metadata.len()) });
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(|error| failure("FILE_READ_FAILED", error))?;
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
    executable: bool,
    lease_path: &Path,
    fencing_token: &str,
) -> Result<Value> {
    assert_lease(lease_path, fencing_token)?;
    let bytes = BASE64.decode(encoded).map_err(|error| failure("BASE64_INVALID", error))?;
    let components = validated_relative_components(relative)?;
    let root_fd = open_absolute_directory(root)?;
    write_relative_file(root_fd.as_raw_fd(), &components, &bytes, if executable { 0o755 } else { 0o644 })?;
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
        return Err(Failure { code: "INVALID_REPLACE", message: "old text is empty".to_owned() });
    }
    let components = validated_relative_components(relative)?;
    let root_fd = open_absolute_directory(root)?;
    let mut file = open_relative_read(root_fd.as_raw_fd(), &components)?;
    let mut bytes = Vec::new();
    (&mut file).take(MAX_RESPONSE_BYTES as u64).read_to_end(&mut bytes)
        .map_err(|error| failure("FILE_READ_FAILED", error))?;
    let content = String::from_utf8(bytes).map_err(|error| failure("FILE_NOT_UTF8", error))?;
    let matches = content.match_indices(old).count();
    if matches == 0 {
        return Err(Failure { code: "OLD_TEXT_NOT_FOUND", message: "old text not found".to_owned() });
    }
    if !replace_all && matches != 1 {
        return Err(Failure { code: "OLD_TEXT_AMBIGUOUS", message: format!("old text occurs {matches} times") });
    }
    let replaced = if replace_all { content.replace(old, new) } else { content.replacen(old, new, 1) };
    let mode = fstat(file.as_raw_fd())?.st_mode as u32 & 0o777;
    drop(file);
    assert_lease(lease_path, fencing_token)?;
    write_relative_file(root_fd.as_raw_fd(), &components, replaced.as_bytes(), mode)?;
    assert_lease(lease_path, fencing_token)?;
    Ok(json!({
        "replacements": if replace_all { matches } else { 1 },
        "byteLength": replaced.len(),
        "hash": format!("sha256:{}", hex::encode(Sha256::digest(replaced.as_bytes())))
    }))
}

fn slot_write(path: &Path, generation: u64, encoded: &str) -> Result<Value> {
    let payload = BASE64.decode(encoded).map_err(|error| failure("BASE64_INVALID", error))?;
    let mut file = OpenOptions::new().read(true).write(true).open(path)
        .map_err(|error| failure("SLOT_OPEN_FAILED", error))?;
    let length = file.metadata().map_err(|error| failure("SLOT_STAT_FAILED", error))?.len() as usize;
    let region_size = length / 2;
    if region_size <= SLOT_HEADER_BYTES || payload.len() > region_size - SLOT_HEADER_BYTES {
        return Err(Failure { code: "SLOT_PAYLOAD_TOO_LARGE", message: format!("payload={} capacity={}", payload.len(), region_size.saturating_sub(SLOT_HEADER_BYTES)) });
    }
    let region = generation as usize % 2;
    let offset = region * region_size;
    let digest = Sha256::digest(&payload);
    let mut header = [0u8; SLOT_HEADER_BYTES];
    header[0..8].copy_from_slice(SLOT_MAGIC);
    header[8..16].copy_from_slice(&generation.to_le_bytes());
    header[16..24].copy_from_slice(&(payload.len() as u64).to_le_bytes());
    header[24..56].copy_from_slice(&digest);
    file.seek(SeekFrom::Start(offset as u64)).map_err(|error| failure("SLOT_SEEK_FAILED", error))?;
    file.write_all(&header).map_err(|error| failure("SLOT_WRITE_FAILED", error))?;
    file.write_all(&payload).map_err(|error| failure("SLOT_WRITE_FAILED", error))?;
    file.sync_all().map_err(|error| failure("SLOT_FSYNC_FAILED", error))?;
    Ok(json!({ "generation": generation, "checksum": format!("sha256:{}", hex::encode(digest)) }))
}

fn slot_read(path: &Path) -> Result<Value> {
    let mut file = File::open(path).map_err(|error| failure("SLOT_OPEN_FAILED", error))?;
    let length = file.metadata().map_err(|error| failure("SLOT_STAT_FAILED", error))?.len() as usize;
    let region_size = length / 2;
    let mut candidates: Vec<(u64, Vec<u8>, String)> = Vec::new();
    for region in 0..2 {
        file.seek(SeekFrom::Start((region * region_size) as u64)).map_err(|error| failure("SLOT_SEEK_FAILED", error))?;
        let mut header = [0u8; SLOT_HEADER_BYTES];
        if file.read_exact(&mut header).is_err() || &header[0..8] != SLOT_MAGIC { continue; }
        let generation = u64::from_le_bytes(header[8..16].try_into().unwrap());
        let payload_length = u64::from_le_bytes(header[16..24].try_into().unwrap()) as usize;
        if payload_length > region_size.saturating_sub(SLOT_HEADER_BYTES) { continue; }
        let mut payload = vec![0u8; payload_length];
        if file.read_exact(&mut payload).is_err() { continue; }
        let digest = Sha256::digest(&payload);
        if digest.as_slice() != &header[24..56] { continue; }
        candidates.push((generation, payload, format!("sha256:{}", hex::encode(digest))));
    }
    let (generation, payload, checksum) = candidates.into_iter().max_by_key(|item| item.0)
        .ok_or_else(|| Failure { code: "SLOT_EMPTY", message: "no valid slot generation".to_owned() })?;
    Ok(json!({ "generation": generation, "checksum": checksum, "payloadBase64": BASE64.encode(payload) }))
}

fn assert_lease(path: &Path, expected: &str) -> Result<()> {
    let actual = fs::read_to_string(path).map_err(|error| failure("LEASE_UNAVAILABLE", error))?;
    if actual.trim_end() != expected {
        return Err(Failure { code: "FENCING_TOKEN_REVOKED", message: "fencing token no longer owns the lease".to_owned() });
    }
    Ok(())
}

fn open_absolute_directory(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(Failure { code: "PATH_NOT_ABSOLUTE", message: format!("path is not absolute: {}", path.display()) });
    }
    let slash = CString::new("/").unwrap();
    let fd = unsafe { libc::open(slash.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 { return Err(failure("ROOT_OPEN_FAILED", io::Error::last_os_error())); }
    let mut current = unsafe { File::from_raw_fd(fd) };
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => current = openat_directory(current.as_raw_fd(), &cstring_os(name)?)?,
            _ => return Err(Failure { code: "PATH_ESCAPE", message: format!("invalid absolute path: {}", path.display()) }),
        }
    }
    Ok(current)
}

fn openat_directory(parent: RawFd, name: &CString) -> Result<File> {
    let fd = unsafe { libc::openat(parent, name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 { return Err(failure("DIRECTORY_OPEN_FAILED", io::Error::last_os_error())); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn openat_file_read(parent: RawFd, name: &CString) -> Result<File> {
    let fd = unsafe { libc::openat(parent, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 { return Err(failure("FILE_OPEN_FAILED", io::Error::last_os_error())); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_relative_read(root: RawFd, components: &[OsString]) -> Result<File> {
    let (parents, leaf) = split_leaf(components)?;
    let parent = open_directory_chain(root, parents, false)?;
    openat_file_read(parent.as_raw_fd(), &cstring_os(leaf)?)
}

fn write_relative_file(root: RawFd, components: &[OsString], bytes: &[u8], mode: u32) -> Result<()> {
    let (parents, leaf) = split_leaf(components)?;
    let parent = open_directory_chain(root, parents, true)?;
    let leaf_c = cstring_os(leaf)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temp_name = CString::new(format!(".model-pk-tmp-{}-{nonce}", unsafe { libc::getpid() }))
        .map_err(|error| failure("INVALID_PATH", error))?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temp_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 { return Err(failure("TEMP_CREATE_FAILED", io::Error::last_os_error())); }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| -> Result<()> {
        file.write_all(bytes).map_err(|error| failure("FILE_WRITE_FAILED", error))?;
        file.set_permissions(fs::Permissions::from_mode(mode & 0o755))
            .map_err(|error| failure("FILE_CHMOD_FAILED", error))?;
        file.sync_all().map_err(|error| failure("FILE_FSYNC_FAILED", error))?;
        if unsafe { libc::renameat(parent.as_raw_fd(), temp_name.as_ptr(), parent.as_raw_fd(), leaf_c.as_ptr()) } != 0 {
            return Err(failure("FILE_RENAME_FAILED", io::Error::last_os_error()));
        }
        sync_fd(parent.as_raw_fd())?;
        Ok(())
    })();
    if result.is_err() {
        unsafe { libc::unlinkat(parent.as_raw_fd(), temp_name.as_ptr(), 0); }
    }
    result
}

fn open_directory_chain(root: RawFd, components: &[OsString], create: bool) -> Result<File> {
    let duplicate = unsafe { libc::dup(root) };
    if duplicate < 0 { return Err(failure("DUP_FAILED", io::Error::last_os_error())); }
    let mut current = unsafe { File::from_raw_fd(duplicate) };
    for component in components {
        let name = cstring_os(component)?;
        match openat_directory(current.as_raw_fd(), &name) {
            Ok(next) => current = next,
            Err(_error) if create => {
                if unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                    let os_error = io::Error::last_os_error();
                    if os_error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(failure("DIRECTORY_CREATE_FAILED", os_error));
                    }
                }
                current = openat_directory(current.as_raw_fd(), &name)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(current)
}

fn create_directory_chain(root: RawFd, components: &[OsString], mode: u32) -> Result<()> {
    let directory = open_directory_chain(root, components, true)?;
    if unsafe { libc::fchmod(directory.as_raw_fd(), (mode & 0o755) as libc::mode_t) } != 0 {
        return Err(failure("DIRECTORY_CHMOD_FAILED", io::Error::last_os_error()));
    }
    sync_fd(directory.as_raw_fd())
}

fn directory_names(fd: RawFd) -> Result<Vec<OsString>> {
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 { return Err(failure("DUP_FAILED", io::Error::last_os_error())); }
    let directory = unsafe { libc::fdopendir(duplicate) };
    if directory.is_null() {
        unsafe { libc::close(duplicate); }
        return Err(failure("READDIR_OPEN_FAILED", io::Error::last_os_error()));
    }
    let mut names = Vec::new();
    loop {
        unsafe { *libc::__error() = 0; }
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::closedir(directory); }
            if error.raw_os_error().unwrap_or(0) != 0 { return Err(failure("READDIR_FAILED", error)); }
            break;
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." { continue; }
        names.push(OsString::from_vec(bytes.to_vec()));
    }
    names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(names)
}

fn fstat(fd: RawFd) -> Result<libc::stat> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return Err(failure("FSTAT_FAILED", io::Error::last_os_error()));
    }
    Ok(stat)
}

fn fstatat_nofollow(parent: RawFd, name: &CString) -> Result<libc::stat> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(parent, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(failure("FSTATAT_FAILED", io::Error::last_os_error()));
    }
    Ok(stat)
}

fn ensure_same_object(before: &libc::stat, after: &libc::stat, path: &str) -> Result<()> {
    if before.st_dev != after.st_dev || before.st_ino != after.st_ino
        || (before.st_mode & libc::S_IFMT) != (after.st_mode & libc::S_IFMT)
    {
        return Err(Failure { code: "PATH_RACE_DETECTED", message: format!("object changed while opening {path}") });
    }
    Ok(())
}

fn hash_and_snapshot_file(file: &mut File, object_root: Option<&Path>) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut bytes_read = 0u64;
    let mut temp: Option<(PathBuf, File)> = match object_root {
        None => None,
        Some(root) => {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
            let path = root.join(format!(".model-pk-object-{}-{nonce}", unsafe { libc::getpid() }));
            let output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
                .open(&path)
                .map_err(|error| failure("OBJECT_TEMP_CREATE_FAILED", error))?;
            Some((path, output))
        }
    };
    let result = (|| -> Result<(String, u64)> {
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| failure("FILE_READ_FAILED", error))?;
            if read == 0 { break; }
            hasher.update(&buffer[..read]);
            bytes_read = bytes_read.checked_add(read as u64)
                .ok_or_else(|| Failure { code: "LIMIT_EXCEEDED", message: "read byte count overflow".to_owned() })?;
            if let Some((_, output)) = temp.as_mut() {
                output.write_all(&buffer[..read]).map_err(|error| failure("OBJECT_WRITE_FAILED", error))?;
            }
        }
        let digest = hex::encode(hasher.finalize());
        if let Some((temp_path, output)) = temp.as_mut() {
            output.sync_all().map_err(|error| failure("OBJECT_FSYNC_FAILED", error))?;
            publish_temp_object(temp_path, object_root.unwrap(), &digest, bytes_read)?;
        }
        Ok((digest, bytes_read))
    })();
    if let Some((temp_path, _)) = temp {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn publish_temp_object(temp_path: &Path, root: &Path, digest: &str, byte_length: u64) -> Result<()> {
    let path = object_path(root, digest)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| failure("OBJECT_DIR_CREATE_FAILED", error))?;
        set_mode(parent, 0o700)?;
    }
    match fs::hard_link(temp_path, &path) {
        Ok(()) => set_mode(&path, 0o600)?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let mut existing = File::open(&path).map_err(|read_error| failure("OBJECT_READ_FAILED", read_error))?;
            let metadata = existing.metadata().map_err(|read_error| failure("OBJECT_READ_FAILED", read_error))?;
            if metadata.len() != byte_length {
                return Err(Failure { code: "OBJECT_HASH_MISMATCH", message: format!("existing object size mismatch: {digest}") });
            }
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 128 * 1024];
            loop {
                let read = existing.read(&mut buffer).map_err(|read_error| failure("OBJECT_READ_FAILED", read_error))?;
                if read == 0 { break; }
                hasher.update(&buffer[..read]);
            }
            if hex::encode(hasher.finalize()) != digest {
                return Err(Failure { code: "OBJECT_HASH_MISMATCH", message: format!("existing object mismatch: {digest}") });
            }
        }
        Err(error) => return Err(failure("OBJECT_CREATE_FAILED", error)),
    }
    Ok(())
}

fn ensure_unchanged_file(before: &libc::stat, after: &libc::stat, bytes_read: u64, path: &str) -> Result<()> {
    ensure_same_object(before, after, path)?;
    if after.st_size < 0 || after.st_size as u64 != bytes_read || before.st_size != after.st_size
        || before.st_mtime != after.st_mtime
        || before.st_mtime_nsec != after.st_mtime_nsec
        || before.st_ctime != after.st_ctime
        || before.st_ctime_nsec != after.st_ctime_nsec
    {
        return Err(Failure { code: "FILE_CHANGED_DURING_SCAN", message: format!("file changed while scanning {path}") });
    }
    Ok(())
}

fn write_manifest(path: &Path, manifest: &TreeManifest) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| failure("MANIFEST_DIR_CREATE_FAILED", error))?;
        set_mode(parent, 0o700)?;
    }
    let bytes = serde_json::to_vec(manifest).map_err(|error| failure("SERIALIZE_FAILED", error))?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temporary = path.with_extension(format!("tmp-{}-{nonce}", unsafe { libc::getpid() }));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new().create_new(true).write(true).mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&temporary).map_err(|error| failure("MANIFEST_CREATE_FAILED", error))?;
        file.write_all(&bytes).map_err(|error| failure("MANIFEST_WRITE_FAILED", error))?;
        file.sync_all().map_err(|error| failure("MANIFEST_FSYNC_FAILED", error))?;
        fs::rename(&temporary, path).map_err(|error| failure("MANIFEST_RENAME_FAILED", error))?;
        set_mode(path, 0o600)?;
        if let Some(parent) = path.parent() {
            let directory = File::open(parent).map_err(|error| failure("MANIFEST_DIR_OPEN_FAILED", error))?;
            sync_fd(directory.as_raw_fd())?;
        }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
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
        Value::String(value) => serde_json::to_string(value).map_err(|error| failure("SERIALIZE_FAILED", error)),
        Value::Array(values) => {
            let serialized = values.iter().map(canonical_json).collect::<Result<Vec<_>>>()?;
            Ok(format!("[{}]", serialized.join(",")))
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut serialized = Vec::with_capacity(keys.len());
            for key in keys {
                let encoded_key = serde_json::to_string(key).map_err(|error| failure("SERIALIZE_FAILED", error))?;
                serialized.push(format!("{encoded_key}:{}", canonical_json(&values[key])?));
            }
            Ok(format!("{{{}}}", serialized.join(",")))
        }
    }
}

fn object_path(root: &Path, digest: &str) -> Result<PathBuf> {
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err(Failure { code: "INVALID_HASH", message: format!("invalid object digest: {digest}") });
    }
    Ok(root.join(&digest[..2]).join(&digest[2..]))
}

fn validated_relative_components(value: &str) -> Result<Vec<OsString>> {
    if value.is_empty() || value == "." {
        return Err(Failure { code: "INVALID_PATH", message: "path must name a child".to_owned() });
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(Failure { code: "PATH_ESCAPE", message: "absolute path rejected".to_owned() });
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) if !name.as_bytes().is_empty() => components.push(name.to_os_string()),
            _ => return Err(Failure { code: "PATH_ESCAPE", message: format!("invalid component in {value}") }),
        }
    }
    if components.is_empty() {
        return Err(Failure { code: "INVALID_PATH", message: "path has no components".to_owned() });
    }
    Ok(components)
}

fn split_leaf(components: &[OsString]) -> Result<(&[OsString], &OsString)> {
    components.split_last().map(|(leaf, parents)| (parents, leaf))
        .ok_or_else(|| Failure { code: "INVALID_PATH", message: "path has no leaf".to_owned() })
}

fn path_to_manifest(path: &Path) -> Result<String> {
    path.to_str().map(ToOwned::to_owned)
        .ok_or_else(|| Failure { code: "NON_UTF8_PATH", message: format!("path is not UTF-8: {}", path.display()) })
}

fn cstring_os(value: &OsStr) -> Result<CString> {
    CString::new(value.as_bytes()).map_err(|error| failure("INVALID_PATH", error))
}

fn set_mode(path: &Path, mode: u32) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| failure("CHMOD_FAILED", error))
}

fn sync_fd(fd: RawFd) -> Result<()> {
    if unsafe { libc::fsync(fd) } != 0 {
        return Err(failure("FSYNC_FAILED", io::Error::last_os_error()));
    }
    Ok(())
}

fn checked_increment(value: u64, message: &'static str) -> Result<u64> {
    value.checked_add(1).ok_or_else(|| Failure { code: "LIMIT_EXCEEDED", message: message.to_owned() })
}

fn failure(code: &'static str, error: impl std::fmt::Display) -> Failure {
    Failure { code, message: error.to_string() }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS }
}

fn architecture_name() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" }
    else if cfg!(target_arch = "x86_64") { "x64" }
    else { std::env::consts::ARCH }
}
