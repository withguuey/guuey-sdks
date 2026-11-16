"""Credential-file reading for a Python worker: the servers-file arm of @guuey/worker's listCredentials (src/creds.ts).

The platform's credential broker resolves everything; a worker only reads and shapes. Every MCP server's entry
reaches a Python worker in ONE place: the servers file named by ``GUUEY_MCP_SERVERS_FILE``, one JSON file placed by
the platform outside every tree the worker can write. A missing, unreadable, malformed or relative-path file is no
servers. An EMPTY value is the platform's "no servers this turn".

Two deliberate divergences from creds.ts:

1. No session folder. When the variable is UNSET this returns no servers and reads nothing. The JavaScript reader then
   falls back to ``<session>/.guuey/credentials/<server>.json``, an arm it keeps for workers launched by older
   supervisors that never set the variable. The Python host is new: no older supervisor launches it, so it has no
   such arm to keep, and it takes no session path at all.
2. A regular file, by its exact path, or nothing. The file is opened once with ``O_NOFOLLOW``, and the open descriptor
   is checked with ``fstat`` to be a regular file before anything is read (never a stat first and an open second).
   A symlink as the path's last component, a directory, a FIFO, a socket or a device is no servers, and one line on
   stderr names the reason class only: ``servers file refused: link`` or ``servers file refused: not-regular``. The
   JavaScript reader follows a symlink and reads a FIFO. The open also carries ``O_NONBLOCK``, so a FIFO is refused
   rather than waited on (it has no effect on reading a regular file), and ``O_NOCTTY``. Directories earlier in the
   path resolve as the kernel resolves them: they are the platform's, outside every bind the worker can write, and the
   path must be absolute. A file over ``MAX_SERVERS_FILE_BYTES`` is refused as ``too-large``, never read whole.

It never falls back to any other source, for any input, and no credential is ever read from an environment variable:
the environment gives only the servers file's path. Like the JavaScript reader it never raises: nothing to read, or
nothing valid, is an empty list (never crash the turn). The golden corpus in ../golden/creds/ is written by the
JavaScript reader and replayed against this module, with the divergent cases named in the tests.
"""

import errno
import json
import os
import stat
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final, Literal, NoReturn, NotRequired, TypedDict, TypeGuard

MCP_SERVERS_FILE_ENV: Final = "GUUEY_MCP_SERVERS_FILE"
"""The variable naming the servers file. Set only by the platform; an empty value means no servers this turn."""

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type Transport = Literal["http", "sse"]
type RefusalReason = Literal["link", "not-regular", "too-large"]

MAX_SERVERS_FILE_BYTES: Final = 1 << 20
"""The servers file's ceiling, 1 MiB: a platform file listing one endpoint and a few headers per server has no reason to
be unbounded, and an unbounded read is the one way left to stall the turn (hardening C-1). Past it the file is refused
as ``too-large``, read no further than this plus one chunk."""

_OPEN_FLAGS: Final = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOCTTY
_READ_CHUNK: Final = 1 << 16


class CredentialFile(TypedDict):
    """One credential: the broker's contract, consumed verbatim.

    As in creds.ts only ``url`` and ``transport`` are checked; the object comes back exactly as written, unknown keys
    included, so a later writer may add fields.
    """

    url: str
    """One opaque MCP endpoint: use it verbatim, never as a base URL."""
    transport: Transport
    headers: dict[str, str]
    expiresAt: NotRequired[str]


@dataclass(frozen=True, slots=True)
class CredentialEntry:
    """One server's entry: its name and its credential."""

    name: str
    cred: CredentialFile


class ServersFileRefused(Exception):
    """The servers file is not a regular file reached by its exact path. Carries the reason class, never the path."""

    def __init__(self, reason: RefusalReason) -> None:
        super().__init__(reason)
        self.reason: RefusalReason = reason


def _refuse_constant(token: str) -> NoReturn:
    """JavaScript's JSON.parse refuses NaN, Infinity and -Infinity; Python's json accepts them unless told not to."""
    raise ValueError(f"{token} is not JSON")


def _parse(text: str) -> JsonValue:
    return json.loads(text, parse_constant=_refuse_constant)


def _read_regular_file(path: str) -> str:
    """Open ``path`` once without following a last-component symlink, check the descriptor is a regular file, read it.

    Invalid UTF-8 decodes to U+FFFD, as Node's readFileSync(path, "utf8") decodes it.
    """
    try:
        fd = os.open(path, _OPEN_FLAGS)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ServersFileRefused("link") from None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ServersFileRefused("not-regular")
        if info.st_size > MAX_SERVERS_FILE_BYTES:
            raise ServersFileRefused("too-large")
        chunks: list[bytes] = []
        total = 0
        # The size above is the file's size at the fstat; one that grows while it is read is caught here, after at
        # most one chunk past the ceiling.
        while chunk := os.read(fd, _READ_CHUNK):
            total += len(chunk)
            if total > MAX_SERVERS_FILE_BYTES:
                raise ServersFileRefused("too-large")
            chunks.append(chunk)
    finally:
        os.close(fd)
    return b"".join(chunks).decode("utf-8", errors="replace")


def _is_credential_file(value: JsonValue) -> TypeGuard[CredentialFile]:
    return isinstance(value, dict) and isinstance(value.get("url"), str) and value.get("transport") in ("http", "sse")


def _read_servers_file(path: str) -> list[CredentialEntry]:
    """The servers file's entries: invalid or repeated entries are skipped; an unreadable file is no servers.

    A path that is not absolute is no servers too: it would resolve against the working directory, the session tree.
    """
    if not path.startswith("/"):
        return []
    try:
        parsed = _parse(_read_regular_file(path))
    except ServersFileRefused as refused:
        print(f"servers file refused: {refused.reason}", file=sys.stderr, flush=True)
        return []
    except (OSError, ValueError, RecursionError):
        return []  # no file, or not JSON: no MCP (never crash the turn), as creds.ts.
    if not isinstance(parsed, dict):
        return []
    servers = parsed.get("servers")
    if not isinstance(servers, list):
        return []
    out: list[CredentialEntry] = []
    seen: set[str] = set()
    for entry in servers:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        credential = entry.get("credential")
        if not isinstance(name, str) or name == "" or name in seen or not _is_credential_file(credential):
            continue
        seen.add(name)
        out.append(CredentialEntry(name=name, cred=credential))
    return out


def list_credentials(env: Mapping[str, str] | None = None) -> Callable[[], list[CredentialEntry]]:
    """Every credential entry the broker wrote for this invoke, read afresh on each call of the returned function.

    ``env`` is read on every call; ``None`` reads ``os.environ`` at call time. Its only use is the servers file's path.
    Unset, there are no servers and nothing is read.
    """

    def read() -> list[CredentialEntry]:
        servers_file = (os.environ if env is None else env).get(MCP_SERVERS_FILE_ENV)
        return [] if servers_file is None else _read_servers_file(servers_file)

    return read
