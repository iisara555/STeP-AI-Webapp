# Retired unsafe quota helper — DO NOT INSTALL

The earlier 17 validation checks did **not** establish a safe privilege boundary. A caller could choose another project's ID, and replace/rename a checked directory or ancestor before the path-based `xfs_quota` command. Nested/bind mounts were not pinned. A numeric range does not establish exclusive ownership. `clear` could remove another allocation's limits. The earlier claim that harm was limited to the intended folder was incorrect.

The executable now refuses every request, including root invocations, before any inspection or mutation. The sudoers proposal now contains comments only. No host installation/rule was changed. `test-validation.sh` checks refusal without creating host-storage fixtures or stripping the root check.

The replacement **nonprivileged integration** is `server/src/workspace/disk-provisioning.ts`; exact broker prerequisites and remaining disk/inode acceptance are in `docs/workspace-disk-provisioning.md`. There is intentionally no privileged backend to install from this checkout.
