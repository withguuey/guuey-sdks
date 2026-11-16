"""The NDJSON line reader for the control stream (fd 0): a port of ``@guuey/worker``'s ``lines.ts`` (and of
``@guuey/host``'s identical ``stdin-lines.ts``, which the golden corpus runs).

Bytes are decoded as ONE UTF-8 stream, so a character split across two chunks arrives whole; invalid bytes become
U+FFFD. Lines split on ``\\n`` only, are trimmed with JavaScript's ``trim`` (not ``str.strip``), and blank lines are
skipped. A last line without a newline is still yielded.
"""

import codecs
import os
from collections.abc import AsyncIterable, AsyncIterator, Iterable, Iterator
from typing import Final

from guuey_host.protocol_json import js_trim

_READ_SIZE: Final = 65536


class _LineSplitter:
    """The reader's state: one incremental UTF-8 decoder and the text not yet ended by a newline."""

    __slots__ = ("_buffer", "_decoder")

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._buffer = ""

    def _drain(self) -> list[str]:
        out: list[str] = []
        newline = self._buffer.find("\n")
        while newline != -1:
            line = js_trim(self._buffer[:newline])
            self._buffer = self._buffer[newline + 1 :]
            if len(line) > 0:
                out.append(line)
            newline = self._buffer.find("\n")
        return out

    def feed(self, chunk: bytes | str) -> list[str]:
        # A str chunk is appended as is, past the decoder, exactly as the JavaScript reader does.
        self._buffer += chunk if isinstance(chunk, str) else self._decoder.decode(chunk)
        return self._drain()

    def end(self) -> list[str]:
        self._buffer += self._decoder.decode(b"", final=True)
        tail = js_trim(self._buffer)
        self._buffer = ""
        return [tail] if len(tail) > 0 else []


def lines(chunks: Iterable[bytes | str]) -> Iterator[str]:
    """Iterate NDJSON lines off a sequence of chunks."""
    splitter = _LineSplitter()
    for chunk in chunks:
        yield from splitter.feed(chunk)
    yield from splitter.end()


async def alines(chunks: AsyncIterable[bytes | str]) -> AsyncIterator[str]:
    """Async-iterate NDJSON lines off an async sequence of chunks."""
    splitter = _LineSplitter()
    async for chunk in chunks:
        for line in splitter.feed(chunk):
            yield line
    for line in splitter.end():
        yield line


def fd_chunks(fd: int) -> Iterator[bytes]:
    """The bytes of a descriptor as they arrive (``os.read``, so a line is yielded without waiting for a full buffer),
    until EOF."""
    while True:
        chunk = os.read(fd, _READ_SIZE)
        if chunk == b"":
            return
        yield chunk
