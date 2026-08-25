# Security

## Reporting a vulnerability

Please report security issues privately rather than in public issues.

- **Email**: hui.sde.us@gmail.com (preferred)
- **GitHub**: use the repository's private vulnerability reporting form
  (Security → Report a vulnerability)

You can expect an acknowledgment within 3 business days and a coordinated fix
timeline after triage.

## Security notes for this project

- `run_kernel_code` executes model-authored source in a real `python3`/`node`
  subprocess and is **process confinement, not a security boundary**: kernel
  code has bash-equivalent trust, exactly like the harness's own
  `process`-isolated code backends. Only run kernels for users who may already
  run `bash`.
- The kernel subprocess is a hostile peer on an NDJSON wire: every inbound
  frame is re-validated field by field, forged member names never walk
  prototype chains, and a misbehaving kernel is graded up to termination
  (SIGINT → SIGTERM → SIGKILL) rather than crashing the host.
- Programs carry no deployed credentials by default: the kernel inherits the
  host environment and working directory, so gate this tool's `cwd`/`env`
  exposure per deployment, and treat workspace files as a trust boundary when
  running agents on untrusted repositories.
- Rough budget limits are configurable and enforced on the host
  (`maxWallMs`, `maxOutputBytes`); they bound resource use but are not a
  security mechanism.
