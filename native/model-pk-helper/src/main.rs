#[cfg(unix)]
include!("unix.rs");

// Rebuild helper for 0.1.3

#[cfg(windows)]
include!("windows.rs");

#[cfg(not(any(unix, windows)))]
compile_error!("model-pk-helper supports Unix and Windows hosts only");

#[cfg(any(windows, test))]
fn extended_windows_path_units(value: &[u16]) -> Vec<u16> {
    const BACKSLASH: u16 = b'\\' as u16;
    const FORWARD_SLASH: u16 = b'/' as u16;
    const COLON: u16 = b':' as u16;
    const QUESTION: u16 = b'?' as u16;
    const DOT: u16 = b'.' as u16;

    let normalized = value
        .iter()
        .map(|unit| {
            if *unit == FORWARD_SLASH {
                BACKSLASH
            } else {
                *unit
            }
        })
        .collect::<Vec<_>>();
    let already_namespaced = normalized.starts_with(&[BACKSLASH, BACKSLASH, QUESTION, BACKSLASH])
        || normalized.starts_with(&[BACKSLASH, BACKSLASH, DOT, BACKSLASH])
        || normalized.starts_with(&[BACKSLASH, QUESTION, QUESTION, BACKSLASH]);
    if already_namespaced {
        return normalized;
    }
    if normalized.starts_with(&[BACKSLASH, BACKSLASH]) {
        let mut extended = r"\\?\UNC\".encode_utf16().collect::<Vec<_>>();
        extended.extend_from_slice(&normalized[2..]);
        return extended;
    }
    if normalized.len() >= 3 && normalized[1] == COLON && normalized[2] == BACKSLASH {
        let mut extended = r"\\?\".encode_utf16().collect::<Vec<_>>();
        extended.extend_from_slice(&normalized);
        return extended;
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::extended_windows_path_units;

    fn units(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    fn text(value: Vec<u16>) -> String {
        String::from_utf16(&value).expect("valid UTF-16")
    }

    #[test]
    fn converts_absolute_windows_paths_to_extended_length_form() {
        assert_eq!(
            text(extended_windows_path_units(&units(
                r"C:\archive\attempt\manifest.json"
            ))),
            r"\\?\C:\archive\attempt\manifest.json",
        );
        assert_eq!(
            text(extended_windows_path_units(&units(
                r"\\server\share\archive\manifest.json"
            ))),
            r"\\?\UNC\server\share\archive\manifest.json",
        );
        assert_eq!(
            text(extended_windows_path_units(&units(
                r"\\?\C:\already-extended"
            ))),
            r"\\?\C:\already-extended",
        );
        assert_eq!(
            text(extended_windows_path_units(&units(
                r"relative\manifest.json"
            ))),
            r"relative\manifest.json",
        );
    }
}
