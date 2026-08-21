#[cfg(unix)]
include!("unix.rs");

#[cfg(windows)]
include!("windows.rs");

#[cfg(not(any(unix, windows)))]
compile_error!("model-pk-helper supports Unix and Windows hosts only");
