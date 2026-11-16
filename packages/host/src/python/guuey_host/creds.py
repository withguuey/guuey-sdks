"""Credential-file reading for a Python worker: a port of @guuey/worker's listCredentials (src/creds.ts).

The platform's credential broker resolves everything; a worker only reads and shapes. Entries reach a worker in one
of two places:

- The servers file, when the platform sets ``GUUEY_MCP_SERVERS_FILE``: one JSON file holding every server's entry,
  placed outside every tree the worker can write. While the variable is set, and even when it is EMPTY (the
  platform's "no servers this turn"), the session directory is never read: an entry planted there by an earlier turn
  is never picked up. A missing, unreadable, malformed or relative-path file is no servers, never a fall back.
- The session directory, when the variable is unset (local development): one JSON file per server at
  ``<session>/.guuey/credentials/<server>.json``.

The environment supplies only the servers file's PATH. No credential is ever read from an environment variable.

Like the JavaScript reader this never raises: nothing to read, or nothing valid, is an empty list (never crash the
turn). It does what creds.ts does and no more: one read of the servers file (no stat, no existence check, so a pipe
is read exactly once), symlinks followed as Node's readFileSync follows them, and no permission checks. The golden
corpus in ../golden/creds/ is written by the JavaScript reader and replayed against this module.
"""

import json
import os
import posixpath
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final, Literal, NoReturn, NotRequired, Protocol, TypedDict, TypeGuard

MCP_SERVERS_FILE_ENV: Final = "GUUEY_MCP_SERVERS_FILE"
"""The variable naming the servers file. Set only by the platform; an empty value means no servers this turn."""

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type Transport = Literal["http", "sse"]


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


class SessionFs(Protocol):
    """The part of the worker's filesystem layout this module reads (the protocol's Fs satisfies it)."""

    @property
    def session(self) -> str: ...


_JSON_SUFFIX: Final = ".json"


def _refuse_constant(token: str) -> NoReturn:
    """JavaScript's JSON.parse refuses NaN, Infinity and -Infinity; Python's json accepts them unless told not to."""
    raise ValueError(f"{token} is not JSON")


def _parse(text: str) -> JsonValue:
    return json.loads(text, parse_constant=_refuse_constant)


def _read_text(path: str) -> str:
    """Node's readFileSync(path, "utf8"): one open, read to the end, invalid UTF-8 replaced with U+FFFD."""
    with open(path, "rb", buffering=0) as handle:
        data = handle.readall()
    return data.decode("utf-8", errors="replace")


def _node_join(*segments: str) -> str:
    """Node's path.posix.join: empty segments dropped, the rest joined with '/' and normalized."""
    joined = posixpath.normpath("/".join(segment for segment in segments if segment != ""))
    # POSIX normpath keeps exactly two leading slashes; Node's normalize collapses them to one.
    return joined[1:] if joined.startswith("//") and not joined.startswith("///") else joined


def _is_credential_file(value: JsonValue) -> TypeGuard[CredentialFile]:
    return isinstance(value, dict) and isinstance(value.get("url"), str) and value.get("transport") in ("http", "sse")


def _read_servers_file(path: str) -> list[CredentialEntry]:
    """The servers file's entries: invalid or repeated entries are skipped; an unreadable file is no servers.

    A path that is not absolute is no servers too: it would resolve against the working directory, the session tree.
    """
    if not path.startswith("/"):
        return []
    try:
        parsed = _parse(_read_text(path))
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


def _read_session_dir(session: str) -> list[CredentialEntry]:
    """The session directory's entries, one per valid ``.json`` file, in byte order of the file names.

    Node's readdirSync returns names sorted bytewise and decoded as UTF-8 with replacement; a name that was not valid
    UTF-8 then names no file and is skipped. Listing bytes, sorting and decoding the same way keeps that behaviour.
    """
    folder = _node_join(session, ".guuey", "credentials")
    try:
        listed = os.listdir(os.fsencode(folder))
    except (OSError, ValueError):
        return []  # no credentials folder this turn: no MCP, as creds.ts.
    names = [raw.decode("utf-8", errors="replace") for raw in sorted(listed)]
    out: list[CredentialEntry] = []
    for file in names:
        if not file.endswith(_JSON_SUFFIX):
            continue
        try:
            parsed = _parse(_read_text(_node_join(folder, file)))
        except (OSError, ValueError, RecursionError):
            continue  # a malformed or unreadable file is skipped (never crash the turn), as creds.ts.
        if _is_credential_file(parsed):
            out.append(CredentialEntry(name=file[: -len(_JSON_SUFFIX)], cred=parsed))
    return out


def list_credentials(fs: SessionFs, env: Mapping[str, str] | None = None) -> Callable[[], list[CredentialEntry]]:
    """Every credential entry the broker wrote for this invoke, read afresh on each call of the returned function.

    ``env`` is read on every call; ``None`` reads ``os.environ`` at call time. Its only use is the servers file's path.
    """

    def read() -> list[CredentialEntry]:
        servers_file = (os.environ if env is None else env).get(MCP_SERVERS_FILE_ENV)
        return _read_session_dir(fs.session) if servers_file is None else _read_servers_file(servers_file)

    return read
