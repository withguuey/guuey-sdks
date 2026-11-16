"""The worker -> Router event writers (fd 3): ports of ``@guuey/worker``'s ``emit.ts``, ``suspend-writer.ts`` and
``turn.ts``.

Every event is serialized with :func:`guuey_host.protocol_json.js_json_stringify` and written as one NDJSON line, one
``write`` per line, so the bytes equal what the JavaScript emitter writes for the same call.
"""

import os
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from guuey_host.protocol import (
    SUSPEND_ENVELOPE_MAX_BYTES,
    DoneEvent,
    EndThread,
    ErrorEvent,
    Fs,
    HelloCliSession,
    HistoryMessage,
    Identity,
    Invoke,
    NativeEvent,
    StopReason,
    SuspendEvent,
    TextEvent,
    WorkerEvent,
    WorkerHelloEvent,
)
from guuey_host.protocol_json import JsonValue, js_json_stringify


class WriteSink(Protocol):
    """The minimal write interface the writers take. ``sys.stdout``-like text streams satisfy it."""

    def write(self, s: str, /) -> object: ...


@dataclass(frozen=True, slots=True)
class FdSink:
    """A :class:`WriteSink` over a raw descriptor (the events descriptor is fd 3): each write is UTF-8, written whole.

    Every line the writers produce encodes as UTF-8 (``js_json_stringify`` escapes lone surrogates), so the encode
    never fails on protocol output.
    """

    fd: int

    def write(self, s: str, /) -> None:
        view = memoryview(s.encode("utf-8"))
        while len(view) > 0:
            written = os.write(self.fd, view)
            view = view[written:]


def _line(event: WorkerEvent) -> str:
    return js_json_stringify(event.to_wire()) + "\n"


@dataclass(frozen=True, slots=True)
class Emitter:
    """Serializes each :data:`WorkerEvent` as one NDJSON line to ``out``."""

    out: WriteSink

    def _write(self, event: WorkerEvent) -> None:
        self.out.write(_line(event))

    def text(self, text: str) -> None:
        self._write(TextEvent(text=text))

    def done(self, result: str, stop_reason: StopReason = "end_turn", end_thread: EndThread | None = None) -> None:
        """``end_thread``: the turn asks the Router to end the conversation; omitted, today's ``done``."""
        copy = None if end_thread is None else EndThread(code=end_thread.code, message=end_thread.message)
        self._write(DoneEvent(stop_reason=stop_reason, result=result, end_thread=copy))

    def error(self, message: str) -> None:
        self._write(ErrorEvent(message=message))

    def native(self, framework: str, event: JsonValue) -> None:
        self._write(NativeEvent(framework=framework, event=event))

    def hello(
        self,
        framework: str,
        sdk_name: str | None,
        sdk_version: str | None,
        capabilities: Sequence[str] | None = None,
        cli_session: HelloCliSession | None = None,
    ) -> None:
        """The SDK-version handshake: at most once, before any native/turn event. No capabilities key when empty."""
        self._write(
            WorkerHelloEvent(
                framework=framework,
                sdk_name=sdk_name,
                sdk_version=sdk_version,
                capabilities=tuple(capabilities) if capabilities is not None and len(capabilities) > 0 else None,
                cli_session=cli_session,
            )
        )


def create_emitter(out: WriteSink) -> Emitter:
    return Emitter(out)


type SuspendWriteResult = Literal["written", "over_cap"]
"""``written``: the event is on the sink. ``over_cap``: the envelope is too large, and nothing was written."""


@dataclass(frozen=True, slots=True)
class SuspendWriter:
    """The one way a worker sends a ``suspend`` event; exists only for an invoke that offered one."""

    out: WriteSink
    max_envelope_bytes: int
    """The effective cap: the smaller of the offer's ``maxEnvelopeBytes`` and :data:`SUSPEND_ENVELOPE_MAX_BYTES`."""

    def suspend(self, envelope: str, ask_ids: Sequence[str]) -> SuspendWriteResult:
        """Write one ``suspend`` event unless the envelope's JSON-string form, in UTF-8 bytes, is over the cap."""
        if len(js_json_stringify(envelope).encode("utf-8")) > self.max_envelope_bytes:
            return "over_cap"
        self.out.write(_line(SuspendEvent(envelope=envelope, ask_ids=tuple(ask_ids))))
        return "written"


def create_suspend_writer(out: WriteSink, invoke: Invoke) -> SuspendWriter | None:
    """A writer for this invoke, or ``None`` when it carried no ``suspend`` offer: the whole gate toward an older
    Router, which fails the turn on a ``suspend`` it did not offer."""
    offer = invoke.suspend
    if offer is None:
        return None
    return SuspendWriter(out=out, max_envelope_bytes=min(offer.max_envelope_bytes, SUSPEND_ENVELOPE_MAX_BYTES))


class Turn:
    """The turn handed to a worker handler: the pushed context plus :meth:`text` to stream."""

    __slots__ = ("_emit", "_on_text", "fs", "history", "identity", "input")

    def __init__(
        self,
        input: str,
        identity: Identity,
        fs: Fs,
        history: tuple[HistoryMessage, ...],
        emit: Emitter,
        on_text: Callable[[str], None],
    ) -> None:
        self.input = input
        self.identity = identity
        self.fs = fs
        self.history = history
        self._emit = emit
        self._on_text = on_text

    def text(self, chunk: str) -> None:
        """Stream a chunk of assistant output (also accumulated into ``done.result``)."""
        self._on_text(chunk)
        self._emit.text(chunk)


type WorkerHandler = Callable[[Turn], Awaitable[str | None] | str | None]
"""A worker handler: do the work, return the final result string (or rely on the accumulated ``turn.text``)."""
