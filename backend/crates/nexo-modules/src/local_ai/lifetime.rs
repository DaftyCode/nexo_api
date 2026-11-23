//! The engine lives no longer than Nexo. Dropping its handle stops it when Nexo ends in
//! order; these ties stop it when Nexo is killed or fails too, so a model never stays in the
//! memory of the GPU on its own: a job object closed with the last handle of Nexo on Windows,
//! and the signal Linux sends a process when its parent ends.
use tokio::process::{Child, Command};

/// Asks the system to end the process `command` starts when Nexo ends.
pub(crate) fn before_start(command: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        let parent = std::process::id();
        // SAFETY: between fork and exec the closure calls only `prctl`, `getppid` and
        // `_exit`, which are async-signal-safe, and allocates nothing.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                // Nexo ended before the signal was asked for.
                if libc::getppid() as u32 != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

/// Puts the started `child` in the job that ends with Nexo (Windows).
pub(crate) fn after_start(child: &Child) {
    #[cfg(windows)]
    windows::tie(child);
    #[cfg(not(windows))]
    let _ = child;
}

#[cfg(all(test, windows))]
pub(crate) use windows::tied;

#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, sync::OnceLock};
    use tokio::process::Child;
    use windows_sys::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
    };

    /// The job of Nexo's engines; its handle closes only when Nexo's process ends.
    struct Job(HANDLE);
    // SAFETY: a job handle may be used from any thread; it is never closed while Nexo runs.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<&'static Job> {
        JOB.get_or_init(|| {
            // SAFETY: a job without name nor security attributes; the limits are a zeroed
            // structure of the right size with only the flag that ends its processes.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                (set != 0).then_some(Job(handle))
            }
        })
        .as_ref()
    }

    pub(super) fn tie(child: &Child) {
        if let (Some(job), Some(process)) = (job(), child.raw_handle()) {
            // SAFETY: both handles are open: the job for Nexo's life, the process while
            // `child` is borrowed. A failure leaves the stop on drop as the only one.
            unsafe {
                AssignProcessToJobObject(job.0, process as HANDLE);
            }
        }
    }

    /// Whether `child` is in the job that ends with Nexo.
    #[cfg(test)]
    pub(crate) fn tied(child: &Child) -> bool {
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        let (Some(job), Some(process)) = (job(), child.raw_handle()) else {
            return false;
        };
        let mut inside = 0;
        // SAFETY: both handles are open while `child` is borrowed.
        unsafe { IsProcessInJob(process as HANDLE, job.0, &mut inside) != 0 && inside != 0 }
    }
}
