/**
 * The persistent Python kernel embedded as source. One long-lived `python3`
 * subprocess runs this script; the host and it speak NDJSON over stdio. The
 * script is deliberately SELF-CONTAINED (standard library only) so no
 * virtualenv, package install, or site customization is needed to run model
 * code against a persistent namespace and event loop.
 *
 * Wire protocol (one JSON object per line):
 * - host -> kernel: `{"type":"exec","id":str,"code":str,"namespaces":[...],"cwd"?,"env"?}`,
 *   `{"type":"reply","id":str,"seq":int,"ok":bool,"value"?|"message"}`,
 *   `{"type":"exit"}`
 * - kernel -> host: `{"type":"ready","pid":int}`, then per exec:
 *   `{"type":"started","id"}`, `{"type":"log","id","text","stream"?}`,
 *   `{"type":"call","id","seq":int,"global","name","args"}`,
 *   `{"type":"error","id","ename","evalue","traceback":[]}`,
 *   `{"type":"done","id","status":"ok"|"error","value"?,"executionCount":int,"cancelled":bool}`
 *
 * The runner is a persistent kernel: `user_ns` and one asyncio event loop
 * survive across cells, so top-level `await` interleaves and assignments
 * persist; tool bindings are bridged through wire frames that the host
 * resolves against the CURRENT run's namespaces.
 *
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/python/runner
 */

export const PYTHON_RUNNER = String.raw`"""DSH Python kernel runner (embedded).

Persistent subprocess kernel for the dsh code-runtime seam's Python backend.
Protocol: one JSON object per line on stdin (host->kernel) and stdout
(kernel->host). Self-contained: standard library only.
"""

from __future__ import annotations

import ast
import asyncio
import builtins
import contextvars
import importlib
import io
import json
import marshal
import os
import pickle
import signal
import sys
import threading
import time
import traceback
import types
import zlib
from typing import Any

# ---------------------------------------------------------------------------
# Frame output + fd-1 capture (children must not corrupt the NDJSON channel)
# ---------------------------------------------------------------------------

try:
    _FRAME_FD = os.dup(sys.__stdout__.fileno())
    _RAW_FD = os.fdopen(_FRAME_FD, "w", encoding="utf-8", errors="backslashreplace")
    _CAPTURE_READ_FD, _capture_write_fd = os.pipe()
    os.dup2(_capture_write_fd, sys.__stdout__.fileno())
    os.close(_capture_write_fd)
except (AttributeError, OSError, ValueError, io.UnsupportedOperation):
    _RAW_FD = sys.__stdout__
    _CAPTURE_READ_FD = None

_OUT_LOCK = threading.Lock()


def _json_default(value: Any) -> Any:
    try:
        return repr(value)
    except Exception:
        return f"<unrepr {type(value).__name__}>"


def _emit(frame: dict) -> None:
    """Serialize one frame and write it as a single NDJSON line."""
    line = json.dumps(frame, ensure_ascii=False, default=_json_default)
    with _OUT_LOCK:
        _RAW_FD.write(line)
        _RAW_FD.write("\n")
        _RAW_FD.flush()


class _StreamProxy(io.TextIOBase):
    """Route python-side stdout/stderr into per-run log frames.

    Coalesces writes per run id (one frame per complete line or per 8 KiB)
    so a plain print() plus its newline costs one frame.
    """

    _MAX_BUFFER = 8192

    def __init__(self, stream: str) -> None:
        super().__init__()
        self._stream = stream
        self._lock = threading.Lock()
        self._buffers: dict[str, str] = {}

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def write(self, data: Any) -> int:  # type: ignore[override]
        if not isinstance(data, str):
            data = str(data)
        if not data:
            return 0
        rid = _CURRENT_RID.get()
        if rid is None:
            return len(data)
        emit_text = None
        with self._lock:
            buf = self._buffers.pop(rid, "") + data
            if len(buf) >= self._MAX_BUFFER:
                emit_text = buf
            else:
                nl = buf.rfind("\n")
                if nl >= 0:
                    emit_text = buf[: nl + 1]
                    rest = buf[nl + 1 :]
                    if rest:
                        self._buffers[rid] = rest
                else:
                    self._buffers[rid] = buf
        if emit_text:
            _emit({"type": "log", "id": rid, "text": emit_text, "stream": self._stream})
        return len(data)

    def flush(self) -> None:
        rid = _CURRENT_RID.get()
        if rid is not None:
            self.flush_rid(rid)

    def flush_rid(self, rid: str) -> None:
        with self._lock:
            buf = self._buffers.pop(rid, None)
        if buf:
            _emit({"type": "log", "id": rid, "text": buf, "stream": self._stream})


def _flush_stream_proxies(rid: str) -> None:
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, _StreamProxy):
            stream.flush_rid(rid)


_RAW_STDERR = sys.__stderr__


def _start_capture_drain() -> None:
    """Start the fd-1 drain thread (child-process output forwarder)."""
    if _CAPTURE_READ_FD is None:
        return
    thread = threading.Thread(target=_drain_captured_stdout, name="dsh-fd1-capture", daemon=True)
    thread.start()


def _drain_captured_stdout() -> None:
    """Forward bytes written to the captured fd 1 (child processes) as log frames."""
    if _CAPTURE_READ_FD is None:
        return
    codecs = __import__("codecs")
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        try:
            chunk = os.read(_CAPTURE_READ_FD, 65536)
        except OSError:
            return
        if not chunk:
            return
        text = decoder.decode(chunk)
        if text:
            rid = _STATE.capture_rid
            if rid is not None:
                _emit({"type": "log", "id": rid, "text": text, "stream": "stdout"})
            else:
                _RAW_STDERR.write(text)
                _RAW_STDERR.flush()


# ---------------------------------------------------------------------------
# Persistent runner state
# ---------------------------------------------------------------------------


class _RunnerState:
    def __init__(self) -> None:
        self.user_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__doc__": None,
            "__builtins__": builtins,
        }
        self.loop: asyncio.AbstractEventLoop | None = None
        self.execution_count: int = 0
        self.cancel_requested: bool = False
        self.capture_rid: str | None = None
        # (run_id, seq) -> Future awaiting the host's reply to a binding call.
        self.pending_calls: dict[tuple[str, int], asyncio.Future] = {}
        # Namespace persistence (session snapshots): the spec of the CURRENT
        # exec, whether this process already restored once, and how the last
        # run settled (a snapshot is written only after a successful run).
        self.snapshot_spec: dict | None = None
        self.restored_once: bool = False
        self.last_status: str = "ok"


_CURRENT_RID: contextvars.ContextVar[str | None] = contextvars.ContextVar("dsh_rid", default=None)
_STATE = _RunnerState()

# ---------------------------------------------------------------------------
# Optional ipykernel/real-IPython execution mode (config pythonImpl: ipykernel)
# ---------------------------------------------------------------------------
#
# The default runner is self-contained stdlib; this mode swaps cell execution
# to a real IPython shell (magics, !cmd, display) while keeping the SAME
# protocol, namespaces, binding proxies, and snapshot machinery.

_IPYTHON_SHELL = None
_IPYTHON_SKIP = {"In", "Out", "get_ipython", "exit", "quit", "open", "_", "__", "___", "_oh", "_ih"}


def _maybe_init_ipython() -> None:
    """Activate IPython semantics when the host configured pythonImpl: ipykernel.

    Fails loud at boot (exit 2) when IPython is not importable so the host
    reports a startup failure instead of silently running with stdlib.
    """
    global _IPYTHON_SHELL
    if os.environ.get("DSH_KERNEL_PYTHON_IMPL") != "ipykernel":
        return
    try:
        from IPython.core.displayhook import DisplayHook
        from IPython.core.interactiveshell import DisplayTrap, InteractiveShell
    except ImportError as exc:
        sys.stderr.write(
            "dsh-code-runtime-kernels: pythonImpl 'ipykernel' needs IPython in the interpreter"
            + " that spawns kernels (pip install ipykernel): " + str(exc) + "\n")
        sys.stderr.flush()
        os._exit(2)
    shell = InteractiveShell.instance()
    shell.colors = "NoColor"

    class _QuietDisplayHook(DisplayHook):
        def write_output_prompt(self):
            pass

        def write_format_data(self, format_dict, md_dict=None):
            pass

    # IPython installs its own sys.displayhook + DisplayTrap at init; both must
    # be replaced (and the trap re-bound) or every expression prints Out[n].
    hook = _QuietDisplayHook(shell=shell, cache_size=0)
    shell.displayhook = hook
    shell.display_trap = DisplayTrap(hook=hook)
    sys.displayhook = hook
    ns = shell.user_ns
    if not isinstance(ns.get("__name__"), str):
        ns["__name__"] = "__main__"
    _STATE.user_ns = ns
    _IPYTHON_SHELL = shell


_call_seq = 0


def _next_call_seq() -> int:
    global _call_seq
    _call_seq += 1
    return _call_seq


# ---------------------------------------------------------------------------
# Tool binding proxy
# ---------------------------------------------------------------------------


def _make_tool_proxy_run(run_id: str, gname: str, names: list[str], member_prop: str, error_cls: Any) -> Any:
    """Build the program-visible proxy for one binding global of one run.

    Only the declared member names are exposed; each is an async callable that
    emits a call frame and awaits the host's reply. The injected error class
    name and member-name property mirror the TypeScript worker's ToolCallError /
    toolName contract (the shipped Code Mode consumer's descriptor).
    """

    class _BindingProxy:
        def __init__(self) -> None:
            for name in names:
                setattr(self, name, _make_binding_callable(run_id, gname, name, member_prop, error_cls))

        def __getattr__(self, name: str) -> Any:
            raise AttributeError(f"binding {gname}.{name} is not declared for this run")

    return _BindingProxy()


class _ToolCallError(Exception):
    """Base of every program-visible binding failure raised in this run."""


def _make_binding_callable(run_id: str, global_name: str, name: str, member_prop: str, error_cls: Any):
    async def _call(args: Any = None) -> Any:
        seq = _next_call_seq()
        future = asyncio.get_running_loop().create_future()
        _STATE.pending_calls[(run_id, seq)] = (future, error_cls, member_prop)
        _emit({
            "type": "call",
            "id": run_id,
            "seq": seq,
            "global": global_name,
            "name": name,
            "args": args,
        })
        try:
            return await future
        finally:
            _STATE.pending_calls.pop((run_id, seq), None)

    return _call


def _deliver_reply(reply: dict) -> None:
    rid = reply.get("id")
    seq = reply.get("seq")
    if not isinstance(rid, str) or not isinstance(seq, int):
        return
    entry = _STATE.pending_calls.get((rid, seq))
    if entry is None:
        return
    future, error_cls, member_prop = entry
    if future.done():
        return
    if reply.get("ok") is True:
        future.set_result(reply.get("value"))
        return
    message = reply.get("message")
    message_text = str(message if isinstance(message, str) else "binding call failed")
    err = error_cls(message_text)
    err.message = message_text
    tool_name = reply.get("name")
    if isinstance(tool_name, str):
        setattr(err, member_prop, tool_name)
    future.set_exception(err)


_MISSING = object()


def _materialize_namespaces(run_id: str, ns: dict, namespaces: list[dict]) -> list[tuple[str, Any]]:
    """Inject one run's binding globals + error classes; return restore ops.

    Each op restores ns[name] to its pre-run value (or deletes it when the
    name was not previously present). The runner calls them in the run's
    finally, so a stale proxy can never leak into the next cell.
    """
    restores: list[tuple[str, Any]] = []
    for descriptor in namespaces:
        gname = descriptor.get("global")
        if not isinstance(gname, str) or not gname:
            continue
        names = descriptor.get("names")
        if not isinstance(names, list):
            names = []
        member_prop = "toolName"
        error_cls = _ToolCallError
        ec = descriptor.get("errorClass")
        if isinstance(ec, dict):
            ecname = ec.get("name")
            if isinstance(ecname, str) and ecname:
                error_cls = type(ecname, (_ToolCallError,), {})
                member_prop = ec.get("memberNameProperty")
                if not isinstance(member_prop, str) or not member_prop:
                    member_prop = "toolName"
            restores.append((ecname, ns.get(ecname, _MISSING)))
            ns[ecname] = error_cls
        restores.append((gname, ns.get(gname, _MISSING)))
        ns[gname] = _make_tool_proxy_run(run_id, gname, [n for n in names if isinstance(n, str)], member_prop, error_cls)
    return restores


# ---------------------------------------------------------------------------
# Cell execution: persistent namespace + loop, top-level await, last expression
# ---------------------------------------------------------------------------

_TLA_FLAG = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0x2000)


def _compile_source(source: str) -> tuple[Any, Any | None, bool]:
    """Returns (body_code, expr_code, ok). A parse OR compile error yields (None, None, False)."""
    try:
        module = ast.parse(source, "<cell>", "exec")
    except SyntaxError:
        return None, None, False
    if not module.body:
        return None, None, True
    try:
        last = module.body[-1]
        if isinstance(last, ast.Expr):
            body_module = ast.Module(body=module.body[:-1], type_ignores=[])
            expr_module = ast.Expression(body=last.value)
            ast.copy_location(expr_module, last)
            body_code = compile(body_module, "<cell>", "exec", flags=_TLA_FLAG)
            expr_code = compile(expr_module, "<cell>", "eval", flags=_TLA_FLAG)
            return body_code, expr_code, True
        return compile(module, "<cell>", "exec", flags=_TLA_FLAG), None, True
    except SyntaxError:
        # ast.parse alone accepts some AST-valid modules that compile
        # rejects (a top-level 'return', 'break'/'continue' outside a
        # loop, 'yield' outside a function, ...). Route them to the normal
        # per-cell error path so the run settles with "invalid Python
        # source" instead of leaving the kernel waiting for a done frame
        # that never arrives.
        return None, None, False


def _lossless_json(value: Any):
    """Round-trip a completion value through strict JSON.

    Returns (True, decoded) when lossless, (False, None) when the
    value cannot be represented as lossless JSON. None IS valid JSON
    (null), so the two outcomes must be distinguishable via the ok flag.
    """
    try:
        encoded = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError, OverflowError, RecursionError):
        return False, None
    try:
        decoded = json.loads(encoded)
    except (ValueError, RecursionError):
        return False, None
    return True, decoded


def _finish_run(
    run_id: str,
    *,
    status: str,
    value: Any = None,
    has_value: bool = False,
    cancelled: bool = False,
    invalid_output: bool = False,
    message: str = "",
) -> None:
    _STATE.last_status = "ok" if (status == "ok" and not cancelled) else "error"
    _STATE.execution_count += 1
    frame: dict = {
        "type": "done",
        "id": run_id,
        "status": status,
        "executionCount": _STATE.execution_count,
        "cancelled": cancelled,
    }
    if status == "ok" and has_value and not invalid_output:
        frame["value"] = value
    if invalid_output:
        frame["invalidOutput"] = True
    if message:
        frame["message"] = message
    _emit(frame)


async def _await_code(code_obj: Any, ns: dict) -> Any:
    """Evaluate a compiled code object in the live loop (awaiting coroutines).

    A cell with top-level await compiles to a coroutine; we await it so
    sibling requests and tool calls interleave. Statement/expression code runs
    synchronously on the loop thread.
    """
    coroutine_flag = getattr(__import__("inspect"), "CO_COROUTINE", 0)
    if code_obj.co_flags & coroutine_flag:
        return await eval(code_obj, ns)
    return eval(code_obj, ns)


async def _run_cell_ipython(code: str, run_id: str, namespaces: list[dict]) -> None:
    """IPython-mode cell: real shell semantics (magics, !cmd, display, TLA).

    run_cell_async executes inside the runner's live asyncio loop (run_cell
    would try run_until_complete on a loop that is already running), so
    top-level await interleaves exactly like stdlib mode. It returns the last
    expression as result.result and splits syntax/exec errors into
    error_before_exec / error_in_exec; the completion value still goes through
    the lossless-JSON gate so the return-value contract is identical to
    stdlib mode.
    """
    ns = _STATE.user_ns
    restores = _materialize_namespaces(run_id, ns, namespaces)
    _STATE.capture_rid = run_id
    token = _CURRENT_RID.set(run_id)
    try:
        transformed_cell = None
        preprocessing_exc = None
        try:
            transformed_cell = _IPYTHON_SHELL.transform_cell(code)
        except Exception as exc:  # noqa: BLE001 - any transform failure is the cell's parse error
            preprocessing_exc = (type(exc), exc, exc.__traceback__)
        result = await _IPYTHON_SHELL.run_cell_async(
            code, store_history=False, transformed_cell=transformed_cell, preprocessing_exc_tuple=preprocessing_exc)
        _flush_stream_proxies(run_id)
        if not result.success:
            exc = result.error_in_exec
            if exc is None:
                exc = result.error_before_exec
            tb = traceback.format_exception(type(exc), exc, exc.__traceback__) if exc is not None else []
            _emit({
                "type": "error",
                "id": run_id,
                "ename": type(exc).__name__ if exc is not None else "Error",
                "evalue": str(exc) if exc is not None else "cell failed",
                "traceback": tb,
            })
            _finish_run(run_id, status="error", message=str(exc) if exc is not None else "cell failed")
            return
        value = result.result
        if value is None:
            _finish_run(run_id, status="ok")
            return
        serialized_ok, serialized = _lossless_json(value)
        if not serialized_ok:
            _finish_run(run_id, status="error", invalid_output=True)
            return
        _finish_run(run_id, status="ok", value=serialized, has_value=True)
    except KeyboardInterrupt:
        _flush_stream_proxies(run_id)
        _STATE.cancel_requested = False
        _finish_run(run_id, status="error", cancelled=True)
    except asyncio.CancelledError:
        _flush_stream_proxies(run_id)
        _STATE.cancel_requested = False
        _finish_run(run_id, status="error", cancelled=True)
        raise
    finally:
        _CURRENT_RID.reset(token)
        _STATE.capture_rid = None
        for name, previous in restores:
            if previous is _MISSING:
                ns.pop(name, None)
            else:
                ns[name] = previous


async def _run_cell(code: str, run_id: str, namespaces: list[dict]) -> None:
    if _IPYTHON_SHELL is not None:
        await _run_cell_ipython(code, run_id, namespaces)
        return
    sys.stdout = _StreamProxy("stdout")
    sys.stderr = _StreamProxy("stderr")  # noqa: F841 - kept for symmetry
    ns = _STATE.user_ns

    # Materialize this run's bindings (fresh proxies + error classes each run).
    restores = _materialize_namespaces(run_id, ns, namespaces)
    loop = asyncio.get_running_loop()
    del loop  # the loop is persistent state, not per-run
    _STATE.capture_rid = run_id
    token = _CURRENT_RID.set(run_id)
    try:
        body_code, expr_code, ok = _compile_source(code)
        if not ok:
            _finish_run(run_id, status="error", message="invalid Python source")
            return
        try:
            if body_code is not None:
                await _await_code(body_code, ns)
            value = None
            if expr_code is not None:
                value = await _await_code(expr_code, ns)
        except KeyboardInterrupt:
            _flush_stream_proxies(run_id)
            _STATE.cancel_requested = False
            _finish_run(run_id, status="error", cancelled=True)
            return
        except asyncio.CancelledError:
            _flush_stream_proxies(run_id)
            _STATE.cancel_requested = False
            _finish_run(run_id, status="error", cancelled=True)
            return
        except BaseException as exc:  # noqa: BLE001 - model code may raise anything
            _flush_stream_proxies(run_id)
            tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
            _emit({
                "type": "error",
                "id": run_id,
                "ename": type(exc).__name__,
                "evalue": str(exc),
                "traceback": tb,
            })
            _finish_run(run_id, status="error", message=str(exc))
            return
        _flush_stream_proxies(run_id)
        if _STATE.cancel_requested:
            _STATE.cancel_requested = False
            _finish_run(run_id, status="error", cancelled=True)
            return
        if expr_code is not None:
            serialized_ok, serialized = _lossless_json(value)
            if not serialized_ok:
                _finish_run(run_id, status="error", invalid_output=True)
                return
            _finish_run(run_id, status="ok", value=serialized, has_value=True)
        else:
            _finish_run(run_id, status="ok")
    finally:
        _CURRENT_RID.reset(token)
        _STATE.capture_rid = None
        for name, previous in restores:
            if previous is _MISSING:
                ns.pop(name, None)
            else:
                ns[name] = previous


# ---------------------------------------------------------------------------
# Namespace persistence: session snapshots (stdlib pickle + zlib, atomic)
# ---------------------------------------------------------------------------
#
# The kernel owns the file. After every successfully settled run the user
# namespace is packed entry by entry and written to spec["path"] via
# temp-file-and-rename; a fresh process restores it once, on its first exec.
# Entries that cannot be represented (user-defined class instances, lambdas in
# containers, closures over non-picklables) are named, never silently dropped.
# Pickle is NOT a security boundary — a snapshot file grants code execution to
# whoever reads it, but the kernel already runs model code (bash-equivalent
# trust), so the file stays inside the user's own state directory.


_SNAPSHOT_VERSION = 1
_RESTORE_NOTICE_LIMIT = 12


def _is_snapshot_spec(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    path = value.get("path")
    max_bytes = value.get("maxBytes")
    max_entry = value.get("maxEntryBytes")
    return (
        isinstance(path, str)
        and bool(path)
        and isinstance(max_bytes, int)
        and max_bytes > 0
        and isinstance(max_entry, int)
        and max_entry > 0
    )


def _pack_class(cls: type) -> dict:
    base_payloads = []
    for base in cls.__bases__:
        base_payloads.append(pickle.dumps(base, protocol=pickle.HIGHEST_PROTOCOL))
    members: dict[str, dict] = {}
    skip = {"__dict__", "__weakref__", "__module__", "__qualname__", "__doc__", "__slots__"}
    for key, value in list(cls.__dict__.items()):
        if key in skip:
            continue
        if isinstance(value, staticmethod):
            members[key] = {"kind": "staticmethod", "func": _pack_value(value.__func__)}
        elif isinstance(value, classmethod):
            members[key] = {"kind": "classmethod", "func": _pack_value(value.__func__)}
        elif isinstance(value, property):
            raise TypeError("property members are not snapshot-supported")
        else:
            members[key] = _pack_value(value)
    return {"kind": "class", "name": cls.__name__, "bases": base_payloads, "members": members}


def _pack_value(value: Any) -> dict:
    """One namespace entry as a snapshot record. Raises when it cannot be saved."""
    if isinstance(value, types.ModuleType):
        return {"kind": "module", "name": value.__name__}
    if isinstance(value, (types.BuiltinFunctionType, types.BuiltinMethodType)):
        module_name = getattr(value, "__module__", None)
        qualname = getattr(value, "__qualname__", getattr(value, "__name__", None))
        if isinstance(module_name, str) and isinstance(qualname, str):
            return {"kind": "builtin", "module": module_name, "qualname": qualname}
        raise TypeError("builtin without importable identity cannot be snapshotted")
    if isinstance(value, type):
        return _pack_class(value)
    if isinstance(value, types.FunctionType):
        # Imported functions/classes pickle by reference; __main__-defined
        # callables do not, so fall back to by-value (code + defaults + cells).
        try:
            return {"kind": "ref", "payload": pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)}
        except Exception:
            pass
        closure = value.__closure__ or ()
        # Code objects are not picklable, so the bytecode travels as marshal
        # bytes (same-interpreter restarts guarantee a compatible marshal
        # format; a cross-version restore fails per-name and is reported).
        return {
            "kind": "function",
            "name": value.__name__,
            "qualname": getattr(value, "__qualname__", value.__name__),
            "code": marshal.dumps(value.__code__),
            "defaults": value.__defaults__,
            "kwdefaults": value.__kwdefaults__,
            "closure": [cell.cell_contents for cell in closure],
        }
    return {"kind": "data", "payload": pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)}


def _rebuild_function(record: dict) -> Any:
    code = marshal.loads(record["code"])
    defaults = record.get("defaults")
    closure_values = record.get("closure")
    cells = None
    if isinstance(closure_values, list):
        cells = tuple(types.CellType(value) for value in closure_values)
    fn = types.FunctionType(code, _STATE.user_ns, record.get("name") or "<lambda>", defaults, cells)
    kwdefaults = record.get("kwdefaults")
    if kwdefaults is not None:
        fn.__kwdefaults__ = kwdefaults
    qualname = record.get("qualname")
    if isinstance(qualname, str):
        fn.__qualname__ = qualname
    fn.__module__ = "__main__"
    return fn


def _rebuild_class(record: dict) -> Any:
    bases = tuple(pickle.loads(payload) for payload in record["bases"])
    members: dict[str, Any] = {}
    for key, member in record["members"].items():
        kind = member.get("kind")
        if kind == "staticmethod":
            members[key] = staticmethod(_unpack_value(member["func"]))
        elif kind == "classmethod":
            members[key] = classmethod(_unpack_value(member["func"]))
        else:
            members[key] = _unpack_value(member)
    cls = type(record["name"], bases, members)
    cls.__module__ = "__main__"
    return cls


def _unpack_value(record: dict) -> Any:
    kind = record.get("kind")
    if kind == "module":
        return importlib.import_module(record["name"])
    if kind == "builtin":
        target = importlib.import_module(record["module"])
        for part in record["qualname"].split("."):
            target = getattr(target, part)
        return target
    if kind in ("data", "ref"):
        return pickle.loads(record["payload"])
    if kind == "function":
        return _rebuild_function(record)
    if kind == "class":
        return _rebuild_class(record)
    raise ValueError(f"unknown snapshot record kind {kind!r}")


def _collect_entries(spec: dict) -> tuple[dict, list[str]]:
    max_bytes = spec["maxBytes"]
    max_entry = spec["maxEntryBytes"]
    entries: dict[str, dict] = {}
    skipped: list[str] = []
    total = 0
    for name, value in list(_STATE.user_ns.items()):
        if name.startswith("__") or name in _IPYTHON_SKIP:
            continue
        try:
            record = _pack_value(value)
            size = len(pickle.dumps(record, protocol=pickle.HIGHEST_PROTOCOL))
        except Exception:
            skipped.append(name)
            continue
        if size > max_entry or total + size > max_bytes:
            skipped.append(name)
            continue
        entries[name] = record
        total += size
    return entries, skipped


def _save_snapshot(spec: dict) -> None:
    """Write the current namespace atomically; a failure never fails the run."""
    path = spec["path"]
    tmp = ""
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        entries, skipped = _collect_entries(spec)
        doc = {"version": _SNAPSHOT_VERSION, "savedAt": time.time(), "entries": entries, "lost": skipped}
        payload = zlib.compress(pickle.dumps(doc, protocol=pickle.HIGHEST_PROTOCOL))
        tmp = path + ".tmp"
        with open(tmp, "wb") as handle:
            handle.write(payload)
        os.replace(tmp, path)
    except BaseException:
        try:
            if tmp:
                os.unlink(tmp)
        except OSError:
            pass


def _restore_snapshot(spec: dict, rid: str) -> None:
    """Restore the last saved namespace once; report revived and lost names."""
    path = spec["path"]
    if not os.path.exists(path):
        return
    try:
        with open(path, "rb") as handle:
            doc = pickle.loads(zlib.decompress(handle.read()))
        if not isinstance(doc, dict) or doc.get("version") != _SNAPSHOT_VERSION:
            raise ValueError("unsupported snapshot version")
        entries = doc.get("entries")
        if not isinstance(entries, dict):
            raise ValueError("snapshot entries missing")
    except BaseException as exc:  # noqa: BLE001 - a bad snapshot must not wedge the kernel
        _emit({"type": "log", "id": rid, "text": f"[dsh-kernels] snapshot unreadable (restore skipped): {exc}"})
        return
    restored: list[str] = []
    lost = [name for name in doc.get("lost", []) if isinstance(name, str)]
    for name, record in entries.items():
        try:
            _STATE.user_ns[name] = _unpack_value(record)
            restored.append(name)
        except BaseException:
            lost.append(name)
    notice = f"[dsh-kernels] restored {len(restored)} names from snapshot"
    if lost:
        shown = ", ".join(lost[:_RESTORE_NOTICE_LIMIT])
        if len(lost) > _RESTORE_NOTICE_LIMIT:
            shown += ", ..."
        notice += f" (could not restore: {shown})"
    _emit({"type": "log", "id": rid, "text": notice})


def _install_idle_sigint() -> None:
    """SIGINT (host interrupt/escalation) interrupts the active run.

    The handler raises KeyboardInterrupt synchronously: for sync exec code
    (a busy loop, a time.sleep) that interrupts the blocking call between
    bytecodes, and for await-ing coroutines it propagates out of the await
    point. Either way _run_cell catches it and settles the run cancelled.
    When SIGINT lands while no cell is active the exception unwinds the main
    loop and the runner exits — a race the host covers by escalating to
    termination, so accepting it keeps interrupt latency at zero.
    """

    def handler_signum(_signum: int, _frame: Any) -> None:
        _STATE.cancel_requested = True
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGINT, handler_signum)
    except (ValueError, OSError):  # not the main thread (tests)
        pass


# ---------------------------------------------------------------------------
# Request loop
# ---------------------------------------------------------------------------


def _read_stdin(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, stdin: Any) -> None:
    for raw in stdin:
        line = raw.rstrip("\n")
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        loop.call_soon_threadsafe(queue.put_nowait, req)
    loop.call_soon_threadsafe(queue.put_nowait, {"type": "exit"})


async def _handle_request_async(req: dict) -> None:
    rid = req.get("id")
    if not isinstance(rid, str) or not rid:
        return
    code = req.get("code")
    if not isinstance(code, str):
        _emit({"type": "error", "id": rid, "ename": "ProtocolError", "evalue": "code must be a string", "traceback": []})
        _finish_run(rid, status="error", message="code must be a string")
        return
    cwd = req.get("cwd")
    if isinstance(cwd, str):
        try:
            os.chdir(cwd)
            if cwd not in sys.path:
                sys.path.insert(0, cwd)
        except OSError:
            pass
    env = req.get("env")
    if isinstance(env, dict):
        for key, value in env.items():
            if isinstance(key, str):
                if isinstance(value, str):
                    os.environ[key] = value
                else:
                    os.environ.pop(key, None)
    namespaces = req.get("namespaces")
    if not isinstance(namespaces, list):
        namespaces = []
    # Namespace persistence: restore once per process (on the first exec that
    # carries a spec), then remember the spec so the run's success can persist.
    snapshot = req.get("snapshot")
    _STATE.snapshot_spec = snapshot if _is_snapshot_spec(snapshot) else None
    if _STATE.snapshot_spec is not None and not _STATE.restored_once:
        _STATE.restored_once = True
        _restore_snapshot(_STATE.snapshot_spec, rid)
    _STATE.cancel_requested = False
    try:
        await _run_cell(code, rid, namespaces)
    except asyncio.CancelledError:
        _STATE.cancel_requested = False
        _finish_run(rid, status="error", cancelled=True)
    finally:
        if _STATE.snapshot_spec is not None and _STATE.last_status == "ok":
            _save_snapshot(_STATE.snapshot_spec)


async def _main_async() -> None:
    sys.stdout = _StreamProxy("stdout")
    sys.stderr = _StreamProxy("stderr")
    _install_idle_sigint()
    _maybe_init_ipython()
    _start_capture_drain()

    stdin = sys.__stdin__
    if stdin is None:
        return
    loop = asyncio.get_running_loop()
    _STATE.loop = loop
    queue: asyncio.Queue = asyncio.Queue()
    reader = threading.Thread(target=_read_stdin, args=(loop, queue, stdin), name="dsh-stdin-reader", daemon=True)
    reader.start()

    _emit({"type": "ready", "pid": os.getpid()})

    tasks: set[asyncio.Task] = set()

    def _task_done(task: asyncio.Task) -> None:
        tasks.discard(task)
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None and not isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError)):
            _emit({"type": "error", "id": "", "ename": "ProtocolError", "evalue": str(exc), "traceback": []})

    while True:
        req = await queue.get()
        rtype = req.get("type")
        if rtype == "exit":
            break
        if rtype == "reply":
            _deliver_reply(req)
            continue
        task = asyncio.create_task(_handle_request_async(req))
        tasks.add(task)
        task.add_done_callback(_task_done)

    # Every request queued before an exit request is already a task; run them
    # all to completion before shutting down (cancelling here would kill execs
    # that never got a turn -- a race when stdin drains faster than the loop
    # runs).
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def main() -> None:
    asyncio.run(_main_async())


if __name__ == "__main__":
    main()
`
