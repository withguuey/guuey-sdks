"""The private launch envelope (guuey#2139): a port of ``@guuey/worker``'s ``launch-envelope.ts``.

The one channel a platform-launched worker receives its scoped capabilities on. A secret is never in argv or the
initial environment: the launcher writes ONE JSON line to fd :data:`LAUNCH_ENVELOPE_FD` and ends it; the worker reads
it once at boot, closes the descriptor and keeps the payload in memory only. Only the descriptor NUMBER rides the
environment, as :data:`LAUNCH_ENVELOPE_FD_ENV`.

Fail closed: a marker naming another descriptor, a descriptor that is not a socket or FIFO, a payload that is empty,
oversized, truncated or not exactly the versioned shape, or no EOF within the deadline raises
:class:`LaunchEnvelopeError`, whose message never carries payload bytes. With the marker absent the worker runs
without an envelope.
"""

import errno
import os
import re
import select
import stat
import time
from collections.abc import MutableMapping
from dataclasses import dataclass
from typing import ClassVar, Final, Literal, TypeIs

from guuey_host.protocol_json import JsonObject, JsonSyntaxFailure, JsonValue, js_json_stringify, js_json_try_parse

LAUNCH_ENVELOPE_FD_ENV: Final = "GUUEY_LAUNCH_ENVELOPE_FD"
"""Environment name carrying the envelope's descriptor number. Not a secret."""

LAUNCH_ENVELOPE_FD: Final = 5
"""The descriptor the envelope rides: 0-2 stdio, 3 events, 4 jail options."""

LAUNCH_ENVELOPE_VERSION: Final = 1
"""The envelope format this package reads and writes."""

LAUNCH_ENVELOPE_MAX_BYTES: Final = 16 * 1024
"""Upper bound on the encoded envelope, newline included."""

LAUNCH_ENVELOPE_DEADLINE_MS: Final = 10_000
"""How long a worker waits for the launcher to finish writing."""

type LaunchWire = Literal["anthropic", "openai", "gemini"]
"""The model wires a scoped model capability can authenticate to."""

LAUNCH_WIRES: Final[tuple[LaunchWire, ...]] = ("anthropic", "openai", "gemini")

_TOKEN_PATTERN: Final = re.compile(r"^[\x21-\x7e]{1,4096}$")
_READ_SIZE: Final = 65536


class LaunchEnvelopeError(Exception):
    """A refused or failed envelope read. Its message never contains payload bytes."""

    JS_NAME: ClassVar[str] = "LaunchEnvelopeError"

    def __init__(self, reason: str) -> None:
        super().__init__(f"launch envelope refused: {reason}")
        self.reason = reason


@dataclass(frozen=True, slots=True, kw_only=True)
class LaunchModelCapability:
    """The scoped model capability for one execution."""

    wire: LaunchWire
    token: str

    def to_wire(self) -> JsonObject:
        return {"wire": self.wire, "token": self.token}


@dataclass(frozen=True, slots=True, kw_only=True)
class LaunchEnvelope:
    """Version 1 of the private launch envelope."""

    v: Literal[1] = 1
    model: LaunchModelCapability | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"v": self.v}
        if self.model is not None:
            out["model"] = self.model.to_wire()
        return out


def is_launch_wire(value: JsonValue) -> TypeIs[LaunchWire]:
    return isinstance(value, str) and value in LAUNCH_WIRES


def _is_version_one(value: JsonValue) -> bool:
    # A JavaScript number equal to 1 (1.0 parses as 1); never a boolean, which Python would call equal to 1.
    return not isinstance(value, bool) and isinstance(value, int) and value == LAUNCH_ENVELOPE_VERSION


def parse_launch_envelope(text: str) -> LaunchEnvelope:
    """Parse one encoded envelope strictly: exactly one JSON object, an optional single trailing newline, version 1,
    no unknown member at either level."""
    if len(text) == 0:
        raise LaunchEnvelopeError("empty payload")
    body = text[:-1] if text.endswith("\n") else text
    if len(body) == 0 or "\n" in body:
        raise LaunchEnvelopeError("payload is not exactly one line")
    parsed = js_json_try_parse(body)
    if isinstance(parsed, JsonSyntaxFailure):
        raise LaunchEnvelopeError("payload is not complete JSON")
    if not isinstance(parsed, dict):
        raise LaunchEnvelopeError("payload is not an object")
    for key in parsed:
        if key != "v" and key != "model":
            raise LaunchEnvelopeError("payload has an unknown member")
    if not _is_version_one(parsed.get("v")):
        raise LaunchEnvelopeError("unsupported envelope version")
    if "model" not in parsed:
        return LaunchEnvelope()
    model = parsed["model"]
    if not isinstance(model, dict):
        raise LaunchEnvelopeError("model is not an object")
    for key in model:
        if key != "wire" and key != "token":
            raise LaunchEnvelopeError("model has an unknown member")
    wire = model.get("wire")
    if not is_launch_wire(wire):
        raise LaunchEnvelopeError("model wire is not supported")
    token = model.get("token")
    if not isinstance(token, str) or _TOKEN_PATTERN.fullmatch(token) is None:
        raise LaunchEnvelopeError("model token is malformed")
    return LaunchEnvelope(model=LaunchModelCapability(wire=wire, token=token))


def encode_launch_envelope(envelope: LaunchEnvelope) -> bytes:
    """Encode an envelope as the one line a launcher writes, after validating it through the strict parser."""
    line = js_json_stringify(envelope.to_wire()) + "\n"
    parse_launch_envelope(line)
    encoded = line.encode("utf-8")
    if len(encoded) > LAUNCH_ENVELOPE_MAX_BYTES:
        raise LaunchEnvelopeError("payload exceeds the size limit")
    return encoded


def _is_open(fd: int) -> bool:
    """Whether ``fd`` is open in this process. Errors other than EBADF raise."""
    try:
        os.fstat(fd)
    except OSError as error:
        if error.errno == errno.EBADF:
            return False
        raise
    return True


def _read_to_end(fd: int, max_bytes: int, deadline_ms: int) -> str:
    """Read ``fd`` to EOF within the byte cap and deadline; the descriptor is closed on every path."""
    deadline = time.monotonic() + deadline_ms / 1000
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LaunchEnvelopeError(f"no EOF within {deadline_ms} ms")
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                continue
            try:
                chunk = os.read(fd, _READ_SIZE)
            except OSError:
                raise LaunchEnvelopeError("descriptor read failed") from None
            if chunk == b"":
                break
            total += len(chunk)
            if total > max_bytes:
                raise LaunchEnvelopeError("payload exceeds the size limit")
            chunks.append(chunk)
    finally:
        os.close(fd)
    return b"".join(chunks).decode("utf-8", errors="replace")


def read_launch_envelope_from(
    fd: int,
    env: MutableMapping[str, str],
    max_bytes: int = LAUNCH_ENVELOPE_MAX_BYTES,
    deadline_ms: int = LAUNCH_ENVELOPE_DEADLINE_MS,
) -> LaunchEnvelope:
    """Read the envelope from ``fd`` (a socket or FIFO), close it, delete the marker from ``env``, then parse.

    :func:`read_launch_envelope` calls this with :data:`LAUNCH_ENVELOPE_FD` once the marker names it; a test passes
    its own pipe. Returns only after ``fd`` is closed and reported closed, so nothing spawned later can inherit it.
    """
    try:
        mode = os.fstat(fd).st_mode
    except OSError:
        raise LaunchEnvelopeError(f"fd {fd} is not open") from None
    if not stat.S_ISSOCK(mode) and not stat.S_ISFIFO(mode):
        os.close(fd)
        raise LaunchEnvelopeError(f"fd {fd} is not a socket or FIFO")
    text = _read_to_end(fd, max_bytes, deadline_ms)
    del env[LAUNCH_ENVELOPE_FD_ENV]
    if _is_open(fd):
        raise LaunchEnvelopeError(f"fd {fd} is still open after the read")
    return parse_launch_envelope(text)


def read_launch_envelope(
    env: MutableMapping[str, str] | None = None,
    max_bytes: int = LAUNCH_ENVELOPE_MAX_BYTES,
    deadline_ms: int = LAUNCH_ENVELOPE_DEADLINE_MS,
) -> LaunchEnvelope | None:
    """Read the launch envelope once, then close its descriptor. ``None`` only when the marker is absent.

    ``env`` defaults to ``os.environ``; the marker is deleted from it after a read.
    """
    environment: MutableMapping[str, str] = os.environ if env is None else env
    marker = environment.get(LAUNCH_ENVELOPE_FD_ENV)
    if marker is None:
        return None
    if marker != str(LAUNCH_ENVELOPE_FD):
        raise LaunchEnvelopeError(f"{LAUNCH_ENVELOPE_FD_ENV} must name fd {LAUNCH_ENVELOPE_FD}")
    return read_launch_envelope_from(LAUNCH_ENVELOPE_FD, environment, max_bytes, deadline_ms)
